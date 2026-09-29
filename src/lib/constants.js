// Shared constants and defaults for the Bookmarks ↔ Raindrop sync extension.

export const RAINDROP_API = "https://api.raindrop.io/rest/v1";

// The three sync policies. `sync-and-delete` (offload) is the one-way global
// default; bidirectional saves force global `sync-and-keep` and treat offload as
// a per-folder exception only.
export const POLICY = {
  SYNC_DELETE: "sync-and-delete",
  SYNC_KEEP: "sync-and-keep",
  EXCLUDE: "exclude",
};

export const ALL_POLICIES = [POLICY.SYNC_DELETE, POLICY.SYNC_KEEP, POLICY.EXCLUDE];

// Global sync direction. One-way is the historical default.
export const SYNC_MODE = {
  ONE_WAY: "one-way",
  BIDIRECTIONAL: "bidirectional",
};

export const ALL_SYNC_MODES = [SYNC_MODE.ONE_WAY, SYNC_MODE.BIDIRECTIONAL];

// Bidirectional only: whether Raindrop collection paths may create Edge folders.
// Ignored when syncMode is one-way. Default create-as-needed matches historical pull.
export const RAINDROP_FOLDER_MODE = {
  EXISTING_ONLY: "existing-only",
  CREATE_AS_NEEDED: "create-as-needed",
  MIRROR_ALL: "mirror-all",
};

export const ALL_RAINDROP_FOLDER_MODES = [
  RAINDROP_FOLDER_MODE.EXISTING_ONLY,
  RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
  RAINDROP_FOLDER_MODE.MIRROR_ALL,
];

/** Chromium's invisible absolute bookmark root; its children are the top roots. */
export const ABSOLUTE_ROOT_ID = "0";

// Durable queue job kinds. Legacy jobs without `kind` are treated as upload.
export const JOB = {
  UPLOAD: "upload",
  PULL_CREATE: "pull-create",
  /** Raindrop→Edge title/URL/placement update for an existing pair. */
  PULL_UPDATE: "pull-update",
  /** Raindrop→Edge in-place folder title rename (mapped collection). */
  PULL_RENAME_FOLDER: "pull-rename-folder",
  DELETE_RAINDROP: "delete-raindrop",
  DELETE_EDGE: "delete-edge",
  /** Edge folder title → Raindrop collection rename (one-way and bidirectional). */
  RENAME_COLLECTION: "rename-collection",
};

// chrome.runtime message types (popup / options ↔ service worker).
export const MSG = {
  GET_STATUS: "getStatus",
  RUN_BACKFILL: "runBackfill",
  RECONCILE_NOW: "reconcileNow",
  DRAIN_NOW: "drainNow",
  RETRY_DEAD_LETTER: "retryDeadLetter",
  CLEAR_DEAD_LETTER: "clearDeadLetter",
  /** Bulk lane: dry-run Match existing from Raindrop export.csv. */
  MATCH_EXISTING_PLAN: "matchExistingPlan",
  /** Bulk lane: apply Match existing and record pairs from a dry-run plan. */
  MATCH_EXISTING_APPLY: "matchExistingApply",
  /** Queue-depth bulk prompt: durable needs_choice / snooze state. */
  GET_BULK_PROMPT: "getBulkPrompt",
  /** Queue-depth bulk prompt: continue drip (clear pause + snooze). */
  CONTINUE_BULK_DRIP: "continueBulkDrip",
  /** Bidirectional: Trash-only hygiene peek (safe-to-empty Status). */
  CHECK_TRASH: "checkTrash",
  /** Repair pairs: dry-run plan (prune dead pairs, rebind by URL, clear alive tombstones). */
  REPAIR_PAIRS_PLAN: "repairPairsPlan",
  /** Repair pairs: apply a dry-run plan. */
  REPAIR_PAIRS_APPLY: "repairPairsApply",
  /** Delete circuit breaker: allow the halted deletes (reset the rolling window). */
  ALLOW_DELETES: "allowDeletes",
  /** Delete circuit breaker: drop queued delete jobs, keep pairs. */
  DISCARD_DELETES: "discardDeletes",
};

/**
 * Delete circuit breaker. Executed deletes (either direction) are counted in a
 * rolling window; once the count reaches max(DELETE_BREAKER_MIN, fraction of
 * live pairs) further delete jobs stay queued and Status shows a halt with
 * Allow / Discard. A slow bleed of a few deletes per cycle (the Sep 2026
 * ghost-pair incident) trips this within the first hour; a per-wake cap never
 * would have.
 */
export const DELETE_BREAKER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DELETE_BREAKER_MIN = 50;
export const DELETE_BREAKER_PAIR_FRACTION = 0.02;

/** @param {number} livePairs */
export function deleteBreakerLimit(livePairs) {
  const n = Number(livePairs) || 0;
  return Math.max(DELETE_BREAKER_MIN, Math.ceil(n * DELETE_BREAKER_PAIR_FRACTION));
}

// chrome.storage.local keys. Everything durable lives under these — the MV3
// service worker holds no state across events.
export const KEY = {
  // { token, rootName, defaultPolicy, pruneEmpty, syncMode, raindropFolderMode,
  //   raindropFolderAllowlist, keepLongTermLog, reconcileIntervalMinutes, rootsMigratedAt? }
  CONFIG: "config",
  OVERRIDES: "overrides", // { [bookmarkFolderId]: { policy, path } }
  QUEUE: "queue", // [ { id, kind, attempts, nextAttemptAt, ... } ]
  /** Poison / exhausted jobs removed from QUEUE: [{ ...job, lastError, deadAt }] */
  DEAD_LETTER: "deadLetter",
  DEDUP: "dedup", // legacy { [bookmarkId]: raindropId } — read once into PAIRS, not dual-written
  // v2: { v: 2, records: { [raindropId]: PairRecord }, migrationPartial? }.
  // byBookmark / byUrlKey are derived in memory (store.js), never persisted.
  // v1 (legacy): { byBookmark: { [bookmarkId]: raindropId }, byRaindrop: { … } }
  PAIRS: "pairs",
  /** v1 pair map kept after migration until the next completed reconcile finish. */
  PAIRS_V1_BACKUP: "pairsV1Backup",
  /** Presence snapshot, durable form: { at, ids: string[], complete, count, lastCompleteCount }. */
  PRESENCE: "presence",
  /** Edge→Raindrop delete evidence: { [bookmarkId]: { urlKey, url, title, at, bookmarkId, raindropId } }. */
  EDGE_REMOVED: "edgeRemoved",
  /** Last computed pair health (pair-health.js), shown in Options → Status. */
  PAIR_HEALTH: "pairHealth",
  TOMBSTONES: "tombstones", // { [raindropId]: { at, reason } }
  SUPPRESS: "suppress", // { removes, creates, changes: { [bookmarkId]: expiresAt } }
  // reconcile: { cursorPage, outsideCursor, running, lastRunAt, lastSettledAt,
  //   presencePending, lastError, trashHygieneAt, trashScanComplete,
  //   trashPairedPending, trashPendingIds, trashHygieneSource }
  RECONCILE: "reconcile",
  COLLECTION_CACHE: "collectionCache", // { [collectionPath]: collectionId }
  /** Edge folder id → Raindrop collection id (for in-place folder renames). */
  FOLDER_COLLECTIONS: "folderCollections", // { [folderId]: collectionId }
  // { pending, lastError, deletionsHalted, lastActivityAt, lastPushAt, rateLimitedUntil,
  //   rateRemaining, rateResetAt, rateObservedAt, lastThrottle }
  STATUS: "status",
  LOG: "log", // [ { at, level, message } ] recent ring buffer (LOG_LIMIT)
  /**
   * Queue-depth bulk prompt: { status: 'idle'|'needs_choice', snoozedBelow: number|null }.
   * While needs_choice, drain (and heartbeat reconcile) pause until Match or Continue.
   */
  BULK_PROMPT: "bulkPrompt",
};

/** Quiet-time bidirectional reconcile presets / clamps (minutes). */
/** Quiet-time gap after a completed finish (alarm floor). Was 15; see right-sizing memo. */
export const DEFAULT_RECONCILE_INTERVAL_MINUTES = 1;
export const MIN_RECONCILE_INTERVAL_MINUTES = 1;
export const MAX_RECONCILE_INTERVAL_MINUTES = 60;

export const DEFAULT_CONFIG = {
  token: "",
  rootName: "Bookmarks",
  defaultPolicy: POLICY.SYNC_DELETE,
  pruneEmpty: false,
  syncMode: SYNC_MODE.ONE_WAY,
  raindropFolderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
  /** @type {Record<string, { path: string }>} Raindrop collection ids opted in for browser sync */
  raindropFolderAllowlist: {},
  /** When true, appendLog also writes to the IndexedDB long-term archive. */
  keepLongTermLog: false,
  /**
   * Minimum gap (minutes) between completed heartbeat reconcile cycles, and
   * the minimum presence-snapshot age before a heartbeat re-exports.
   * Bidirectional only.
   */
  reconcileIntervalMinutes: DEFAULT_RECONCILE_INTERVAL_MINUTES,
  /**
   * Raindrop→Edge deletes from absence in a complete presence snapshot. Off
   * falls back to Trash-listed deletes only (rollout safety valve).
   */
  presenceDeletesEnabled: true,
  /**
   * Set by one-shot roots migration (legacy Edge/Favorites → Bookmarks/…).
   * @type {number|undefined}
   */
  // rootsMigratedAt omitted until migration runs
};

/**
 * Local folder title that holds allowlisted Raindrop collections outside the
 * sync root. Prefixed onto mirror paths so they land under
 * Other bookmarks / Raindrop / … instead of colliding with browser top roots or
 * looking like children of the sync-root mirror folder.
 */
export const OUTSIDE_ROOT_MIRROR_FOLDER = "Raindrop";

// The alarm that drives the drain heartbeat even with no bookmark activity.
export const ALARM_NAME = "ers-heartbeat";
export const HEARTBEAT_MINUTES = 1;

/**
 * Quiet-time cooldown in ms from config (after normalizeConfig).
 * Applied after a completed finish (see reconcile.js); also the minimum
 * snapshot age before a heartbeat refreshes presence.
 * @param {{ reconcileIntervalMinutes?: number }|null|undefined} config
 */
export function reconcileIntervalMs(config) {
  const minutes =
    typeof config?.reconcileIntervalMinutes === "number" &&
    Number.isFinite(config.reconcileIntervalMinutes)
      ? config.reconcileIntervalMinutes
      : DEFAULT_RECONCILE_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

// Retry/backoff tuning. Backoff is capped; after MAX_JOB_ATTEMPTS the job
// moves to the dead-letter list instead of retrying forever.
export const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
export const BASE_BACKOFF_MS = 2000; // 2s, doubled per attempt
/** Transient failures beyond this count → dead-letter (rate-limit / auth exempt). */
export const MAX_JOB_ATTEMPTS = 20;
/** Soft cap on dead-letter entries retained in chrome.storage.local. */
export const DEAD_LETTER_LIMIT = 200;
export const RATE_LIMIT_FALLBACK_MS = 60 * 1000; // if no Retry-After header
/** Fallback when chrome.storage.local.QUOTA_BYTES is unavailable (typical Chromium). */
export const STORAGE_QUOTA_FALLBACK_BYTES = 10_485_760;
/**
 * Stop Raindrop work early when X-RateLimit-Remaining falls to this.
 * MUST be ≥ worst-case nested Raindrop calls in one job (ensure-collection
 * chains). Kept low so we use most of the ~120/min budget; too high felt like
 * "almost no traffic" then a full-minute pause (proactive RateLimitError).
 */
export const RATE_LIMIT_RESERVE = 4;
/**
 * When Remaining is unknown/stale on a *full* wake, allow only this many
 * Raindrop requests before following headers. Never “be bold” on a cold wake.
 */
export const BOOTSTRAP_REQS = 6;
/**
 * Short/opportunistic drain (live bookmark handlers): request headroom for
 * ensure-collection chains + one write when headers are unknown. Still far
 * below a full wakeCap; job count stays at {@link drainJobsCap}.
 */
export const SHORT_WAKE_REQS = 24;
/**
 * Soft max Raindrop HTTP requests per heartbeat / Pull-now / Drain-now wake
 * (MV3 / fairness backstop). Headers remain the API throttle.
 */
export const SOFT_MAX_REQS_PER_WAKE = 80;
/** Soft wall-clock cap for one budgeted wake (ms). */
export const SOFT_MAX_MS_PER_WAKE = 20_000;
/**
 * Soft max queue jobs completed on a *full* budgeted wake. Primary stop is
 * spendable/wakeCap; this is only a fairness backstop.
 */
export const SOFT_MAX_DRAIN_JOBS_PER_WAKE = 80;
/**
 * Historical small/busy drain caps — used for short/opportunistic drains and
 * bulk ETA estimates, not as the primary full-wake throttle.
 */
export const MAX_JOBS_PER_DRAIN = 25;
/** Pending queue size at which drain uses the busy (higher) per-tick cap. */
export const DRAIN_BUSY_PENDING_THRESHOLD = 100;
/**
 * Soft/opportunistic drain cap when pending ≥ DRAIN_BUSY_PENDING_THRESHOLD.
 */
export const MAX_JOBS_PER_DRAIN_BUSY = 55;

/**
 * How many queue jobs a *short* / ETA drain pass may complete.
 * Full heartbeat wakes use {@link SOFT_MAX_DRAIN_JOBS_PER_WAKE} under spendable.
 * @param {number} pending total durable queue size (not only due)
 */
export function drainJobsCap(pending) {
  const n = Number(pending) || 0;
  return n >= DRAIN_BUSY_PENDING_THRESHOLD ? MAX_JOBS_PER_DRAIN_BUSY : MAX_JOBS_PER_DRAIN;
}
/**
 * Presence snapshot (Raindrop export.csv) age after which on-demand consumers
 * (upload reclaim, delete survival check, Repair, migration) refresh it. Fixed,
 * independent of the reconcile interval; heartbeat refresh uses the interval.
 */
export const PRESENCE_STALE_MS = 10 * 60 * 1000;
/** A snapshot older than this never counts as complete for delete decisions. */
export const PRESENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A new export below this fraction of the last complete row count is incomplete. */
export const PRESENCE_MIN_COMPLETE_FRACTION = 0.5;
/**
 * The shrink rule applies only when the last complete snapshot had at least
 * this many rows; tiny libraries swing by half on ordinary edits.
 */
export const PRESENCE_SHRINK_MIN_ROWS = 50;
/** Edge→Raindrop delete ledger entries older than this are pruned. */
export const EDGE_REMOVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Soft max Raindrop list pages (root + outside-root) per reconcile tick. */
export const MAX_RECONCILE_PAGES_PER_TICK = 15;
/**
 * Heartbeat wakes in a row that only retry a due export (presencePending)
 * before the next heartbeat lists again. Keeps new, moved and renamed
 * raindrops flowing while exports keep failing.
 */
export const PRESENCE_ONLY_MAX_TRIES = 3;
/** Raindrop system collection for soft-deleted raindrops. */
export const RAINDROP_TRASH_COLLECTION_ID = -99;
/**
 * Soft max Trash list pages per reconcile finish (soft-delete fast path).
 * Always starts at page 0 each finish (newest soft-deletes first).
 */
export const MAX_TRASH_PAGES_PER_TICK = 5;
/** Raindrop list page size (API max 50). */
export const RAINDROP_LIST_PER_PAGE = 50;

/** Import is a bulk candidate when would-queue unpaired count is at least this. */
export const BULK_UNPAIRED_IMPORT_THRESHOLD = 200;
/** Min Edge URL bookmarks before low pair-coverage can trigger a bulk prompt. */
export const BULK_EDGE_COUNT_THRESHOLD = 100;
/** Suggest bulk when paired/edge is below this (and edge count ≥ BULK_EDGE_COUNT_THRESHOLD). */
export const BULK_PAIR_COVERAGE_THRESHOLD = 0.3;
/**
 * Durable queue size at which Status offers Match / continue-drip (external
 * HTML import storms, etc.). Snooze clears when pending drops below half.
 */
export const QUEUE_BULK_PENDING_THRESHOLD = 150;
/**
 * Fixed activity-log line while drain is paused for the queue bulk prompt.
 * Identical messages coalesce (×N) across heartbeats.
 */
export const BULK_DRAIN_PAUSED_LOG =
  "Sync drain paused: large queue — open Options → Status to Match from export or continue dripping";

/**
 * True when a Raindrop list page is the last (short page or past total count).
 * Shared by sync-root listing, outside-root listing, and Trash paging.
 * @param {number} page zero-based page index just fetched
 * @param {number} perPage page size used for the request
 * @param {unknown[]} items items returned on this page
 * @param {number} count total items reported by the API
 */
export function isListPageDone(page, perPage, items, count) {
  const fetched = (page + 1) * perPage;
  return items.length < perPage || fetched >= count;
}

// Suppression windows for extension-authored bookmark create/remove events.
export const SUPPRESS_MS = 15_000;

// Recent activity ring buffer in chrome.storage.local (Status UI).
export const LOG_LIMIT = 500;
/** Soft cap for opt-in IndexedDB long-term archive (oldest pruned first). */
export const LOG_ARCHIVE_LIMIT = 50_000;
/**
 * Max occurrence times kept on one coalesced activity row (`ats`).
 * Oldest times are dropped. Consecutive identical lines share one row.
 */
export const LOG_ATS_LIMIT = 100;
