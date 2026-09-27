// Raindrop ↔ Edge reconciliation for bidirectional mode.
//
// Lists raindrops under the configured root (nested), enqueues pull-creates for
// unmapped items, pull-updates when a paired raindrop's title/URL/placement
// drifts from Edge, pull-rename-folder when a mapped collection title drifts
// from the Edge folder, and enqueues Edge deletes when a mapped raindrop
// disappears.
// Finish-cycle helpers: reconcile-finish.js. Pull enqueue: reconcile-enqueue.js.
//
// Rate-limit posture: shared page budget for root + outside-root listing; capped
// GET /raindrop confirms shared by delete detection + tombstone prune; stop early
// when the client reports low X-RateLimit-Remaining (throws RateLimitError).
// Heartbeat starts a *new* cycle only when the configured quiet-time interval has
// elapsed and the durable queue has no Raindrop-bound jobs; in-progress cursors
// always continue. Pull now (force) bypasses interval and queue-busy.

import {
  SYNC_MODE,
  RAINDROP_FOLDER_MODE,
  MAX_RECONCILE_PAGES_PER_TICK,
  JOB,
  reconcileIntervalMs,
} from "./constants.js";
import {
  getConfig,
  getOverrides,
  getPairs,
  getReconcileState,
  setReconcileState,
  setRaindropFolderAllowlist,
  appendLog,
  ensurePairsMigrated,
  isRateLimited,
} from "./store.js";
import * as queue from "./queue.js";
import { getTopRoots, mirrorPathExists } from "./bookmarks.js";
import {
  buildCollectionIndex,
  findRootCollection,
  collectionPathFromRoot,
  getById,
  mirrorRelativeSegments,
} from "./collections.js";
import { isAllowlistActive, pruneAllowlist } from "./allowlist.js";
import { RaindropClient } from "./raindrop.js";
import { maybeEnqueuePullCreate } from "./reconcile-enqueue.js";
import { finishReconcileCycle } from "./reconcile-finish.js";

const PER_PAGE = 50;

/** Job kinds that hit the Raindrop API (compete with listing for rate budget). */
const RAINDROP_BOUND_KINDS = new Set([
  JOB.UPLOAD,
  JOB.DELETE_RAINDROP,
  JOB.DELETE_EDGE,
  JOB.PULL_CREATE,
  JOB.PULL_UPDATE,
  JOB.PULL_RENAME_FOLDER,
  JOB.RENAME_COLLECTION,
]);

/** True when the durable queue still has Raindrop API work pending. */
export async function hasRaindropBoundQueueWork() {
  const jobs = await queue.list();
  return jobs.some((job) => RAINDROP_BOUND_KINDS.has(queue.jobKind(job)));
}

/** True when this list page is the last (short page or past total count). */
function isListPageDone(page, perPage, items, count) {
  const fetched = (page + 1) * perPage;
  return items.length < perPage || fetched >= count;
}

/** In-memory reentrancy guard — overlapping heartbeat + manual reconcile must not interleave. */
let reconciling = false;

/**
 * Run one reconcile pass (or continue from cursor). Safe to call from heartbeat.
 * @param {{ force?: boolean }} [opts] `force` (default true) bypasses the idle
 *   cooldown between completed cycles. Heartbeat passes `force: false`.
 * @returns {{
 *   enqueued: number,
 *   pages: number,
 *   done: boolean,
 *   skipped?: boolean,
 *   reason?: "busy"|"rate_limited"|"cooldown",
 * }}
 */
export async function reconcile({ force = true } = {}) {
  if (reconciling) {
    return { enqueued: 0, pages: 0, done: false, skipped: true, reason: "busy" };
  }
  if (await isRateLimited()) {
    return { enqueued: 0, pages: 0, done: false, skipped: true, reason: "rate_limited" };
  }
  reconciling = true;
  try {
    return await reconcileOnce({ force });
  } finally {
    reconciling = false;
  }
}

/** Durable signals that a multi-tick scan is mid-flight. */
function isReconcileInProgress(state) {
  return (
    (state.cursorPage || 0) > 0 ||
    state.outsideCursor != null ||
    (Array.isArray(state.seenAcc) && state.seenAcc.length > 0)
  );
}

async function reconcileOnce({ force }) {
  await ensurePairsMigrated();
  const config = await getConfig();
  if (config.syncMode !== SYNC_MODE.BIDIRECTIONAL) {
    return { enqueued: 0, pages: 0, done: true };
  }
  if (!config.token) {
    await setReconcileState({ lastError: "No Raindrop token configured", running: false });
    return { enqueued: 0, pages: 0, done: true };
  }

  const state = await getReconcileState();
  const inProgress = isReconcileInProgress(state);
  // Heartbeat only: after in-progress continues, defer new cycles while the
  // durable queue still has Raindrop work; then honor the configured quiet-time
  // interval. Pull now (force) bypasses busy + cooldown; hard rateLimitedUntil
  // already gated. (Hard pause covers low remaining — no separate soft snapshot.)
  if (!force && !inProgress) {
    if (await hasRaindropBoundQueueWork()) {
      return { enqueued: 0, pages: 0, done: true, skipped: true, reason: "busy" };
    }
    if (state.lastRunAt && Date.now() - state.lastRunAt < reconcileIntervalMs(config)) {
      return { enqueued: 0, pages: 0, done: true, skipped: true, reason: "cooldown" };
    }
  }

  const client = new RaindropClient(config.token);
  const index = await buildCollectionIndex(client);
  client.throwIfShouldPause();
  const root = findRootCollection(index, config.rootName);
  if (!root) {
    await appendLog(
      "info",
      `Pull skipped: Raindrop collection "${config.rootName}" not found yet.`
    );
    await setReconcileState({
      running: false,
      lastRunAt: Date.now(),
      lastError: null,
      cursorPage: 0,
      outsideCursor: null,
      seenAcc: null,
    });
    return { enqueued: 0, pages: 0, done: true };
  }

  let page = state.cursorPage || 0;
  let outsideCursor = state.outsideCursor || null;
  await setReconcileState({ running: true, lastError: null });

  let enqueued = 0;
  let pages = 0;
  const seenIds = new Set();
  const pairs = await getPairs();
  const overrides = await getOverrides();
  const topRoots = await getTopRoots();
  const folderMode = config.raindropFolderMode || RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED;
  let allowlist = config.raindropFolderAllowlist || {};

  try {
    // Drop allowlist ids deleted from Raindrop. Fully mirrored entries stay so
    // selective mode is not undone before pulls/ensures run.
    const pruned = await pruneAllowlist(allowlist, index, root._id, (relative) =>
      mirrorPathExists(relative, config.rootName, topRoots)
    );
    if (pruned.removed > 0) {
      allowlist = pruned.allowlist;
      await setRaindropFolderAllowlist(allowlist);
      await appendLog(
        "info",
        `Pruned ${pruned.removed} missing Raindrop-only allowlist entr${pruned.removed === 1 ? "y" : "ies"}.`
      );
    }

    const pullCtx = {
      index,
      rootId: root._id,
      config,
      overrides,
      topRoots,
      allowlist,
      folderMode,
      pairs,
      seenIds,
    };

    // Resume outside-root phase if a prior tick finished the root listing.
    if (outsideCursor) {
      const outside = await continueOutsideRoot(
        client,
        outsideCursor,
        pullCtx,
        MAX_RECONCILE_PAGES_PER_TICK
      );
      enqueued += outside.enqueued;
      pages += outside.pages;
      if (!outside.done) {
        return checkpointOutsidePending({
          seenIds,
          outsideCursor: outside.cursor,
          enqueued,
          pages,
        });
      }
      outsideCursor = null;
      await setReconcileState({ outsideCursor: null });
    } else {
      while (pages < MAX_RECONCILE_PAGES_PER_TICK) {
        const { items, count } = await client.listRaindrops(root._id, {
          page,
          perPage: PER_PAGE,
          nested: true,
        });
        pages++;
        client.throwIfShouldPause();

        for (const item of items) {
          enqueued += await maybeEnqueuePullCreate(item, pullCtx, (colId) => {
            const fullPath = collectionPathFromRoot(index, colId, root._id);
            if (!fullPath.length) return null;
            return fullPath.slice(1);
          });
        }

        if (isListPageDone(page, PER_PAGE, items, count)) {
          // Root listing done — start outside-root with remaining page budget.
          if (isAllowlistActive(allowlist)) {
            const started = startOutsideCursor(allowlist, index, root._id);
            if (started) {
              const remaining = MAX_RECONCILE_PAGES_PER_TICK - pages;
              const outside = await continueOutsideRoot(client, started, pullCtx, remaining);
              enqueued += outside.enqueued;
              pages += outside.pages;
              if (!outside.done) {
                return checkpointOutsidePending({
                  seenIds,
                  outsideCursor: outside.cursor,
                  enqueued,
                  pages,
                });
              }
            }
          }

          return finishReconcileCycle({
            client,
            seenIds,
            pairs,
            index,
            rootId: root._id,
            config,
            overrides,
            topRoots,
            folderMode,
            allowlist,
            enqueued,
            pages,
          });
        }

        page++;
        await mergeSeenAcc(seenIds);
        await setReconcileState({ cursorPage: page, outsideCursor: null, running: true });
      }

      await mergeSeenAcc(seenIds);
      await setReconcileState({ running: false, cursorPage: page, lastRunAt: Date.now() });
      if (enqueued > 0) {
        await appendLog(
          "info",
          `Pull queued ${enqueued} Raindrop change(s); still paging sync-root listing.`
        );
      }
      return { enqueued, pages, done: false };
    }

    // outsideCursor path finished above → delete detection + ensure.
    return finishReconcileCycle({
      client,
      seenIds,
      pairs,
      index,
      rootId: root._id,
      config,
      overrides,
      topRoots,
      folderMode,
      allowlist,
      enqueued,
      pages,
    });
  } catch (err) {
    await setReconcileState({ running: false, lastError: err.message });
    throw err;
  }
}

/**
 * Outside-root collection ids to list, as forest roots only.
 * If both a parent and child are allowlisted, nested listing of the parent
 * already covers the child — skip the child to avoid duplicate API pages.
 * @param {Record<string, unknown>} allowlist
 * @param {object} index
 * @param {number|string} rootId sync-root collection id
 * @returns {string[]}
 */
export function outsideRootListIds(allowlist, index, rootId) {
  const candidates = [];
  for (const id of Object.keys(allowlist)) {
    if (!getById(index, id)) continue;
    if (collectionPathFromRoot(index, id, rootId).length) continue;
    candidates.push(String(id));
  }
  const idSet = new Set(candidates);
  return candidates.filter((id) => {
    let current = getById(index, id);
    for (;;) {
      const parentId = current?.parent?.$id;
      if (parentId == null) return true;
      if (idSet.has(String(parentId))) return false;
      current = getById(index, parentId);
      if (!current) return true;
    }
  });
}

/**
 * Build a resumable cursor over allowlisted collections outside the sync root.
 * @returns {{ ids: string[], i: number, page: number }|null}
 */
function startOutsideCursor(allowlist, index, rootId) {
  const ids = outsideRootListIds(allowlist, index, rootId);
  if (!ids.length) return null;
  return { ids, i: 0, page: 0 };
}

/**
 * List outside-root allowlisted collections with a shared page budget.
 * @returns {{ enqueued: number, pages: number, done: boolean, cursor: object|null }}
 */
async function continueOutsideRoot(client, cursor, pullCtx, maxPages) {
  let enqueued = 0;
  let pages = 0;
  const { ids } = cursor;
  let { i, page } = cursor;
  const { index, rootId } = pullCtx;

  while (i < ids.length && pages < maxPages) {
    const id = ids[i];
    if (!getById(index, id)) {
      i++;
      page = 0;
      continue;
    }
    const { items, count } = await client.listRaindrops(id, {
      page,
      perPage: PER_PAGE,
      nested: true,
    });
    pages++;
    client.throwIfShouldPause();

    for (const item of items) {
      enqueued += await maybeEnqueuePullCreate(item, pullCtx, (colId) =>
        mirrorRelativeSegments(index, colId, rootId)
      );
    }

    if (isListPageDone(page, PER_PAGE, items, count)) {
      i++;
      page = 0;
    } else {
      page++;
    }
  }

  const done = i >= ids.length;
  return {
    enqueued,
    pages,
    done,
    cursor: done ? null : { ids, i, page },
  };
}

async function mergeSeenAcc(seenIds) {
  const state = await getReconcileState();
  const acc = new Set(state.seenAcc || []);
  for (const id of seenIds) acc.add(id);
  await setReconcileState({ seenAcc: [...acc] });
}

/**
 * Persist outside-root progress and end the tick without delete detection.
 * Used by both the resume path and root→outside handoff so cursor fields stay aligned.
 * Quiet when idle (enqueued === 0) — heartbeat used to spam this every minute.
 * @returns {{ enqueued: number, pages: number, done: false }}
 */
async function checkpointOutsidePending({ seenIds, outsideCursor, enqueued, pages }) {
  await mergeSeenAcc(seenIds);
  await setReconcileState({
    running: false,
    cursorPage: 0,
    outsideCursor,
    lastRunAt: Date.now(),
  });
  if (enqueued > 0) {
    await appendLog(
      "info",
      `Pull queued ${enqueued} Raindrop change(s); still listing outside-root collections.`
    );
  }
  return { enqueued, pages, done: false };
}
