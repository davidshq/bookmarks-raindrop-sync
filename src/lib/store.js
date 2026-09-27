// Durable state layer over chrome.storage.local.
//
// The MV3 service worker is ephemeral, so every piece of state the engine needs
// to survive a restart lives here: config, per-folder policy overrides, the
// bidirectional pair map, tombstones, suppressions, collection-path cache,
// Edge folder→collection map (for in-place folder renames), the job queue,
// and status/log. Opt-in long-term activity history lives in
// IndexedDB via log-archive.js (keepLongTermLog), not chrome.storage.local.
//
// Pair, suppress, log, and status mutations share withLock with the queue so
// concurrent drain / live-capture / reconcile cannot clobber each other's RMW
// updates. The lock is in-process only (one service worker); getConfig does
// not write, so an Options save cannot race a heal. Legacy DEDUP is migrated
// into PAIRS on first load; pair mutations write PAIRS only.
// Confirmed deletes/offloads use clearPairWithTombstone (tombstone + forget pair).

import {
  KEY,
  DEFAULT_CONFIG,
  DEFAULT_RECONCILE_INTERVAL_MINUTES,
  MIN_RECONCILE_INTERVAL_MINUTES,
  MAX_RECONCILE_INTERVAL_MINUTES,
  LOG_LIMIT,
  LOG_ATS_LIMIT,
  SUPPRESS_MS,
  POLICY,
  SYNC_MODE,
  STORAGE_QUOTA_FALLBACK_BYTES,
} from "./constants.js";
import { withLock } from "./mutex.js";
import { appendArchiveEntry } from "./log-archive.js";

async function read(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return key in got ? got[key] : fallback;
}

/**
 * Persist a key. On failure, record lastError (when possible) and rethrow so
 * callers can defer/retry — the SW itself is not crashed by an unhandled throw
 * when callers catch.
 */
async function write(key, value) {
  try {
    await chrome.storage.local.set({ [key]: value });
  } catch (err) {
    await noteStorageWriteFailure(key, err);
    throw err;
  }
}

/**
 * Persist several keys in one chrome.storage.local.set (atomic for that batch).
 * Used when moving a job from QUEUE → DEAD_LETTER so a mid-flight quota failure
 * cannot drop the job from both lists.
 * @param {Record<string, unknown>} obj
 */
async function writeMany(obj) {
  const keys = Object.keys(obj);
  try {
    await chrome.storage.local.set(obj);
  } catch (err) {
    await noteStorageWriteFailure(keys.join(","), err);
    throw err;
  }
}

async function noteStorageWriteFailure(keyLabel, err) {
  const message = `Storage write failed (${keyLabel}): ${err?.message || err}`;
  console.error("[ers]", message, err);
  if (keyLabel === KEY.STATUS || String(keyLabel).split(",").includes(KEY.STATUS)) {
    return;
  }
  try {
    const status = await read(KEY.STATUS, {});
    await chrome.storage.local.set({
      [KEY.STATUS]: { ...status, lastError: message },
    });
  } catch (statusErr) {
    console.error("[ers] could not record storage failure in status:", statusErr);
  }
}

/**
 * Approximate chrome.storage.local usage for Status UI.
 * @returns {Promise<{ bytesInUse: number, quotaBytes: number }>}
 */
export async function getStorageUsage() {
  let bytesInUse = 0;
  try {
    if (typeof chrome.storage.local.getBytesInUse === "function") {
      bytesInUse = await chrome.storage.local.getBytesInUse(null);
    }
  } catch (err) {
    console.error("[ers] getBytesInUse failed:", err);
  }
  const quotaBytes =
    typeof chrome.storage.local.QUOTA_BYTES === "number"
      ? chrome.storage.local.QUOTA_BYTES
      : STORAGE_QUOTA_FALLBACK_BYTES;
  return { bytesInUse, quotaBytes };
}

/* ---- config ---- */
// getConfig merges DEFAULT_CONFIG so new fields (e.g. raindropFolderMode) appear
// on older installs without a dedicated migration. It does not write.
// Bidirectional always keeps both sides globally in the returned object; the
// stored coercion is persisted by healStoredConfig (service-worker start) and
// by setConfig, never by a read.

/**
 * Clamp quiet-time reconcile interval to [1, 60] minutes; invalid → default 15.
 * @param {unknown} value
 * @returns {number}
 */
export function clampReconcileIntervalMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RECONCILE_INTERVAL_MINUTES;
  return Math.min(
    MAX_RECONCILE_INTERVAL_MINUTES,
    Math.max(MIN_RECONCILE_INTERVAL_MINUTES, Math.round(n))
  );
}

/** Force keep-both when bidirectional; folder Offload overrides still work. */
export function normalizeConfig(config) {
  const next = { ...config };
  if (next.syncMode === SYNC_MODE.BIDIRECTIONAL && next.defaultPolicy !== POLICY.SYNC_KEEP) {
    next.defaultPolicy = POLICY.SYNC_KEEP;
  }
  if (!next.raindropFolderAllowlist || typeof next.raindropFolderAllowlist !== "object") {
    next.raindropFolderAllowlist = {};
  }
  next.keepLongTermLog = !!next.keepLongTermLog;
  next.reconcileIntervalMinutes = clampReconcileIntervalMinutes(next.reconcileIntervalMinutes);
  return next;
}

export async function getConfig() {
  const stored = await read(KEY.CONFIG, {});
  return normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
}

/**
 * Persist bidirectional keep-both if storage still has a stale global offload.
 * Call from service-worker startup, not from getConfig — a read that writes
 * can race an Options token save (different JS world, same storage key).
 * @returns {Promise<object>} normalized config
 */
export async function healStoredConfig() {
  const stored = await read(KEY.CONFIG, {});
  const config = normalizeConfig({ ...DEFAULT_CONFIG, ...stored });
  if (
    stored.syncMode === SYNC_MODE.BIDIRECTIONAL &&
    stored.defaultPolicy &&
    stored.defaultPolicy !== POLICY.SYNC_KEEP
  ) {
    await write(KEY.CONFIG, config);
  }
  return config;
}

export async function setConfig(patch) {
  const next = normalizeConfig({ ...(await getConfig()), ...patch });
  await write(KEY.CONFIG, next);
  return next;
}

/** Raindrop-only collection allowlist (drafted with folder policies in Options). */
export async function getRaindropFolderAllowlist() {
  const config = await getConfig();
  return { ...(config.raindropFolderAllowlist || {}) };
}

export async function setRaindropFolderAllowlist(allowlist) {
  return setConfig({ raindropFolderAllowlist: allowlist ?? {} });
}

/* ---- per-folder policy overrides (keyed by bookmark folder id) ---- */

export async function getOverrides() {
  return read(KEY.OVERRIDES, {});
}

/** Replace the entire overrides map in one write (options Save). */
export async function setOverrides(overrides) {
  await write(KEY.OVERRIDES, overrides ?? {});
}

export async function setOverride(folderId, policy, path) {
  const overrides = await getOverrides();
  overrides[folderId] = { policy, path };
  await write(KEY.OVERRIDES, overrides);
}

export async function clearOverride(folderId) {
  const overrides = await getOverrides();
  delete overrides[folderId];
  await write(KEY.OVERRIDES, overrides);
}

/* ---- bidirectional pairs (bookmark id ↔ raindrop id) ---- */

function emptyPairs() {
  return { byBookmark: {}, byRaindrop: {} };
}

/** Load PAIRS, migrating from legacy DEDUP if needed. Caller must hold withLock. */
async function loadPairsUnlocked() {
  const existing = await read(KEY.PAIRS, null);
  if (existing && existing.byBookmark && existing.byRaindrop) return existing;

  const legacy = await read(KEY.DEDUP, {});
  const pairs = emptyPairs();
  for (const [bookmarkId, raindropId] of Object.entries(legacy)) {
    if (raindropId == null) continue;
    const rid = String(raindropId);
    pairs.byBookmark[bookmarkId] = rid;
    pairs.byRaindrop[rid] = bookmarkId;
  }
  await write(KEY.PAIRS, pairs);
  return pairs;
}

/** Migrate legacy DEDUP map into PAIRS once, then keep PAIRS authoritative (no dual-write). */
export async function ensurePairsMigrated() {
  return withLock(() => loadPairsUnlocked());
}

export async function getPairs() {
  return ensurePairsMigrated();
}

export async function hasSynced(bookmarkId) {
  const pairs = await getPairs();
  return Object.prototype.hasOwnProperty.call(pairs.byBookmark, bookmarkId);
}

export async function getRaindropId(bookmarkId) {
  const pairs = await getPairs();
  return pairs.byBookmark[bookmarkId] ?? null;
}

export async function getBookmarkIdForRaindrop(raindropId) {
  const pairs = await getPairs();
  return pairs.byRaindrop[String(raindropId)] ?? null;
}

export async function recordSynced(bookmarkId, raindropId) {
  return withLock(async () => {
    const pairs = await loadPairsUnlocked();
    const rid = String(raindropId);
    // Drop any previous reverse link for this raindrop or bookmark.
    const prevRid = pairs.byBookmark[bookmarkId];
    if (prevRid != null) delete pairs.byRaindrop[String(prevRid)];
    const prevBid = pairs.byRaindrop[rid];
    if (prevBid != null) delete pairs.byBookmark[prevBid];
    pairs.byBookmark[bookmarkId] = rid;
    pairs.byRaindrop[rid] = bookmarkId;
    await write(KEY.PAIRS, pairs);
  });
}

export async function forgetSynced(bookmarkId) {
  return withLock(async () => {
    const pairs = await loadPairsUnlocked();
    const rid = pairs.byBookmark[bookmarkId];
    if (rid != null) delete pairs.byRaindrop[String(rid)];
    delete pairs.byBookmark[bookmarkId];
    await write(KEY.PAIRS, pairs);
  });
}

export async function forgetPairByRaindrop(raindropId) {
  return withLock(async () => {
    const pairs = await loadPairsUnlocked();
    const rid = String(raindropId);
    const bookmarkId = pairs.byRaindrop[rid];
    if (bookmarkId != null) delete pairs.byBookmark[bookmarkId];
    delete pairs.byRaindrop[rid];
    await write(KEY.PAIRS, pairs);
    return bookmarkId ?? null;
  });
}

/* ---- tombstones (block recreate after user delete) ---- */

export async function getTombstones() {
  return read(KEY.TOMBSTONES, {});
}

export async function hasTombstone(raindropId) {
  const stones = await getTombstones();
  return Object.prototype.hasOwnProperty.call(stones, String(raindropId));
}

export async function addTombstone(raindropId, reason) {
  const stones = await getTombstones();
  stones[String(raindropId)] = { at: Date.now(), reason: reason || "delete" };
  await write(KEY.TOMBSTONES, stones);
}

/**
 * Confirmed delete / offload: tombstone then drop the pair so pull cannot
 * recreate and the bookmarkId mapping cannot go stale.
 * @returns {Promise<string|null>} prior bookmark id, if any
 */
export async function clearPairWithTombstone(raindropId, reason) {
  await addTombstone(raindropId, reason);
  return forgetPairByRaindrop(raindropId);
}

export async function clearTombstone(raindropId) {
  const stones = await getTombstones();
  delete stones[String(raindropId)];
  await write(KEY.TOMBSTONES, stones);
}

/** Drop tombstones for raindrop ids confirmed absent after a reconcile pass. */
export async function pruneTombstones(absentRaindropIds) {
  const stones = await getTombstones();
  let changed = false;
  for (const id of absentRaindropIds) {
    const key = String(id);
    if (stones[key]) {
      delete stones[key];
      changed = true;
    }
  }
  if (changed) await write(KEY.TOMBSTONES, stones);
}

/* ---- suppressions for extension-authored create/remove ---- */

/**
 * URL of one in-flight pull-create. The bookmark id does not exist until
 * chrome.bookmarks.create returns, and onCreated can fire first. Matching this
 * URL claims that one event, then clears, so a second bookmark of the same
 * URL is not treated as an echo. Durable suppression (below) is by bookmark id.
 */
let pendingExtensionCreateUrl = null;
/** Bookmark ids this worker already knows it created. */
const extensionCreatedIds = new Set();

/** Arm the one-shot URL match immediately before an extension bookmark create. */
export function expectExtensionCreate(url) {
  pendingExtensionCreateUrl = url || null;
}

/** Record the id once create() resolves, and drop the one-shot URL match. */
export function noteExtensionCreate(bookmarkId) {
  if (bookmarkId != null && bookmarkId !== "") extensionCreatedIds.add(String(bookmarkId));
  pendingExtensionCreateUrl = null;
}

/**
 * Drop the in-memory id after the durable bookmark-id suppression is stored.
 * onCreated that has not run yet still matches storage. Leaving the id here
 * would suppress a later bookmark if the browser reused the id (tests do).
 */
export function releaseExtensionCreate(bookmarkId) {
  if (bookmarkId != null && bookmarkId !== "") extensionCreatedIds.delete(String(bookmarkId));
}

/** Drop the one-shot match if create() failed before an id existed. */
export function abortExtensionCreate() {
  pendingExtensionCreateUrl = null;
}

/**
 * True when this onCreated is the extension's pull-create.
 * Checks the known id first, then at most one pending URL.
 * @param {string} bookmarkId
 * @param {string} [url]
 */
export function claimExtensionCreate(bookmarkId, url) {
  const id = bookmarkId != null ? String(bookmarkId) : "";
  if (id && extensionCreatedIds.delete(id)) return true;
  if (pendingExtensionCreateUrl && url && url === pendingExtensionCreateUrl) {
    pendingExtensionCreateUrl = null;
    return true;
  }
  return false;
}

async function getSuppress() {
  const raw = await read(KEY.SUPPRESS, { removes: {}, creates: {}, changes: {} });
  return {
    removes: raw.removes || {},
    creates: raw.creates || {},
    changes: raw.changes || {},
  };
}

async function writeSuppress(suppress) {
  await write(KEY.SUPPRESS, suppress);
}

function sweepExpired(map, now) {
  for (const [k, expiresAt] of Object.entries(map)) {
    if (expiresAt <= now) delete map[k];
  }
}

/** Record a suppression expiry under `bucket` (`removes` | `creates` | `changes`). */
async function suppressKey(bucket, key) {
  return withLock(async () => {
    const suppress = await getSuppress();
    const now = Date.now();
    sweepExpired(suppress[bucket], now);
    suppress[bucket][key] = now + SUPPRESS_MS;
    await writeSuppress(suppress);
  });
}

/**
 * Consume a suppression under `bucket`. Returns true if it was still valid.
 * Always persists after sweep so expired entries are cleaned up.
 */
async function consumeKey(bucket, key) {
  return withLock(async () => {
    const suppress = await getSuppress();
    const now = Date.now();
    sweepExpired(suppress[bucket], now);
    const expiresAt = suppress[bucket][key];
    if (expiresAt == null) {
      await writeSuppress(suppress);
      return false;
    }
    delete suppress[bucket][key];
    await writeSuppress(suppress);
    return expiresAt > now;
  });
}

export async function suppressRemove(bookmarkId) {
  return suppressKey("removes", bookmarkId);
}

export async function consumeRemoveSuppression(bookmarkId) {
  return consumeKey("removes", bookmarkId);
}

/** Suppress onCreated for this bookmark id. Not the URL — a second copy of the same link must still sync. */
export async function suppressCreate(bookmarkId) {
  if (bookmarkId == null || bookmarkId === "") return;
  return suppressKey("creates", String(bookmarkId));
}

export async function consumeCreateSuppression(bookmarkId) {
  if (bookmarkId == null || bookmarkId === "") return false;
  return consumeKey("creates", String(bookmarkId));
}

/** Suppress onMoved/onChanged echo when reconcile applies a Raindrop→Edge update. */
export async function suppressChange(bookmarkId) {
  if (!bookmarkId) return;
  return suppressKey("changes", String(bookmarkId));
}

/**
 * True while a change suppression window is active (does not consume).
 * onChanged and onMoved may both fire for one pull-update; both must stay quiet.
 */
export async function isChangeSuppressed(bookmarkId) {
  if (!bookmarkId) return false;
  return withLock(async () => {
    const suppress = await getSuppress();
    const now = Date.now();
    sweepExpired(suppress.changes, now);
    const expiresAt = suppress.changes[String(bookmarkId)];
    await writeSuppress(suppress);
    return expiresAt != null && expiresAt > now;
  });
}

/* ---- reconcile progress ---- */

export async function getReconcileState() {
  return read(KEY.RECONCILE, {
    cursorPage: 0,
    running: false,
    lastRunAt: null,
    lastError: null,
    /** Rotating index into delete-confirm candidates (survives completed cycles). */
    aliveConfirmOffset: 0,
    /** Rotating index into tombstone-prune candidates (survives completed cycles). */
    tombstonePruneOffset: 0,
  });
}

export async function setReconcileState(patch) {
  const next = { ...(await getReconcileState()), ...patch };
  await write(KEY.RECONCILE, next);
  return next;
}

/* ---- collection-path cache: "Edge/Work/ProjectA" -> collectionId ---- */

export async function getCollectionCache() {
  return read(KEY.COLLECTION_CACHE, {});
}

/** Replace the entire path→collectionId cache (used by roots migration). */
export async function setCollectionCache(cache) {
  await write(KEY.COLLECTION_CACHE, cache && typeof cache === "object" ? cache : {});
}

export async function cacheCollection(path, collectionId) {
  const cache = await getCollectionCache();
  cache[path] = collectionId;
  await write(KEY.COLLECTION_CACHE, cache);
}

/** Drop one path→id entry after the live Raindrop index no longer has that id. */
export async function uncacheCollection(path) {
  const cache = await getCollectionCache();
  if (!(path in cache)) return;
  delete cache[path];
  await write(KEY.COLLECTION_CACHE, cache);
}

export async function clearCollectionCache() {
  await write(KEY.COLLECTION_CACHE, {});
}

/**
 * After an in-place Raindrop collection rename, rewrite path→id cache keys
 * whose leaf (or ancestor prefix) used the old title for this collection id.
 * @param {string|number} collectionId
 * @param {string} newTitle
 */
export async function rewriteCollectionCacheForRename(collectionId, newTitle) {
  const cache = await getCollectionCache();
  const target = String(collectionId);
  const oldPaths = Object.entries(cache)
    .filter(([, id]) => String(id) === target)
    .map(([path]) => path);
  if (!oldPaths.length) return;

  const next = { ...cache };
  for (const oldPath of oldPaths) {
    const parts = oldPath.split("/");
    parts[parts.length - 1] = newTitle;
    const newPath = parts.join("/");
    if (newPath === oldPath) continue;
    for (const path of Object.keys(next)) {
      if (path === oldPath || path.startsWith(`${oldPath}/`)) {
        const rewritten = newPath + path.slice(oldPath.length);
        next[rewritten] = next[path];
        delete next[path];
      }
    }
  }
  await write(KEY.COLLECTION_CACHE, next);
}

/* ---- Edge folder id → Raindrop collection id (folder renames) ---- */

export async function getFolderCollections() {
  return read(KEY.FOLDER_COLLECTIONS, {});
}

export async function getFolderCollectionId(folderId) {
  if (folderId == null || folderId === "") return null;
  const map = await getFolderCollections();
  const id = map[String(folderId)];
  return id != null ? id : null;
}

export async function recordFolderCollection(folderId, collectionId) {
  if (folderId == null || folderId === "" || collectionId == null) return;
  const map = await getFolderCollections();
  map[String(folderId)] = collectionId;
  await write(KEY.FOLDER_COLLECTIONS, map);
}

export async function clearFolderCollection(folderId) {
  if (folderId == null || folderId === "") return;
  const map = await getFolderCollections();
  const key = String(folderId);
  if (!(key in map)) return;
  delete map[key];
  await write(KEY.FOLDER_COLLECTIONS, map);
}

/* ---- status + log (surfaced in the UI) ---- */

export async function getStatus() {
  return read(KEY.STATUS, {
    pending: 0,
    lastError: null,
    deletionsHalted: false,
    lastActivityAt: null,
    /** @type {number|null} epoch ms — last Import to Raindrop (backfill) run */
    lastPushAt: null,
    /** @type {number|null} epoch ms — skip Raindrop API work until then */
    rateLimitedUntil: null,
    /**
     * Why heartbeat skipped a Raindrop listing (busy / cooldown / bulk_pause).
     * Cleared when a non-skipped reconcile runs. null when idle/ok.
     * @type {null|"busy"|"cooldown"|"bulk_pause"|"rate_limited"}
     */
    reconcileSkipReason: null,
    /** @type {number|null} epoch ms when reconcileSkipReason was last set */
    reconcileSkipAt: null,
    /** @type {number|null} queue depth when skip was recorded */
    reconcileSkipPending: null,
  });
}

/**
 * Record why heartbeat deferred Raindrop reconcile (Status surfaces this).
 * @param {"busy"|"cooldown"|"bulk_pause"|"rate_limited"} reason
 * @param {{ pending?: number }} [opts]
 */
export async function noteReconcileSkip(reason, { pending } = {}) {
  return setStatus({
    reconcileSkipReason: reason,
    reconcileSkipAt: Date.now(),
    reconcileSkipPending: pending != null ? Number(pending) || 0 : null,
  });
}

/** Clear heartbeat reconcile-skip after a listing actually runs. */
export async function clearReconcileSkip() {
  return setStatus({
    reconcileSkipReason: null,
    reconcileSkipAt: null,
    reconcileSkipPending: null,
  });
}

/**
 * Status copy when heartbeat deferred Raindrop listing.
 * @param {{ reconcileSkipReason?: string|null, reconcileSkipPending?: number|null }|null|undefined} status
 * @param {number} [pendingFallback]
 * @returns {string|null}
 */
export function formatReconcileSkipNotice(status, pendingFallback) {
  const reason = status?.reconcileSkipReason;
  if (!reason) return null;
  const n =
    status?.reconcileSkipPending != null
      ? status.reconcileSkipPending
      : pendingFallback != null
        ? pendingFallback
        : null;
  const pendingBit = n != null ? ` (${n} pending)` : "";
  switch (reason) {
    case "busy":
      return (
        `Raindrop check deferred: sync queue still has Raindrop work${pendingBit}. ` +
        `Uploads/pulls continue to drip; use Pull now to force a check.`
      );
    case "cooldown":
      return (
        `Raindrop check on quiet-time cooldown` +
        (n != null ? ` (${n} pending in queue)` : "") +
        `. Wait for the interval, or use Pull now.`
      );
    case "bulk_pause":
      return (
        `Raindrop check paused while the bulk-queue prompt awaits Match or Continue drip` +
        pendingBit +
        `.`
      );
    case "rate_limited":
      return `Raindrop check deferred for rate limits${pendingBit}.`;
    default:
      return `Raindrop check deferred (${reason})${pendingBit}.`;
  }
}

async function setStatusUnlocked(patch) {
  const next = { ...(await getStatus()), ...patch };
  await write(KEY.STATUS, next);
  return next;
}

export async function setStatus(patch) {
  return withLock(() => setStatusUnlocked(patch));
}

/** True while a global Raindrop rate-limit pause is active. */
export async function isRateLimited(now = Date.now()) {
  const { rateLimitedUntil } = await getStatus();
  return rateLimitedUntil != null && rateLimitedUntil > now;
}

/**
 * Enter (or extend) the global Raindrop pause. Idempotent log-wise for callers.
 * @param {number} until epoch ms
 * @returns {Promise<boolean>} true if this call newly entered / extended the window
 */
export async function noteRateLimitedUntil(until) {
  return withLock(async () => {
    const status = await getStatus();
    const prev = status.rateLimitedUntil ?? 0;
    if (until <= prev) return false;
    await setStatusUnlocked({ rateLimitedUntil: until });
    return true;
  });
}

/** Clear the global pause after a successful tick past the window. */
export async function clearRateLimit() {
  return withLock(async () => {
    const status = await getStatus();
    if (status.rateLimitedUntil == null) return;
    await setStatusUnlocked({ rateLimitedUntil: null });
  });
}

export async function getLog() {
  return read(KEY.LOG, []);
}

/**
 * Rewrite `head` when it is the same level and message; otherwise null.
 * `ats` is oldest-first and includes the latest time. A first occurrence
 * has no `ats` (caller inserts `{ at, level, message }` as-is).
 * @param {{ at?: number, level?: string, message?: string, ats?: number[] }|undefined} head
 * @param {string} level
 * @param {string} message
 * @param {number} at
 * @returns {{ at: number, level: string, message: string, ats: number[] }|null}
 */
export function coalesceLogHead(head, level, message, at) {
  if (!head || head.level !== level || head.message !== message) return null;
  const prev = Array.isArray(head.ats) && head.ats.length > 0 ? head.ats : [head.at];
  const ats = [...prev, at].slice(-LOG_ATS_LIMIT);
  return { at, level, message, ats };
}

export async function appendLog(level, message, at) {
  const now = at ?? Date.now();
  let entry = { at: now, level, message };
  try {
    // Lock only the ring-buffer RMW. The archive write stays outside so
    // IndexedDB cannot block queue/pair updates, and getConfig is outside
    // so this lock cannot nest.
    entry = await withLock(async () => {
      const log = await getLog();
      const coalesced = coalesceLogHead(log[0], level, message, now);
      const stored = coalesced ?? entry;
      if (coalesced) log[0] = coalesced;
      else log.unshift(entry);
      await write(KEY.LOG, log.slice(0, LOG_LIMIT));
      return stored;
    });
  } catch (err) {
    console.error("[ers] appendLog storage failed:", err);
  }
  // Opt-in IndexedDB archive; never fail the recent write or sync path.
  try {
    const { keepLongTermLog } = await getConfig();
    if (keepLongTermLog) await appendArchiveEntry(entry);
  } catch (err) {
    console.error("[ers] log archive append failed:", err);
  }
}

export { read as _read, write as _write, writeMany as _writeMany };
