// MV3 service worker — the always-on (but ephemeral) entry point.
//
// It does as little as possible: register listeners, enqueue on bookmark
// events, and run drain/reconcile on events and on a heartbeat alarm. All real
// work and all state live in the lib modules and chrome.storage.
//
// Async handlers await (or chain) their work so Chromium keeps the worker
// alive through fetch/storage. The heartbeat is (re)created on every SW
// evaluation, not only onInstalled/onStartup.

import { ALARM_NAME, HEARTBEAT_MINUTES, MSG } from "../lib/constants.js";
import {
  tick,
  drain,
  drainNow,
  reconcileNow,
  refreshReconcileSkipAfterBulkResume,
  handleBookmarkCreated,
  handleBookmarkRemoved,
  handleBookmarkMoved,
  handleBookmarkChanged,
} from "../lib/sync.js";
import { startBackfill } from "../lib/backfill.js";
import {
  runMatchExistingDryRun,
  applyMatchExisting,
  emptyPlan,
  RateLimitError,
} from "../lib/match-existing.js";
import { handleClientError } from "../lib/client-errors.js";
import * as queue from "../lib/queue.js";
import {
  getStatus,
  getLog,
  appendLog,
  getReconcileState,
  getConfig,
  ensurePairsMigrated,
  healStoredConfig,
  getStorageUsage,
} from "../lib/store.js";
import {
  noteQueueDepthForBulkPrompt,
  snoozeBulkPrompt,
  resolveBulkPromptAfterMatch,
  estimateDrainEtaMinutes,
  formatBulkQueueNotice,
} from "../lib/queue-bulk-prompt.js";

function ensureHeartbeat() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: HEARTBEAT_MINUTES });
}

function logSwError(context, err) {
  const message = err?.message || String(err);
  console.error(`[ers] ${context}:`, err);
  return appendLog("error", `${context}: ${message}`);
}

// Recreate the alarm whenever this worker starts — not only on install/startup.
// Heal stale bidirectional config here, not inside getConfig: a read that
// writes can race an Options save and put the old token back.
ensureHeartbeat();
void healStoredConfig();

chrome.runtime.onInstalled.addListener(() => {
  ensureHeartbeat();
  void ensurePairsMigrated();
  void healStoredConfig();
  void appendLog("info", "Extension installed; heartbeat scheduled.");
});

chrome.runtime.onStartup.addListener(() => {
  ensureHeartbeat();
  void ensurePairsMigrated();
  void healStoredConfig();
});

// Live capture: enqueue new bookmarks (URL nodes only) unless pull-suppressed.
chrome.bookmarks.onCreated.addListener((id, node) => {
  void handleBookmarkCreated(id, node).catch((err) => logSwError("onCreated", err));
});

// User deletes: propagate to Raindrop when bidirectional (unless policy-suppressed).
// Folder deletes: Chromium fires once; sync walks removeInfo.node for child URLs.
chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
  void handleBookmarkRemoved(id, removeInfo).catch((err) => logSwError("onRemoved", err));
});

// Parent-folder moves: enqueue upload so paired raindrops update collection
// placement (same-parent reorder is a no-op). Folder moves fan out to child URLs.
chrome.bookmarks.onMoved.addListener((id, moveInfo) => {
  void handleBookmarkMoved(id, moveInfo).catch((err) => logSwError("onMoved", err));
});

// Title/URL edits and folder renames: paired raindrops get Edge-owned field
// updates; mapped folders rename the Raindrop collection in place.
chrome.bookmarks.onChanged.addListener((id, changeInfo) => {
  void handleBookmarkChanged(id, changeInfo).catch((err) => logSwError("onChanged", err));
});

// Heartbeat: drain + bidirectional reconcile.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void tick().catch((err) => logSwError("heartbeat", err));
});

// Message API for the options page and popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case MSG.RUN_BACKFILL: {
          const result = await startBackfill();
          await drainNow();
          sendResponse({ ok: true, ...result });
          break;
        }
        case MSG.DRAIN_NOW: {
          await drainNow();
          sendResponse({ ok: true });
          break;
        }
        case MSG.RECONCILE_NOW: {
          // Goes through sync.reconcileNow so RateLimitError sets the global gate
          // (same path as heartbeat), not only a UI error string.
          const result = await reconcileNow();
          sendResponse({ ok: true, ...result });
          break;
        }
        case MSG.GET_STATUS: {
          const config = await getConfig();
          const pendingByDirection = await queue.sizeByDirection();
          const pending = pendingByDirection.total;
          const bulkPrompt = await noteQueueDepthForBulkPrompt(pending);
          sendResponse({
            ok: true,
            status: await getStatus(),
            pending,
            pendingByDirection,
            deadLetter: await queue.deadLetterSize(),
            storage: await getStorageUsage(),
            log: await getLog(),
            reconcile: await getReconcileState(),
            syncMode: config.syncMode,
            bulkPrompt,
            bulkEtaMinutes: estimateDrainEtaMinutes(pending),
            bulkNotice: formatBulkQueueNotice(pending),
          });
          break;
        }
        case MSG.GET_BULK_PROMPT: {
          const pending = await queue.size();
          const bulkPrompt = await noteQueueDepthForBulkPrompt(pending);
          sendResponse({
            ok: true,
            pending,
            bulkPrompt,
            bulkEtaMinutes: estimateDrainEtaMinutes(pending),
            bulkNotice: formatBulkQueueNotice(pending),
          });
          break;
        }
        case MSG.CONTINUE_BULK_DRIP: {
          const bulkPrompt = await snoozeBulkPrompt();
          await refreshReconcileSkipAfterBulkResume();
          await drain();
          sendResponse({ ok: true, bulkPrompt });
          break;
        }
        case MSG.RETRY_DEAD_LETTER: {
          const retried = await queue.retryDeadLetter();
          if (retried > 0) await drain();
          sendResponse({ ok: true, retried });
          break;
        }
        case MSG.CLEAR_DEAD_LETTER: {
          await queue.clearDeadLetter();
          sendResponse({ ok: true });
          break;
        }
        case MSG.MATCH_EXISTING_PLAN: {
          try {
            const plan = await runMatchExistingDryRun();
            // Do not send the full matched list in the status string path —
            // Options keeps it for Apply. Cap is fine for typical libraries.
            sendResponse(plan);
          } catch (err) {
            if (await handleClientError(err)) {
              if (err instanceof RateLimitError) {
                sendResponse(emptyPlan({ reason: "rate_limited" }));
                break;
              }
            }
            throw err;
          }
          break;
        }
        case MSG.MATCH_EXISTING_APPLY: {
          const matched = msg?.matched;
          if (!Array.isArray(matched)) {
            sendResponse({ ok: false, paired: 0, error: "Missing matched list from dry-run" });
            break;
          }
          const result = await applyMatchExisting(matched);
          if (result?.ok) {
            // Resume drip after pairing; snooze so a still-large queue does not re-arm immediately.
            await resolveBulkPromptAfterMatch();
            await refreshReconcileSkipAfterBulkResume();
            await drain();
          }
          sendResponse(result);
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep the channel open for the async sendResponse
});
