// Raindrop ↔ Edge reconciliation for bidirectional mode.
//
// Lists raindrops under the configured root (nested), enqueues pull-creates for
// unmapped items, pull-updates when a paired raindrop's title/URL/placement
// drifts from Edge, and pull-rename-folder when a mapped collection title
// drifts from the Edge folder. The listing is for placement only; presence
// (and so remote deletes) comes from the export snapshot on finish.
// Finish-cycle helpers: reconcile-finish.js. Pull enqueue: reconcile-enqueue.js.
//
// List paging uses RAINDROP_LIST_PER_PAGE + isListPageDone (shared with Trash).
//
// Rate-limit posture: shared WakeBudget (headers + soft wakeCap) for root /
// outside-root listing, the presence export, and Trash; stop early when the
// client reports low X-RateLimit-Remaining (throws RateLimitError). Soft page
// constants are fairness backstops under spendable.
// Heartbeat prefer-drains first (tick), then may start a *new* cycle when the
// quiet-time interval has elapsed since the last completed finish.
// Raindrop-bound queue jobs do NOT hard-skip listing — leftover spendable
// funds Trash / list / export. In-progress cursors always continue, and a
// finish whose due export did not fit (presencePending) completes on the next
// wake without re-listing. Pull now (force) bypasses the interval.

import {
  SYNC_MODE,
  RAINDROP_FOLDER_MODE,
  MAX_RECONCILE_PAGES_PER_TICK,
  RAINDROP_LIST_PER_PAGE,
  isListPageDone,
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
import { finishReconcileCycle, finishPendingPresence } from "./reconcile-finish.js";
import { completePairMigration } from "./pair-migration.js";
import { createWakeBudget, finalizeWakeBudget } from "./wake-budget.js";

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

/** In-memory reentrancy guard — overlapping heartbeat + manual reconcile must not interleave. */
let reconciling = false;

/**
 * Run one reconcile pass (or continue from cursor). Safe to call from heartbeat.
 * @param {{ force?: boolean, budget?: import("./wake-budget.js").WakeBudget }} [opts]
 *   `force` (default true) bypasses the idle cooldown between completed cycles.
 *   Heartbeat passes `force: false`. Pass a shared wake `budget` from tick /
 *   Pull now; when omitted, a full wake budget is created for this call.
 * @returns {{
 *   enqueued: number,
 *   pages: number,
 *   done: boolean,
 *   skipped?: boolean,
 *   reason?: "busy"|"rate_limited"|"cooldown",
 * }}
 */
export async function reconcile({ force = true, budget } = {}) {
  if (reconciling) {
    return { enqueued: 0, pages: 0, done: false, skipped: true, reason: "busy" };
  }
  if (await isRateLimited()) {
    return { enqueued: 0, pages: 0, done: false, skipped: true, reason: "rate_limited" };
  }
  reconciling = true;
  const ownedBudget = !budget;
  const wakeBudget = budget ?? (await createWakeBudget({ mode: "full" }));
  try {
    return await reconcileOnce({ force, budget: wakeBudget });
  } finally {
    reconciling = false;
    if (ownedBudget) {
      await finalizeWakeBudget(wakeBudget, { ranWork: wakeBudget.spent > 0 });
    }
  }
}

/** Durable signals that a multi-tick listing is mid-flight. */
function isReconcileInProgress(state) {
  return (state.cursorPage || 0) > 0 || state.outsideCursor != null;
}

async function reconcileOnce({ force, budget }) {
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
  const presenceOnly = !force && !inProgress && !!state.presencePending;
  // Heartbeat only: after in-progress continues, honor quiet-time after a
  // completed finish. A pending presence refresh skips cooldown (the last
  // finish did not complete). Queue work is not a hard skip — tick
  // prefer-drains first; leftover spendable funds Trash/list/export. Pull now
  // (force) bypasses cooldown; rateLimitedUntil gated. Skip reason `busy` is
  // only the in-process reconciling reentrancy above.
  if (!force && !inProgress) {
    if (!presenceOnly) {
      const settledAt = state.lastSettledAt ?? state.lastRunAt;
      if (settledAt && Date.now() - settledAt < reconcileIntervalMs(config)) {
        return { enqueued: 0, pages: 0, done: true, skipped: true, reason: "cooldown" };
      }
    }
    // Prefer-drain may have emptied the shared wake budget — do not start a
    // new cycle that would still burn collection-index GETs. In-progress and
    // Pull now may continue; Status self-cap is lastThrottle, not a skip reason.
    if (budget.shouldStop()) {
      return { enqueued: 0, pages: 0, done: true };
    }
  }

  const client = new RaindropClient(config.token);
  budget.bindClient(client);
  await completePairMigration({ client, budget });

  // Listing finished last wake but its due export did not fit: finish now.
  if (presenceOnly) {
    return finishPendingPresence({ client, budget, config });
  }

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
    });
    return { enqueued: 0, pages: 0, done: true };
  }

  let page = state.cursorPage || 0;
  let outsideCursor = state.outsideCursor || null;
  await setReconcileState({ running: true, lastError: null });

  let enqueued = 0;
  let pages = 0;
  const pairs = await getPairs();
  const overrides = await getOverrides();
  const topRoots = await getTopRoots();
  const folderMode = config.raindropFolderMode || RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED;
  let allowlist = config.raindropFolderAllowlist || {};

  /** Soft page backstop under spendable for this listing slice. */
  const pageCap = () => Math.min(MAX_RECONCILE_PAGES_PER_TICK, pages + budget.allowance());

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
    };

    // Resume outside-root phase if a prior tick finished the root listing.
    if (outsideCursor) {
      const outside = await continueOutsideRoot(
        client,
        outsideCursor,
        pullCtx,
        pageCap() - pages,
        budget
      );
      enqueued += outside.enqueued;
      pages += outside.pages;
      if (!outside.done) {
        return checkpointOutsidePending({
          outsideCursor: outside.cursor,
          enqueued,
          pages,
        });
      }
      outsideCursor = null;
      await setReconcileState({ outsideCursor: null });
    } else {
      while (pages < pageCap() && budget.canSpend(1)) {
        const { items, count } = await client.listRaindrops(root._id, {
          page,
          perPage: RAINDROP_LIST_PER_PAGE,
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

        if (isListPageDone(page, RAINDROP_LIST_PER_PAGE, items, count)) {
          // Root listing done — start outside-root with remaining page budget.
          if (isAllowlistActive(allowlist)) {
            const started = startOutsideCursor(allowlist, index, root._id);
            if (started) {
              const remaining = Math.max(0, pageCap() - pages);
              const outside = await continueOutsideRoot(
                client,
                started,
                pullCtx,
                remaining,
                budget
              );
              enqueued += outside.enqueued;
              pages += outside.pages;
              if (!outside.done) {
                return checkpointOutsidePending({
                  outsideCursor: outside.cursor,
                  enqueued,
                  pages,
                });
              }
            }
          }

          return finishReconcileCycle({
            client,
            budget,
            force,
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
        await setReconcileState({ cursorPage: page, outsideCursor: null, running: true });
      }

      await setReconcileState({ running: false, cursorPage: page, lastRunAt: Date.now() });
      if (enqueued > 0) {
        await appendLog(
          "info",
          `Pull queued ${enqueued} Raindrop change(s); still paging sync-root listing.`
        );
      }
      return { enqueued, pages, done: false };
    }

    // outsideCursor path finished above → presence, deletes + ensure.
    return finishReconcileCycle({
      client,
      budget,
      force,
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
async function continueOutsideRoot(client, cursor, pullCtx, maxPages, budget) {
  let enqueued = 0;
  let pages = 0;
  const { ids } = cursor;
  let { i, page } = cursor;
  const { index, rootId } = pullCtx;

  while (i < ids.length && pages < maxPages && budget.canSpend(1)) {
    const id = ids[i];
    if (!getById(index, id)) {
      i++;
      page = 0;
      continue;
    }
    const { items, count } = await client.listRaindrops(id, {
      page,
      perPage: RAINDROP_LIST_PER_PAGE,
      nested: true,
    });
    pages++;
    client.throwIfShouldPause();

    for (const item of items) {
      enqueued += await maybeEnqueuePullCreate(item, pullCtx, (colId) =>
        mirrorRelativeSegments(index, colId, rootId)
      );
    }

    if (isListPageDone(page, RAINDROP_LIST_PER_PAGE, items, count)) {
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

/**
 * Persist outside-root progress and end the tick without delete detection.
 * Used by both the resume path and root→outside handoff so cursor fields stay aligned.
 * Quiet when idle (enqueued === 0) — heartbeat used to spam this every minute.
 * @returns {{ enqueued: number, pages: number, done: false }}
 */
async function checkpointOutsidePending({ outsideCursor, enqueued, pages }) {
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
