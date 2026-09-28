// Options page logic. Reads/writes config and overrides directly (this is an
// extension page with the same permissions), and messages the service worker
// for backfill, reconcile, and status so work continues after the page closes.
// Folder-policy edits are held in a draft until "Apply folder policies" so a
// parent change cannot surprise-apply to children mid-edit.
// The Folder policies list is a collapsible disclosure tree, not an ARIA tree:
// each parent twist is a button with aria-expanded. Depth-0 roots start open;
// deeper parents start closed (session expand state in treeExpandedIds).
// Top tabs (Status / Settings / Manual Sync / Folder policies) show one panel at a time.

import {
  ALL_POLICIES,
  MSG,
  POLICY,
  SYNC_MODE,
  RAINDROP_FOLDER_MODE,
  DEFAULT_RECONCILE_INTERVAL_MINUTES,
} from "../lib/constants.js";
import {
  getConfig,
  setConfig,
  getOverrides,
  setOverrides,
  getRaindropFolderAllowlist,
  setRaindropFolderAllowlist,
  isRateLimited,
  formatReconcileSkipNotice,
} from "../lib/store.js";
import { formatLastThrottleNotice } from "../lib/wake-budget.js";
import { countArchiveEntries, exportArchiveEntries, clearArchive } from "../lib/log-archive.js";
import { getTree, mirrorPathExists, getTopRoots } from "../lib/bookmarks.js";
import {
  buildCollectionIndex,
  findRootCollection,
  collectionsForAllowlistPicker,
  getById,
  getByParent,
} from "../lib/collections.js";
import { isCollectionAllowed, pruneAllowlist } from "../lib/allowlist.js";
import { RaindropClient, RateLimitError } from "../lib/raindrop.js";
import { runPullNow } from "../lib/pull-now.js";
import {
  assessImportBulkCandidate,
  assessPullBulkCandidate,
  formatBulkCandidatePrompt,
} from "../lib/bulk-candidate.js";
import { formatBulkQueueNotice, BULK_PROMPT_NEEDS_CHOICE } from "../lib/queue-bulk-prompt.js";
import { formatPendingByDirection } from "../lib/queue.js";

const $ = (id) => document.getElementById(id);

const TAB_IDS = ["status", "settings", "sync", "folders"];

/**
 * Show one options tab panel and update tablist ARIA/keyboard state.
 * @param {string} tabId One of TAB_IDS
 */
function showTab(tabId) {
  const id = TAB_IDS.includes(tabId) ? tabId : "status";
  for (const t of TAB_IDS) {
    const tab = document.querySelector(`.tabs [data-tab="${t}"]`);
    const panel = document.querySelector(`[data-panel="${t}"]`);
    const on = t === id;
    if (tab) {
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    }
    if (panel) {
      panel.classList.toggle("hidden", !on);
      panel.hidden = !on;
    }
  }
  try {
    const url = new URL(location.href);
    url.hash = id === "status" ? "" : id;
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

function initTabs() {
  const tablist = document.querySelector(".tabs");
  if (!tablist) return;

  tablist.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (!tab || !tablist.contains(tab)) return;
    showTab(tab.dataset.tab);
  });

  tablist.addEventListener("keydown", (event) => {
    const tabs = [...tablist.querySelectorAll("[data-tab]")];
    const current = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    if (current < 0) return;
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    tabs[next].focus();
    showTab(tabs[next].dataset.tab);
  });

  const hash = (location.hash || "").replace(/^#/, "");
  showTab(TAB_IDS.includes(hash) ? hash : "status");
}

// Folder-policy labels. "Offload" is sync-and-delete: useful as a per-folder
// exception under bidirectional, not as the bidirectional global default.
const POLICY_LABELS = {
  [POLICY.SYNC_DELETE]: "Offload (delete locally)",
  [POLICY.SYNC_KEEP]: "Keep locally",
  [POLICY.EXCLUDE]: "Exclude",
};

/** In-memory draft of folder overrides; only written on Save. */
let draftOverrides = {};
/** Last persisted snapshot, used for dirty checks and Discard. */
let savedOverrides = {};
/** Draft Raindrop-only allowlist { [id]: { path } }. */
let draftAllowlist = {};
let savedAllowlist = {};
/** Last fetched Raindrop-only rows for the expandable list. */
let raindropOnlyRows = [];
let policiesStatusTimer = null;
/** One-way "After upload" choice restored when leaving bidirectional. */
let oneWayPolicyMemory = POLICY.SYNC_DELETE;

/* ---- settings ---- */

/**
 * Bidirectional implies keep-both globally. One-way shows the after-upload
 * policy control. Folder overrides may still offload or exclude subtrees.
 * Raindrop→Edge folders select is bidirectional-only.
 *
 * aria-describedby names only the visible help. A hidden node still counts
 * if it is referenced, so do not point at both mode paragraphs at once.
 */
function updateSyncModeUi(mode) {
  const bi = mode === SYNC_MODE.BIDIRECTIONAL;
  $("oneWayModeHelp").classList.toggle("hidden", bi);
  $("bidirectionalModeHelp").classList.toggle("hidden", !bi);
  $("bidirectionalWarn").classList.toggle("hidden", !bi);
  $("oneWayPolicyBlock").classList.toggle("hidden", bi);
  $("bidirectionalPolicyBlock").classList.toggle("hidden", !bi);
  $("pullAction").classList.toggle("hidden", !bi);
  $("syncMode").setAttribute("aria-describedby", bi ? "bidirectionalModeHelp" : "oneWayModeHelp");

  if (bi) {
    $("defaultPolicy").value = POLICY.SYNC_KEEP;
    updateFolderModeHelp($("raindropFolderMode").value);
    $("raindropOnlySection").classList.remove("hidden");
  } else {
    $("defaultPolicy").value = oneWayPolicyMemory;
    $("raindropOnlySection").classList.add("hidden");
  }
}

function updateFolderModeHelp(mode) {
  const m = mode || RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED;
  $("folderModeHelpExisting").classList.toggle("hidden", m !== RAINDROP_FOLDER_MODE.EXISTING_ONLY);
  $("folderModeHelpCreate").classList.toggle("hidden", m !== RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED);
  $("folderModeHelpMirror").classList.toggle("hidden", m !== RAINDROP_FOLDER_MODE.MIRROR_ALL);
  const helpId =
    m === RAINDROP_FOLDER_MODE.EXISTING_ONLY
      ? "folderModeHelpExisting"
      : m === RAINDROP_FOLDER_MODE.MIRROR_ALL
        ? "folderModeHelpMirror"
        : "folderModeHelpCreate";
  $("raindropFolderMode").setAttribute("aria-describedby", helpId);
}

function effectiveDefaultPolicy(syncMode) {
  if (syncMode === SYNC_MODE.BIDIRECTIONAL) return POLICY.SYNC_KEEP;
  return $("defaultPolicy").value;
}

async function loadSettings() {
  const config = await getConfig();
  $("token").value = config.token || "";
  $("rootName").value = config.rootName || "";
  $("syncMode").value = config.syncMode || SYNC_MODE.ONE_WAY;
  $("defaultPolicy").value = config.defaultPolicy;
  $("pruneEmpty").checked = !!config.pruneEmpty;
  $("keepLongTermLog").checked = !!config.keepLongTermLog;
  $("raindropFolderMode").value =
    config.raindropFolderMode || RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED;
  $("reconcileIntervalMinutes").value = String(
    config.reconcileIntervalMinutes ?? DEFAULT_RECONCILE_INTERVAL_MINUTES
  );

  const mode = $("syncMode").value;
  if (mode === SYNC_MODE.ONE_WAY) {
    oneWayPolicyMemory = config.defaultPolicy || POLICY.SYNC_DELETE;
  } else if (config.defaultPolicy && config.defaultPolicy !== POLICY.SYNC_KEEP) {
    // Stale global offload under bidirectional: remember it for one-way return,
    // but UI/save will coerce global default to keep.
    oneWayPolicyMemory = config.defaultPolicy;
  } else {
    oneWayPolicyMemory = POLICY.SYNC_DELETE;
  }
  updateSyncModeUi(mode);
}

async function saveSettings() {
  const previous = await getConfig();
  const syncMode = $("syncMode").value;
  const defaultPolicy = effectiveDefaultPolicy(syncMode);
  if (syncMode === SYNC_MODE.ONE_WAY) {
    oneWayPolicyMemory = defaultPolicy;
  }
  await setConfig({
    token: $("token").value.trim(),
    rootName: $("rootName").value.trim() || "Bookmarks",
    syncMode,
    defaultPolicy,
    pruneEmpty: $("pruneEmpty").checked,
    keepLongTermLog: $("keepLongTermLog").checked,
    raindropFolderMode: $("raindropFolderMode").value || RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    reconcileIntervalMinutes:
      Number($("reconcileIntervalMinutes").value) || DEFAULT_RECONCILE_INTERVAL_MINUTES,
  });
  updateSyncModeUi(syncMode);
  if (syncMode === SYNC_MODE.BIDIRECTIONAL) {
    refreshRaindropOnlyList().catch(() => {});
  }
  $("saveStatus").textContent = "Saved.";
  setTimeout(() => ($("saveStatus").textContent = ""), 1500);
  refreshArchiveMeta();

  // First switch into bidirectional: kick an immediate reconcile.
  if (syncMode === SYNC_MODE.BIDIRECTIONAL && previous.syncMode !== SYNC_MODE.BIDIRECTIONAL) {
    runReconcile("Starting the first pull from Raindrop…");
  }
}

async function testToken() {
  const token = $("token").value.trim();
  const out = $("tokenStatus");
  if (!token) {
    out.textContent = "Enter a token first.";
    return;
  }
  out.textContent = "Checking…";
  try {
    const user = await new RaindropClient(token).getUser();
    out.textContent = `OK — ${user.fullName || user.email || "authenticated"}.`;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
}

/* ---- status + log ---- */

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

async function refreshStatus() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
  } catch {
    return;
  }
  if (!resp?.ok) return;

  $("pending").textContent = resp.pending ?? 0;
  const dirs = resp.pendingByDirection;
  const dirEl = $("pendingByDirection");
  if (dirs && (resp.pending ?? 0) > 0) {
    dirEl.textContent = ` (${formatPendingByDirection(dirs)})`;
  } else {
    dirEl.textContent = "";
  }
  const deadCount = resp.deadLetter ?? 0;
  $("deadLetter").textContent = String(deadCount);
  const dlRow = $("deadLetterRow");
  if (deadCount > 0) dlRow.classList.remove("hidden");
  else dlRow.classList.add("hidden");

  const storage = resp.storage;
  if (storage && typeof storage.bytesInUse === "number") {
    const used = formatBytes(storage.bytesInUse);
    const quota = formatBytes(storage.quotaBytes);
    const pct =
      storage.quotaBytes > 0
        ? Math.min(100, Math.round((100 * storage.bytesInUse) / storage.quotaBytes))
        : 0;
    $("storageUsage").textContent = `${used} / ${quota} (${pct}%)`;
  } else {
    $("storageUsage").textContent = "—";
  }

  const last = resp.status?.lastActivityAt;
  $("lastActivity").textContent = last ? new Date(last).toLocaleString() : "—";

  const pushAt = resp.status?.lastPushAt;
  $("lastPush").textContent = pushAt ? new Date(pushAt).toLocaleString() : "—";

  const rec = resp.reconcile?.lastRunAt;
  $("lastReconcile").textContent = rec ? new Date(rec).toLocaleString() : "—";
  if (resp.reconcile?.lastError) {
    $("lastReconcile").textContent += ` (error: ${resp.reconcile.lastError})`;
  }

  const skipLine = $("reconcileSkipLine");
  // Guard: don't show bulk_pause after Continue/Match already cleared needs_choice.
  const skipStatus =
    resp.status?.reconcileSkipReason === "bulk_pause" &&
    resp.bulkPrompt?.status !== BULK_PROMPT_NEEDS_CHOICE
      ? { ...resp.status, reconcileSkipReason: null }
      : resp.status;
  const skipText = formatReconcileSkipNotice(skipStatus, resp.pending);
  if (skipText) {
    skipLine.textContent = skipText;
    skipLine.classList.remove("hidden");
  } else {
    skipLine.textContent = "";
    skipLine.classList.add("hidden");
  }

  const throttleLine = $("wakeThrottleLine");
  const throttleText = formatLastThrottleNotice(resp.status);
  if (throttleText) {
    throttleLine.textContent = throttleText;
    throttleLine.classList.remove("hidden");
  } else {
    throttleLine.textContent = "";
    throttleLine.classList.add("hidden");
  }

  const banner = $("haltBanner");
  const rateUntil = resp.status?.rateLimitedUntil;
  if (rateUntil && rateUntil > Date.now()) {
    banner.classList.remove("hidden");
    banner.textContent = `Paused for Raindrop API rate limits until ${new Date(rateUntil).toLocaleTimeString()}. Sync resumes automatically.`;
  } else if (resp.status?.lastError?.startsWith("Storage write failed")) {
    banner.classList.remove("hidden");
    banner.textContent = resp.status.lastError;
  } else if (resp.status?.deletionsHalted && resp.status?.lastError) {
    banner.classList.remove("hidden");
    banner.textContent = `Deletions halted: ${resp.status.lastError}. Jobs are kept and will retry once resolved.`;
  } else {
    banner.textContent = "";
    banner.classList.add("hidden");
  }

  renderBulkQueueBanner(resp);

  const log = $("log");
  log.innerHTML = "";
  for (const entry of resp.log ?? []) {
    const li = document.createElement("li");
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = new Date(entry.at).toLocaleTimeString();
    const msg = document.createElement("span");
    msg.className = `msg lvl-${entry.level}`;
    msg.textContent = entry.message;
    li.append(ts, msg);
    const repeats = Array.isArray(entry.ats) ? entry.ats.length : 0;
    if (repeats > 1) {
      const n = document.createElement("span");
      n.className = "repeat";
      n.textContent = `×${repeats}`;
      n.title = `Repeated ${repeats} times`;
      li.append(n);
    }
    log.append(li);
  }

  refreshArchiveMeta();
}

/**
 * Queue-depth bulk prompt on Status (external HTML import / large backlog).
 * @param {{ pending?: number, bulkPrompt?: { status?: string }, bulkNotice?: string }} resp
 */
function renderBulkQueueBanner(resp) {
  const el = $("bulkQueueBanner");
  const text = $("bulkQueueBannerText");
  if (!el || !text) return;
  const needs = resp.bulkPrompt?.status === BULK_PROMPT_NEEDS_CHOICE;
  if (!needs) {
    el.classList.add("hidden");
    return;
  }
  text.textContent = resp.bulkNotice || formatBulkQueueNotice(resp.pending ?? 0);
  el.classList.remove("hidden");
}

async function continueBulkDripFromStatus() {
  const out = $("bulkQueueStatus");
  out.textContent = "Resuming drip…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.CONTINUE_BULK_DRIP });
    out.textContent = resp?.ok ? "Continuing drip (prompt snoozed until the queue shrinks)." : `Failed: ${resp?.error}`;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
  refreshStatus();
}

async function matchFromBulkQueueBanner() {
  const out = $("bulkQueueStatus");
  const result = await runMatchExistingFlow({ statusEl: out, offerDryRun: true });
  // Apply path snoozes in the SW; zero-pair / cancelled-without-apply need Continue semantics for "nothing".
  if (result === "nothing") {
    try {
      await chrome.runtime.sendMessage({ type: MSG.CONTINUE_BULK_DRIP });
      out.textContent = `${out.textContent} Drain resumed (nothing new to pair).`;
    } catch {
      /* refreshStatus will show banner state */
    }
  } else if (result === "applied") {
    out.textContent = `${out.textContent} Drain resumed.`;
  }
  refreshStatus();
}

async function refreshArchiveMeta() {
  const hint = $("archiveHint");
  const countEl = $("archiveCount");
  try {
    const config = await getConfig();
    const count = await countArchiveEntries();
    countEl.textContent = String(count);
    hint.textContent = config.keepLongTermLog
      ? " · recording new lines"
      : " · not recording (enable under Settings and Save)";
  } catch {
    countEl.textContent = "—";
    hint.textContent = " · archive unavailable";
  }
}

async function exportArchive() {
  const out = $("archiveStatus");
  out.textContent = "Exporting…";
  try {
    const entries = await exportArchiveEntries();
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `ers-activity-log-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    out.textContent = `Exported ${entries.length} entries.`;
  } catch (err) {
    out.textContent = `Export failed: ${err.message}`;
  }
  setTimeout(() => {
    if ($("archiveStatus").textContent.startsWith("Exported")) $("archiveStatus").textContent = "";
  }, 2500);
}

async function clearArchiveConfirmed() {
  const ok = window.confirm(
    "Clear the long-term activity archive? This cannot be undone. The recent activity list is not affected."
  );
  if (!ok) return;
  const out = $("archiveStatus");
  out.textContent = "Clearing…";
  try {
    await clearArchive();
    out.textContent = "Archive cleared.";
    await refreshArchiveMeta();
  } catch (err) {
    out.textContent = `Clear failed: ${err.message}`;
  }
  setTimeout(() => {
    if ($("archiveStatus").textContent === "Archive cleared.") $("archiveStatus").textContent = "";
  }, 2500);
}

/**
 * @param {import('../lib/bulk-candidate.js').BulkCandidateAssessment} assessment
 * @param {string} opLabel
 * @param {'import' | 'pull'} op
 * @returns {'match' | 'continue' | 'cancel'}
 */
function promptBulkGate(assessment, opLabel, op) {
  const body = formatBulkCandidatePrompt(assessment, op);
  const matchFirst = window.confirm(
    `${opLabel}\n\n${body}\n\n` +
      "OK = Match from export first (recommended)\n" +
      "Cancel = other options"
  );
  if (matchFirst) return "match";
  const cont = window.confirm(
    `Continue ${opLabel} without matching?\n\n` +
      "OK = continue without Match\n" +
      "Cancel = abort"
  );
  return cont ? "continue" : "cancel";
}

function formatMatchPlanSummary(plan) {
  const would = plan.matched?.length ?? 0;
  return (
    `Would pair ${would}; already paired ${plan.alreadyPaired}; ` +
    `ambiguous ${plan.ambiguous}; conflicts ${plan.conflicts}; ` +
    `Edge-only ${plan.edgeOnly}; Raindrop-only ${plan.raindropOnly} ` +
    `(export ${plan.raindropCount}, Edge ${plan.edgeScanned}).`
  );
}

/**
 * Run Match existing. Guided flows may skip the dry-run confirm.
 * @param {{ statusEl: HTMLElement, offerDryRun: boolean }} opts
 * @returns {Promise<'applied' | 'nothing' | 'cancelled' | 'failed' | 'rate_limited'>}
 */
async function runMatchExistingFlow({ statusEl, offerDryRun }) {
  statusEl.textContent = "Downloading Raindrop export + matching (may take a minute)…";
  try {
    const plan = await chrome.runtime.sendMessage({ type: MSG.MATCH_EXISTING_PLAN });
    if (plan?.reason === "rate_limited") {
      statusEl.textContent = "Paused for Raindrop rate limits — wait a minute, then try again.";
      return "rate_limited";
    }
    if (!plan?.ok) {
      statusEl.textContent = `Match failed: ${plan?.error ?? "unknown error"}`;
      return "failed";
    }
    const summary = formatMatchPlanSummary(plan);
    statusEl.textContent = summary;
    const would = plan.matched?.length ?? 0;
    if (would === 0) {
      return "nothing";
    }

    let apply = true;
    if (offerDryRun) {
      const wantDry = window.confirm(
        `Show dry-run counts before recording ${would} pair(s)?\n\n` +
          "OK = review counts, then confirm Apply\n" +
          "Cancel = record pairs now (pairs only; no deletes/moves)"
      );
      if (wantDry) {
        apply = window.confirm(
          `Match existing — record ${would} pair(s)?\n\n${summary}\n\n` +
            "This only updates the pair map. It does not upload, pull, move, or delete bookmarks."
        );
      }
    } else {
      // Power-user button: always dry-run summary then confirm.
      apply = window.confirm(
        `Match existing — record ${would} pair(s)?\n\n${summary}\n\n` +
          "This only updates the pair map. It does not upload, pull, move, or delete bookmarks."
      );
    }
    if (!apply) {
      statusEl.textContent = `${summary} (apply cancelled)`;
      return "cancelled";
    }

    statusEl.textContent = `Recording ${would} pair(s)…`;
    const resp = await chrome.runtime.sendMessage({
      type: MSG.MATCH_EXISTING_APPLY,
      matched: plan.matched,
    });
    if (!resp?.ok) {
      statusEl.textContent = `Apply failed: ${resp?.error ?? "unknown error"}`;
      return "failed";
    }
    statusEl.textContent = `Recorded ${resp.paired} pair(s). ${summary}`;
    return "applied";
  } catch (err) {
    statusEl.textContent = `Match failed: ${err.message}`;
    return "failed";
  }
}

async function runBackfillCore() {
  const out = $("importStatus");
  out.textContent = "Queuing browser bookmarks…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.RUN_BACKFILL });
    out.textContent = resp?.ok
      ? `Queued ${resp.queued} of ${resp.scanned} scanned.`
      : `Failed: ${resp?.error}`;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
  refreshStatus();
}

/**
 * Shared Import/Pull bulk gate: assess → ask → optional Match → proceed or abort.
 * Queue-depth Status banner uses a separate path (matchFromBulkQueueBanner).
 * @param {{
 *   assess: () => Promise<import('../lib/bulk-candidate.js').BulkCandidateAssessment>,
 *   opLabel: string,
 *   op: 'import' | 'pull',
 *   statusEl: HTMLElement,
 * }} opts
 * @returns {Promise<boolean>} true if the live op should continue
 */
async function withBulkMatchGate({ assess, opLabel, op, statusEl }) {
  const short = op === "import" ? "Import" : "Pull";
  statusEl.textContent = "Checking library size…";
  const assessment = await assess();
  if (!assessment.suggest) return true;
  const choice = promptBulkGate(assessment, opLabel, op);
  if (choice === "cancel") {
    statusEl.textContent = `${short} cancelled.`;
    return false;
  }
  if (choice === "match") {
    const result = await runMatchExistingFlow({
      statusEl: $("matchExistingStatus"),
      offerDryRun: true,
    });
    if (result === "cancelled" || result === "failed" || result === "rate_limited") {
      statusEl.textContent = `${short} not started (Match did not finish).`;
      refreshStatus();
      return false;
    }
    // applied | nothing → continue live op
  }
  return true;
}

async function runBackfill() {
  const proceed = await withBulkMatchGate({
    assess: assessImportBulkCandidate,
    opLabel: "Import to Raindrop",
    op: "import",
    statusEl: $("importStatus"),
  });
  if (!proceed) return;
  await runBackfillCore();
}

async function runReconcileCore(pendingMsg) {
  const out = $("pullStatus");
  out.textContent = pendingMsg || "Pulling from Raindrop…";
  try {
    const { text } = await runPullNow((msg) => chrome.runtime.sendMessage(msg), {
      pendingMsg,
      onProgress: async (text) => {
        out.textContent = text;
        await refreshStatus();
      },
    });
    out.textContent = text;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
  refreshStatus();
}

async function runReconcile(pendingMsg) {
  // First-pull auto path may pass pendingMsg — still allow bulk gate.
  const proceed = await withBulkMatchGate({
    assess: assessPullBulkCandidate,
    opLabel: "Pull from Raindrop",
    op: "pull",
    statusEl: $("pullStatus"),
  });
  if (!proceed) return;
  await runReconcileCore(pendingMsg);
}

async function runMatchExistingUi() {
  await runMatchExistingFlow({ statusEl: $("matchExistingStatus"), offerDryRun: false });
  refreshStatus();
}

/* ---- folder policy editor (draft until Apply) ---- */

/** Deep-clone a plain object map (folder overrides, allowlist, …). */
function cloneMap(map) {
  return structuredClone(map ?? {});
}

/**
 * Sorted-key deep equality for draft vs saved maps.
 * @param {Record<string, unknown>|null|undefined} a
 * @param {Record<string, unknown>|null|undefined} b
 * @param {(left: unknown, right: unknown) => boolean} valuesEqual
 */
function mapsEqual(a, b, valuesEqual) {
  const keysA = Object.keys(a || {}).sort();
  const keysB = Object.keys(b || {}).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!valuesEqual(a[keysA[i]], b[keysB[i]])) return false;
  }
  return true;
}

function cloneOverrides(overrides) {
  return cloneMap(overrides);
}

function cloneAllowlist(allowlist) {
  return cloneMap(allowlist);
}

function overridesEqual(a, b) {
  return mapsEqual(
    a,
    b,
    (left, right) => left?.policy === right?.policy && left?.path === right?.path
  );
}

function allowlistsEqual(a, b) {
  return mapsEqual(a, b, (left, right) => (left?.path || "") === (right?.path || ""));
}

function policiesDirty() {
  return (
    !overridesEqual(draftOverrides, savedOverrides) ||
    !allowlistsEqual(draftAllowlist, savedAllowlist)
  );
}

function allRaindropOnlySelected() {
  if (!raindropOnlyRows.length) return true;
  const index = raindropOnlyRows._index;
  const rootId = raindropOnlyRows._rootId;
  return raindropOnlyRows.every(
    (row) =>
      !!draftAllowlist[row.id] ||
      (index && rootId != null && isCollectionAllowed(row.id, index, rootId, draftAllowlist))
  );
}

function updatePoliciesUi(statusText) {
  const dirty = policiesDirty();
  $("applyPolicies").disabled = !dirty;
  $("discardPolicies").disabled = !dirty;
  $("selectAllRaindropOnly").disabled = raindropOnlyRows.length === 0 || allRaindropOnlySelected();
  $("clearRaindropOnly").disabled = Object.keys(draftAllowlist).length === 0;
  $("draftBar").classList.toggle("is-dirty", dirty);
  if (statusText !== undefined) {
    $("policiesStatus").textContent = statusText;
    return;
  }
  $("policiesStatus").textContent = dirty ? "Unsaved changes" : "No unsaved changes";
}

function flashPoliciesStatus(text) {
  if (policiesStatusTimer) clearTimeout(policiesStatusTimer);
  updatePoliciesUi(text);
  policiesStatusTimer = setTimeout(() => {
    policiesStatusTimer = null;
    updatePoliciesUi();
  }, 1500);
}

function applyDraftChange(folderId, policy, path) {
  if (policy === "inherit") {
    delete draftOverrides[folderId];
  } else {
    draftOverrides[folderId] = { policy, path };
  }
  updatePoliciesUi();
}

function setAllowlistChecked(collectionId, path, checked) {
  const id = String(collectionId);
  if (checked) {
    draftAllowlist[id] = { path };
  } else {
    delete draftAllowlist[id];
  }
  paintRaindropOnlyList();
}

/** Check every listed Raindrop-only collection in the draft allowlist. */
function selectAllRaindropOnlySelection() {
  if (!raindropOnlyRows.length || allRaindropOnlySelected()) return;
  for (const row of raindropOnlyRows) {
    draftAllowlist[row.id] = { path: row.path };
  }
  paintRaindropOnlyList();
}

/** Clear draft Raindrop-only allowlist (Apply folder policies to persist). */
function clearRaindropOnlySelection() {
  if (Object.keys(draftAllowlist).length === 0) return;
  draftAllowlist = {};
  paintRaindropOnlyList();
}

/** Last Edge bookmark tree used to paint Folder policies (for discard re-paint). */
let cachedFolderTree = null;
/**
 * Expanded folder ids for the Edge policy tree.
 * `null` means apply the default rule: depth-0 roots open, deeper parents closed.
 * @type {Set<string>|null}
 */
let treeExpandedIds = null;
/** Folder-count under the last painted tree (folders only). */
let treeFolderTotal = 0;

/**
 * Direct child folders of a bookmark node (skips URL bookmarks).
 * @param {{ children?: Array<{ url?: string }> }} node
 */
function folderChildren(node) {
  return (node.children ?? []).filter((c) => !c.url);
}

/**
 * Count of folder nodes beneath `node` (not including `node` itself).
 * @param {{ children?: Array<{ url?: string, children?: unknown[] }> }} node
 */
function countDescendantFolders(node) {
  let n = 0;
  for (const child of folderChildren(node)) {
    n += 1 + countDescendantFolders(child);
  }
  return n;
}

/** Default open state: only top-level Edge roots (Favorites bar / Other favorites). */
function defaultExpanded(depth) {
  return depth === 0;
}

/**
 * Whether a parent folder should be expanded given session state.
 * @param {string} folderId
 * @param {number} depth
 */
function isFolderExpanded(folderId, depth) {
  if (treeExpandedIds === null) return defaultExpanded(depth);
  return treeExpandedIds.has(String(folderId));
}

/** Ensure `treeExpandedIds` is a Set seeded from the current default/DOM rule. */
function ensureExpandedSet() {
  if (treeExpandedIds !== null) return;
  treeExpandedIds = new Set();
  document.querySelectorAll("#tree .tree-node").forEach((el) => {
    const twist = el.querySelector(":scope > .tree-row > .tree-twist");
    if (twist && twist.getAttribute("aria-expanded") === "true") {
      treeExpandedIds.add(el.dataset.id);
    }
  });
}

/**
 * Apply expanded/collapsed UI for one tree node.
 * @param {HTMLElement} nodeEl
 * @param {boolean} open
 */
function setNodeExpanded(nodeEl, open) {
  const twist = nodeEl.querySelector(":scope > .tree-row > .tree-twist");
  const childrenEl = nodeEl.querySelector(":scope > .tree-children");
  if (!twist || !childrenEl || twist.disabled) return;
  twist.setAttribute("aria-expanded", open ? "true" : "false");
  twist.textContent = open ? "▾" : "▸";
  childrenEl.hidden = !open;
}

function expandAllFolders() {
  ensureExpandedSet();
  document.querySelectorAll("#tree .tree-node").forEach((el) => {
    if (!el.querySelector(":scope > .tree-children")) return;
    treeExpandedIds.add(el.dataset.id);
    setNodeExpanded(el, true);
  });
  updateTreeMeta();
}

function collapseFoldersToDefault() {
  treeExpandedIds = new Set();
  document.querySelectorAll("#tree .tree-node").forEach((el) => {
    if (!el.querySelector(":scope > .tree-children")) return;
    const depth = Number(el.dataset.depth);
    const open = defaultExpanded(depth);
    if (open) treeExpandedIds.add(el.dataset.id);
    setNodeExpanded(el, open);
  });
  updateTreeMeta();
}

/**
 * Filter the painted tree by title/path. Empty query restores default expansion.
 * @param {string} query
 */
function applyTreeFilter(query) {
  const q = query.trim().toLowerCase();
  const nodes = [...document.querySelectorAll("#tree .tree-node")];

  if (!q) {
    nodes.forEach((n) => {
      n.hidden = false;
    });
    treeExpandedIds = null;
    nodes.forEach((n) => {
      if (!n.querySelector(":scope > .tree-children")) return;
      setNodeExpanded(n, defaultExpanded(Number(n.dataset.depth)));
    });
    updateTreeMeta();
    return;
  }

  ensureExpandedSet();
  const matches = new Set();
  for (const n of nodes) {
    const title = n.dataset.title || "";
    const path = n.dataset.path || "";
    if (title.includes(q) || path.includes(q)) {
      matches.add(n);
      let el = n.parentElement;
      while (el) {
        if (el.classList?.contains("tree-node")) matches.add(el);
        el = el.parentElement;
      }
    }
  }

  for (const n of nodes) {
    n.hidden = !matches.has(n);
    if (matches.has(n) && n.querySelector(":scope > .tree-children")) {
      treeExpandedIds.add(n.dataset.id);
      setNodeExpanded(n, true);
    }
  }
  updateTreeMeta();
}

function countVisibleTreeRows() {
  return [...document.querySelectorAll("#tree .tree-node")].filter((n) => {
    if (n.hidden) return false;
    let el = n.parentElement;
    while (el && el.id !== "tree") {
      if (el.classList?.contains("tree-children") && el.hidden) return false;
      if (el.classList?.contains("tree-node") && el.hidden) return false;
      el = el.parentElement;
    }
    return true;
  }).length;
}

function updateTreeMeta() {
  const meta = $("treeMeta");
  if (!meta) return;
  if (treeFolderTotal === 0) {
    meta.textContent = "";
    return;
  }
  meta.textContent = `${countVisibleTreeRows()} shown · ${treeFolderTotal} folders`;
}

async function renderTree() {
  const [overrides, allowlist, tree] = await Promise.all([
    getOverrides(),
    getRaindropFolderAllowlist(),
    getTree(),
  ]);
  savedOverrides = cloneOverrides(overrides);
  draftOverrides = cloneOverrides(overrides);
  savedAllowlist = cloneAllowlist(allowlist);
  draftAllowlist = cloneAllowlist(allowlist);
  treeExpandedIds = null;
  paintTree(tree);
  updatePoliciesUi();
  const config = await getConfig();
  if (config.syncMode === SYNC_MODE.BIDIRECTIONAL) {
    refreshRaindropOnlyList().catch(() => {});
  }
}

function paintTree(tree) {
  const container = $("tree");
  container.innerHTML = "";
  cachedFolderTree = tree;

  const roots = [];
  for (const root of tree) {
    for (const child of folderChildren(root)) {
      roots.push(child);
    }
  }

  treeFolderTotal = 0;
  for (const folder of roots) {
    treeFolderTotal += 1 + countDescendantFolders(folder);
  }

  if (roots.length === 0) {
    container.textContent = "No folders found.";
    updateTreeMeta();
    return;
  }

  for (const folder of roots) {
    container.append(buildTreeNode(folder, 0, []));
  }

  const filter = $("treeFilter");
  if (filter?.value.trim()) {
    applyTreeFilter(filter.value);
  } else {
    updateTreeMeta();
  }
}

/**
 * Build one collapsible folder node (row + optional children).
 * Parent twists are disclosure buttons (aria-expanded + aria-controls), not
 * treeitems. An ARIA tree would need arrow-key navigation and the children
 * group owned by the item, which fights the policy select in each row.
 * @param {{ id: string, title?: string, children?: unknown[] }} folder
 * @param {number} depth
 * @param {string[]} pathSegments
 */
function buildTreeNode(folder, depth, pathSegments) {
  const path = [...pathSegments, folder.title || "(untitled)"];
  const kids = folderChildren(folder);
  const hasKids = kids.length > 0;
  const descendantCount = countDescendantFolders(folder);
  const pathText = path.join(" / ");

  const nodeEl = document.createElement("div");
  nodeEl.className = "tree-node";
  nodeEl.dataset.id = String(folder.id);
  nodeEl.dataset.depth = String(depth);
  nodeEl.dataset.title = (folder.title || "").toLowerCase();
  nodeEl.dataset.path = pathText.toLowerCase();

  const row = document.createElement("div");
  row.className = "tree-row";
  row.style.paddingLeft = `${10 + depth * 16}px`;
  const current = draftOverrides[folder.id]?.policy;
  if (current) row.classList.add("has-override");

  const twist = document.createElement("button");
  twist.type = "button";
  twist.className = "tree-twist";
  const titleLabel = folder.title || "(untitled)";
  const expanded = hasKids && isFolderExpanded(folder.id, depth);
  const childrenId = `tree-children-${folder.id}`;
  if (hasKids) {
    twist.tabIndex = 0;
    twist.setAttribute("aria-label", `Toggle ${titleLabel}`);
    twist.setAttribute("aria-expanded", expanded ? "true" : "false");
    twist.setAttribute("aria-controls", childrenId);
    twist.textContent = expanded ? "▾" : "▸";
  } else {
    // Spacer so leaf titles line up with parents. Not a control.
    twist.disabled = true;
    twist.tabIndex = -1;
    twist.setAttribute("aria-hidden", "true");
    twist.textContent = "·";
  }

  const name = document.createElement("div");
  name.className = "name";
  const titleRow = document.createElement("div");
  titleRow.className = "folder-title";
  const title = document.createElement("span");
  title.textContent = titleLabel;
  titleRow.append(title);

  if (hasKids && descendantCount > 0) {
    const chip = document.createElement("span");
    chip.className = "child-count";
    chip.textContent =
      descendantCount === kids.length
        ? String(kids.length)
        : `${kids.length} · ${descendantCount} nested`;
    chip.title = `${kids.length} direct · ${descendantCount} folders beneath`;
    titleRow.append(chip);
  }

  const sub = document.createElement("div");
  sub.className = "path";
  sub.textContent = pathText;
  name.append(titleRow, sub);

  const select = document.createElement("select");
  select.setAttribute("aria-label", `Policy for ${titleLabel}`);
  const inherit = new Option("Inherit", "inherit", !current, !current);
  select.append(inherit);
  for (const p of ALL_POLICIES) {
    select.append(new Option(POLICY_LABELS[p], p, current === p, current === p));
  }
  select.addEventListener("change", () => {
    applyDraftChange(folder.id, select.value, pathText);
    row.classList.toggle("has-override", select.value !== "inherit");
  });

  row.append(twist, name, select);
  nodeEl.append(row);

  if (hasKids) {
    const childrenEl = document.createElement("div");
    childrenEl.className = "tree-children";
    childrenEl.id = childrenId;
    if (!expanded) childrenEl.hidden = true;
    for (const child of kids) {
      childrenEl.append(buildTreeNode(child, depth + 1, path));
    }
    nodeEl.append(childrenEl);

    twist.addEventListener("click", () => {
      ensureExpandedSet();
      const open = twist.getAttribute("aria-expanded") !== "true";
      if (open) treeExpandedIds.add(String(folder.id));
      else treeExpandedIds.delete(String(folder.id));
      setNodeExpanded(nodeEl, open);
      updateTreeMeta();
    });
  }

  return nodeEl;
}

async function refreshRaindropOnlyList() {
  const status = $("raindropOnlyStatus");
  // Use the dropdown so the list loads before Settings are saved.
  if ($("syncMode").value !== SYNC_MODE.BIDIRECTIONAL) return;
  const config = await getConfig();
  // Prefer form values so an unsaved root/token rename still loads the right tree.
  const token = ($("token").value || "").trim() || config.token;
  const rootName = ($("rootName").value || "").trim() || config.rootName || "Bookmarks";
  if (!token) {
    status.textContent = "Add a Raindrop token in Settings to load collections.";
    raindropOnlyRows = [];
    paintRaindropOnlyList();
    return;
  }
  if (await isRateLimited()) {
    status.textContent = "Paused for Raindrop rate limits — try Refresh shortly.";
    return;
  }
  status.textContent = "Loading…";
  try {
    const client = new RaindropClient(token);
    const index = await buildCollectionIndex(client);
    const root = findRootCollection(index, rootName);
    const rootId = root?._id ?? null;
    const topRoots = await getTopRoots();
    const candidates = collectionsForAllowlistPicker(index, rootId);

    // Heal sticky selective mode: drop allowlist ids deleted from Raindrop.
    // Fully mirrored entries are kept until the user clears selection.
    const pathExists = (relative) => mirrorPathExists(relative, rootName, topRoots);
    const draftPruned = await pruneAllowlist(draftAllowlist, index, rootId, pathExists);
    const savedPruned = await pruneAllowlist(savedAllowlist, index, rootId, pathExists);
    let pruneNote = "";
    if (draftPruned.removed > 0) {
      draftAllowlist = draftPruned.allowlist;
    }
    if (savedPruned.removed > 0) {
      savedAllowlist = savedPruned.allowlist;
      await setRaindropFolderAllowlist(savedAllowlist);
      pruneNote = ` · cleared ${savedPruned.removed} missing`;
    }
    if (draftPruned.removed > 0 || savedPruned.removed > 0) {
      updatePoliciesUi();
    }

    const rows = [];
    if (!root) {
      status.textContent =
        `Root “${rootName}” not in Raindrop yet — save Settings / run a sync so the root exists before choosing Raindrop-only collections.` +
        pruneNote;
      raindropOnlyRows = [];
      paintRaindropOnlyList();
      return;
    }

    for (const { collectionId, relativeSegments, underSyncRoot } of candidates) {
      if (!relativeSegments.length) continue;
      const exists = await pathExists(relativeSegments);
      if (exists) continue;
      const path = relativeSegments.join(" / ");
      const col = getById(index, collectionId);
      const empty =
        col?.count != null ? Number(col.count) === 0 : !getByParent(index, collectionId)?.size;
      rows.push({
        id: String(collectionId),
        path,
        depth: Math.max(0, relativeSegments.length - 1),
        empty,
        underSyncRoot,
        title: col?.title || relativeSegments[relativeSegments.length - 1],
      });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    raindropOnlyRows = rows;
    raindropOnlyRows._index = index;
    raindropOnlyRows._rootId = rootId;

    const outside = rows.filter((r) => !r.underSyncRoot).length;
    if (rows.length) {
      status.textContent =
        `${rows.length} Raindrop-only collection(s)` +
        (outside ? ` (${outside} outside “${rootName}”)` : "") +
        pruneNote;
    } else {
      status.textContent =
        `None Raindrop-only — every Raindrop folder path already matches the browser.` + pruneNote;
    }
    paintRaindropOnlyList();
  } catch (err) {
    status.textContent =
      err instanceof RateLimitError
        ? "Raindrop rate limited — wait a minute, then Refresh."
        : `Failed: ${err.message}`;
    raindropOnlyRows = [];
    paintRaindropOnlyList();
  }
}

function paintRaindropOnlyList() {
  const container = $("raindropOnlyList");
  container.innerHTML = "";
  if (!raindropOnlyRows.length) {
    container.textContent = "";
    updatePoliciesUi();
    return;
  }
  const index = raindropOnlyRows._index;
  const rootId = raindropOnlyRows._rootId;
  for (const row of raindropOnlyRows) {
    const el = document.createElement("div");
    el.className = "rd-row";
    el.style.paddingLeft = `${Math.max(0, row.depth) * 16}px`;

    const coveredByParent =
      index &&
      rootId != null &&
      isCollectionAllowed(row.id, index, rootId, draftAllowlist) &&
      !draftAllowlist[row.id];

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!draftAllowlist[row.id] || coveredByParent;
    cb.disabled = coveredByParent;
    cb.addEventListener("change", () => {
      setAllowlistChecked(row.id, row.path, cb.checked);
    });

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.textContent = row.title;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = coveredByParent ? `${row.path} · included via parent` : row.path;
    meta.append(title, sub);
    label.append(cb, meta);

    const badge = document.createElement("span");
    badge.className = `rd-badge ${row.empty ? "empty" : "only"}`;
    badge.textContent = row.empty ? "empty" : "Raindrop only";

    el.append(label, badge);
    container.append(el);
  }
  updatePoliciesUi();
}

async function applyPolicies() {
  if (!policiesDirty()) return;
  await setOverrides(cloneOverrides(draftOverrides));
  await setRaindropFolderAllowlist(cloneAllowlist(draftAllowlist));
  savedOverrides = cloneOverrides(draftOverrides);
  savedAllowlist = cloneAllowlist(draftAllowlist);
  flashPoliciesStatus("Applied.");
}

async function discardPolicies() {
  if (!policiesDirty()) return;
  draftOverrides = cloneOverrides(savedOverrides);
  draftAllowlist = cloneAllowlist(savedAllowlist);
  const tree = cachedFolderTree ?? (await getTree());
  paintTree(tree);
  paintRaindropOnlyList();
}

/* ---- wire up ---- */

$("save").addEventListener("click", saveSettings);
$("testToken").addEventListener("click", testToken);
$("backfill").addEventListener("click", runBackfill);
$("reconcile").addEventListener("click", () => runReconcile());
$("matchExisting").addEventListener("click", () => void runMatchExistingUi());
$("bulkQueueMatch").addEventListener("click", () => void matchFromBulkQueueBanner());
$("bulkQueueContinue").addEventListener("click", () => void continueBulkDripFromStatus());
$("retryDeadLetter").addEventListener("click", async () => {
  const out = $("deadLetterStatus");
  out.textContent = "Retrying…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.RETRY_DEAD_LETTER });
    out.textContent = resp?.ok
      ? `Re-queued ${resp.retried ?? 0} job(s).`
      : `Failed: ${resp?.error || "unknown"}`;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
  refreshStatus();
});
$("clearDeadLetter").addEventListener("click", async () => {
  if (!confirm("Clear all dead-lettered jobs? They will not be retried.")) return;
  const out = $("deadLetterStatus");
  out.textContent = "Clearing…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.CLEAR_DEAD_LETTER });
    out.textContent = resp?.ok ? "Cleared." : `Failed: ${resp?.error || "unknown"}`;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
  refreshStatus();
});
$("exportArchive").addEventListener("click", exportArchive);
$("clearArchive").addEventListener("click", clearArchiveConfirmed);
$("syncMode").addEventListener("change", () => {
  const mode = $("syncMode").value;
  if (mode === SYNC_MODE.BIDIRECTIONAL) {
    oneWayPolicyMemory = $("defaultPolicy").value || oneWayPolicyMemory;
    refreshRaindropOnlyList().catch(() => {});
  }
  updateSyncModeUi(mode);
});
$("raindropFolderMode").addEventListener("change", () => {
  updateFolderModeHelp($("raindropFolderMode").value);
});
$("defaultPolicy").addEventListener("change", () => {
  if ($("syncMode").value === SYNC_MODE.ONE_WAY) {
    oneWayPolicyMemory = $("defaultPolicy").value;
  }
});
$("applyPolicies").addEventListener("click", applyPolicies);
$("discardPolicies").addEventListener("click", discardPolicies);
$("expandTree").addEventListener("click", () => {
  expandAllFolders();
});
$("collapseTree").addEventListener("click", () => {
  const filter = $("treeFilter");
  if (filter?.value.trim()) {
    collapseFoldersToDefault();
    applyTreeFilter(filter.value);
  } else {
    collapseFoldersToDefault();
  }
});
$("treeFilter").addEventListener("input", (event) => {
  applyTreeFilter(event.target.value);
});
$("refreshRaindropOnly").addEventListener("click", () => {
  refreshRaindropOnlyList();
});
$("selectAllRaindropOnly").addEventListener("click", selectAllRaindropOnlySelection);
$("clearRaindropOnly").addEventListener("click", clearRaindropOnlySelection);

window.addEventListener("beforeunload", (event) => {
  if (!policiesDirty()) return;
  event.preventDefault();
});

initTabs();
loadSettings();
renderTree();
refreshStatus();
setInterval(refreshStatus, 3000);
