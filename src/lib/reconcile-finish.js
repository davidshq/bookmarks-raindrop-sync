// Reconcile cycle finish: trash soft-delete fast path, delete-confirm GET,
// tombstone prune, folder-rename pull.
//
// Soft-deletes: list Raindrop Trash (-99) first (paginated). Confirm GETs remain
// for permanent deletes / non-trash absence. Follow-on strategies (park
// out-of-scope, collection 0, lastUpdate): docs/raindrop-delete-detection-options.md
//
// Delete-confirm and tombstone-prune share rotateConfirmWindow for GET-budget fairness.

import {
  JOB,
  MAX_ALIVE_CHECKS_PER_TICK,
  MAX_TRASH_PAGES_PER_TICK,
  RAINDROP_LIST_PER_PAGE,
  RAINDROP_TRASH_COLLECTION_ID,
} from "./constants.js";
import { rootTitlesEqual } from "./bookmark-roots.js";
import {
  hasTombstone,
  getTombstones,
  pruneTombstones,
  getFolderCollections,
  clearFolderCollection,
  getReconcileState,
  setReconcileState,
  appendLog,
} from "./store.js";
import * as queue from "./queue.js";
import { isExcluded } from "./policy.js";
import { getNode, folderPolicyAncestorIds } from "./bookmarks.js";
import { getById } from "./collections.js";
import { AuthError, RateLimitError, isNotFoundError } from "./raindrop.js";
import { ensureAllowlistedOrMirrorAll } from "./reconcile-enqueue.js";

export async function finishReconcileCycle({
  client,
  seenIds,
  pairs,
  index,
  rootId,
  config,
  overrides,
  topRoots,
  folderMode,
  allowlist,
  enqueued,
  pages,
}) {
  await finishConfirmGets(client, seenIds, pairs);
  await finishFolderRenamePull(index, config, overrides);
  await ensureAllowlistedOrMirrorAll(
    index,
    rootId,
    config,
    overrides,
    topRoots,
    folderMode,
    allowlist
  );
  await setReconcileState({
    running: false,
    cursorPage: 0,
    outsideCursor: null,
    lastRunAt: Date.now(),
    lastError: null,
    seenAcc: null,
  });
  if (enqueued > 0) {
    await appendLog("info", `Pull queued ${enqueued} Raindrop change(s).`);
  }
  return { enqueued, pages, done: true };
}

/**
 * Trash soft-delete fast path, then shared GET budget for delete-confirm and
 * tombstone prune (at most MAX_ALIVE_CHECKS_PER_TICK total).
 */
async function finishConfirmGets(client, seenIds, pairs) {
  const trashHandled = await finishTrashDeleteDetection(client, pairs);
  let remaining = MAX_ALIVE_CHECKS_PER_TICK;
  remaining = await finishDeleteDetection(
    client,
    seenIds,
    pairs,
    remaining,
    trashHandled
  );
  await finishTombstonePrune(client, seenIds, remaining);
}

/**
 * List Raindrop Trash and enqueue delete-edge for paired ids.
 * Delete-detection only — never pull-create/update from trash.
 * Always starts at page 0 (newest first under Raindrop's default sort) so
 * recent soft-deletes are not starved by a forward cursor; overflow beyond
 * MAX_TRASH_PAGES_PER_TICK falls through to confirm-GET.
 * @returns {Promise<Set<string>>} raindrop ids handled this pass (skip confirm GET)
 */
async function finishTrashDeleteDetection(client, pairs) {
  const handled = new Set();
  let page = 0;
  let pages = 0;
  let deleteJobs = 0;

  while (pages < MAX_TRASH_PAGES_PER_TICK) {
    const { items, count } = await client.listRaindrops(RAINDROP_TRASH_COLLECTION_ID, {
      page,
      perPage: RAINDROP_LIST_PER_PAGE,
      nested: false,
    });
    pages++;
    client.throwIfShouldPause();

    for (const item of items) {
      const rid = String(item._id ?? item.id);
      const bookmarkId = pairs.byRaindrop[rid];
      if (bookmarkId == null) continue;
      if (await hasTombstone(rid)) {
        handled.add(rid);
        continue;
      }
      handled.add(rid);
      const added = await queue.enqueueJob({
        id: `de-${rid}`,
        kind: JOB.DELETE_EDGE,
        raindropId: rid,
        bookmarkId,
      });
      if (added) deleteJobs++;
    }

    const fetched = (page + 1) * RAINDROP_LIST_PER_PAGE;
    if (items.length < RAINDROP_LIST_PER_PAGE || fetched >= count) break;
    page++;
  }

  if (deleteJobs > 0) {
    await appendLog(
      "info",
      `Pull queued ${deleteJobs} local delete(s) for raindrops found in Trash.`
    );
  }
  return handled;
}

/**
 * Walk a rotating window of candidates under a GET budget; persist offset.
 * Empty candidate list resets the offset so a later non-empty list starts at 0.
 *
 * @param {{
 *   candidates: any[],
 *   offsetKey: string,
 *   maxGets: number,
 *   visit: (candidate: any) => Promise<void>,
 * }} opts
 * @returns {Promise<{ checked: number, remaining: number }>}
 */
async function rotateConfirmWindow({ candidates, offsetKey, maxGets, visit }) {
  const state = await getReconcileState();
  if (!candidates.length) {
    if ((state[offsetKey] || 0) !== 0) {
      await setReconcileState({ [offsetKey]: 0 });
    }
    return { checked: 0, remaining: maxGets };
  }
  if (maxGets <= 0) return { checked: 0, remaining: 0 };

  const offset = (state[offsetKey] || 0) % candidates.length;
  const toCheck = Math.min(maxGets, candidates.length);
  for (let n = 0; n < toCheck; n++) {
    await visit(candidates[(offset + n) % candidates.length]);
  }
  await setReconcileState({
    [offsetKey]: (offset + toCheck) % candidates.length,
  });
  return { checked: toCheck, remaining: maxGets - toCheck };
}

/** In-memory union of durable seenAcc and this cycle's live seenIds (no write). */
async function seenAccWithLive(seenIds) {
  const state = await getReconcileState();
  const acc = new Set((state.seenAcc || []).map(String));
  for (const id of seenIds) acc.add(String(id));
  return acc;
}

/**
 * Confirm-GET fallback for pairs missing from scoped listing (permanent deletes,
 * emptied trash, etc.). Skips ids already handled by the Trash fast path.
 */
async function finishDeleteDetection(client, seenIds, pairs, maxGets, skipIds) {
  const acc = await seenAccWithLive(seenIds);

  // Build the full candidate list first, then walk a rotating window so pairs
  // past the per-tick budget are not starved across cycles.
  const candidates = [];
  for (const [rid, bookmarkId] of Object.entries(pairs.byRaindrop)) {
    if (acc.has(String(rid))) continue;
    if (skipIds?.has(String(rid))) continue;
    if (await hasTombstone(rid)) continue;
    candidates.push([rid, bookmarkId]);
  }

  let deleteJobs = 0;
  const { checked, remaining } = await rotateConfirmWindow({
    candidates,
    offsetKey: "aliveConfirmOffset",
    maxGets,
    visit: async ([rid, bookmarkId]) => {
      // Pairs outside the nested root listing (e.g. cleared outside-root allowlist)
      // never appear in seenIds — confirm with a direct get before deleting Edge.
      if (await raindropStillAlive(client, rid)) {
        client.throwIfShouldPause();
        return;
      }
      const added = await queue.enqueueJob({
        id: `de-${rid}`,
        kind: JOB.DELETE_EDGE,
        raindropId: rid,
        bookmarkId,
      });
      if (added) deleteJobs++;
      client.throwIfShouldPause();
    },
  });

  if (deleteJobs > 0) {
    await appendLog(
      "info",
      `Pull queued ${deleteJobs} local delete(s) for raindrops confirmed gone.`
    );
  }
  if (maxGets > 0) {
    const deferred = candidates.length - checked;
    if (deferred > 0) {
      await appendLog(
        "info",
        `Reconcile postponed ${deferred} missing-raindrop check(s) (rate-limit budget; continues next cycle).`
      );
    }
  }
  return remaining;
}

/**
 * Drop tombstones for raindrops confirmed gone (not in this cycle's listing and
 * GET says absent/trash). Living offload targets remain listed → kept.
 * Uses leftover confirm budget after delete-detection.
 * @returns {Promise<number>} unused GET budget
 */
async function finishTombstonePrune(client, seenIds, maxGets) {
  const acc = await seenAccWithLive(seenIds);

  const stones = await getTombstones();
  const candidates = Object.keys(stones).filter((rid) => !acc.has(rid));
  const absent = [];

  const { remaining } = await rotateConfirmWindow({
    candidates,
    offsetKey: "tombstonePruneOffset",
    maxGets,
    visit: async (rid) => {
      if (!(await raindropStillAlive(client, rid))) absent.push(rid);
      client.throwIfShouldPause();
    },
  });

  if (absent.length) {
    await pruneTombstones(absent);
    await appendLog("info", `Pruned ${absent.length} stale tombstone(s).`);
  }
  return remaining;
}

/**
 * Raindrop collection title → Edge folder title for mapped folders.
 * Uses the live collection index (no extra API). Skips Edge top roots and exclude.
 */
async function finishFolderRenamePull(index, config, overrides) {
  const map = await getFolderCollections();
  let enqueued = 0;

  for (const [folderId, collectionId] of Object.entries(map)) {
    const col = getById(index, collectionId);
    if (!col) {
      // Collection gone from Raindrop — drop stale mapping (titles handled elsewhere).
      await clearFolderCollection(folderId);
      continue;
    }

    let node;
    try {
      node = await getNode(folderId);
    } catch {
      await clearFolderCollection(folderId);
      continue;
    }
    if (node.url || node.parentId === "0") continue;

    const wantTitle = col.title || "";
    if ((node.title || "") === wantTitle) continue;
    // Do not push canonical bar/other titles onto local Favorites/Other roots.
    if (rootTitlesEqual(node.title, wantTitle)) continue;

    const ancestorIds = await folderPolicyAncestorIds(folderId, node.parentId);
    if (isExcluded(ancestorIds, overrides, config.defaultPolicy)) continue;

    const added = await queue.enqueueJob({
      id: `ref-${folderId}`,
      kind: JOB.PULL_RENAME_FOLDER,
      folderId: String(folderId),
      collectionId: String(collectionId),
      title: wantTitle,
    });
    if (added) enqueued++;
  }

  if (enqueued > 0) {
    await appendLog("info", `Pull queued ${enqueued} local folder rename(s) from Raindrop.`);
  }
}

/**
 * True when Raindrop still has a non-trashed item for this id.
 * Fail-soft on transient errors (5xx/network): assume alive so we do not
 * false-delete Edge pairs. Only definite absence (null / 404 / trash) ⇒ gone.
 */
async function raindropStillAlive(client, rid) {
  try {
    const item = await client.getRaindrop(rid);
    if (!item) return false;
    const col = item.collection?.$id ?? item.collection?.id;
    if (col === RAINDROP_TRASH_COLLECTION_ID || col === String(RAINDROP_TRASH_COLLECTION_ID)) {
      return false;
    }
    return true;
  } catch (err) {
    if (err instanceof AuthError || err instanceof RateLimitError) throw err;
    if (isNotFoundError(err)) return false;
    // 5xx / network / unknown — skip delete this tick.
    return true;
  }
}
