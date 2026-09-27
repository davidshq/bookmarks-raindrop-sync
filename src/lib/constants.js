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
};

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
  PAIRS: "pairs", // { byBookmark: { [bookmarkId]: raindropId }, byRaindrop: { [raindropId]: bookmarkId } }
  TOMBSTONES: "tombstones", // { [raindropId]: { at, reason } }
  SUPPRESS: "suppress", // { removes, creates, changes: { [bookmarkId]: expiresAt } }
  // reconcile: { cursorPage, outsideCursor, running, lastRunAt, lastSettledAt,
  //   unsettledConfirmCatchUp, lastError, seenAcc, aliveConfirmOffset,
  //   tombstonePruneOffset, parkedAliveIds }
  RECONCILE: "reconcile",
  COLLECTION_CACHE: "collectionCache", // { [collectionPath]: collectionId }
  /** Edge folder id → Raindrop collection id (for in-place folder renames). */
  FOLDER_COLLECTIONS: "folderCollections", // { [folderId]: collectionId }
  // { pending, lastError, deletionsHalted, lastActivityAt, lastPushAt, rateLimitedUntil }
  STATUS: "status",
  LOG: "log", // [ { at, level, message } ] recent ring buffer (LOG_LIMIT)
  /**
   * Queue-depth bulk prompt: { status: 'idle'|'needs_choice', snoozedBelow: number|null }.
   * While needs_choice, drain (and heartbeat reconcile) pause until Match or Continue.
   */
  BULK_PROMPT: "bulkPrompt",
};

/** Quiet-time bidirectional reconcile presets / clamps (minutes). */
/** Quiet-time gap after a *settled* finish (alarm floor). Was 15; see right-sizing memo. */
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
   * Minimum gap (minutes) between *settled* heartbeat reconcile cycles when
   * the durable queue has no Raindrop-bound jobs. Bidirectional only.
   * Unsettled confirm catch-up ignores this gap.
   */
  reconcileIntervalMinutes: DEFAULT_RECONCILE_INTERVAL_MINUTES,
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
 * Applied only after a settled finish (see reconcile.js).
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
 * Kept low so we use most of the ~120/min budget; too high felt like
 * "almost no traffic" then a full-minute pause (proactive RateLimitError).
 */
export const RATE_LIMIT_RESERVE = 4;
/**
 * Soft per-heartbeat drain cap when the queue is small. Large backlogs use
 * {@link MAX_JOBS_PER_DRAIN_BUSY} via {@link drainJobsCap}.
 */
export const MAX_JOBS_PER_DRAIN = 25;
/** Pending queue size at which drain uses the busy (higher) per-tick cap. */
export const DRAIN_BUSY_PENDING_THRESHOLD = 100;
/**
 * Per-heartbeat drain cap when pending ≥ DRAIN_BUSY_PENDING_THRESHOLD.
 * Still well under ~120/min; leaves headroom for collection ensures / Pull.
 */
export const MAX_JOBS_PER_DRAIN_BUSY = 55;

/**
 * How many queue jobs this drain pass may complete.
 * @param {number} pending total durable queue size (not only due)
 */
export function drainJobsCap(pending) {
  const n = Number(pending) || 0;
  return n >= DRAIN_BUSY_PENDING_THRESHOLD ? MAX_JOBS_PER_DRAIN_BUSY : MAX_JOBS_PER_DRAIN;
}
/**
 * Cap GET /raindrop/{id} confirms per reconcile finish, shared by
 * delete-detection and tombstone prune (delete-confirm runs first; prune
 * uses whatever budget remains). Unchecked work rotates next cycle.
 */
export const MAX_ALIVE_CHECKS_PER_TICK = 8;
/** Cap Raindrop list pages (root + outside-root) per reconcile tick. */
export const MAX_RECONCILE_PAGES_PER_TICK = 5;
/** Raindrop system collection for soft-deleted raindrops. */
export const RAINDROP_TRASH_COLLECTION_ID = -99;
/**
 * Cap Trash list pages per reconcile finish (soft-delete fast path).
 * Always starts at page 0 each finish (newest soft-deletes first).
 */
export const MAX_TRASH_PAGES_PER_TICK = 3;
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
