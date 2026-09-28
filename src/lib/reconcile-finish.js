// Reconcile cycle finish: trash soft-delete fast path, delete-confirm GET,
// tombstone prune, folder-rename pull.
//
// Soft-deletes: list Raindrop Trash (-99) first (paginated). Confirm GETs remain
// for permanent deletes / non-trash absence. Out-of-scope alives are parked so
// they stop re-candidating (option C). Follow-ons (collection 0, lastUpdate):
// docs/raindrop-delete-detection-options.md
//
// While confirm catch-up is unsettled, finish keeps `seenAcc` and heartbeat may
// call runConfirmCatchUp (Trash + confirms only — no nested re-list).
//
// Trash listing also writes the trash hygiene snapshot (safe-to-empty Status).
// Trash + confirm-GET both enqueue via enqueueDeleteEdge (shared job id/payload).
// Delete-confirm and tombstone-prune share rotateConfirmWindow for GET-budget fairness.

import {
  JOB,
  MAX_ALIVE_CHECKS_PER_TICK,
  MAX_TRASH_PAGES_PER_TICK,
  RAINDROP_LIST_PER_PAGE,
  RAINDROP_TRASH_COLLECTION_ID,
  SOFT_MAX_REQS_PER_WAKE,
  isListPageDone,
} from "./constants.js";
import { rootTitlesEqual } from "./bookmark-roots.js";
import {
  hasTombstone,
  getTombstones,
  pruneTombstones,
  getFolderCollections,
  getFolderCollectionId,
  clearFolderCollection,
  recordFolderCollection,
  getCollectionCache,
  getReconcileState,
  setReconcileState,
  getParkedAliveIds,
  parkAliveIds,
  unparkAliveIds,
  setParkedAliveIds,
  getPairs,
  appendLog,
} from "./store.js";
import * as queue from "./queue.js";
import {
  getNodeOrNull,
  getChildren,
  isFolderExcluded,
  resolveExistingMirrorParent,
  resolveMirrorPlacement,
  walkAncestorsFromFolder,
} from "./bookmarks.js";
import { getById, collectionsUnderRoot, isOutsideRootLandingSegments } from "./collections.js";
import { isInScopedListing } from "./allowlist.js";
import {
  AuthError,
  RateLimitError,
  isNotFoundError,
  raindropCollectionId,
} from "./raindrop.js";
import { ensureAllowlistedOrMirrorAll } from "./reconcile-enqueue.js";
import { writeTrashHygieneSnapshot, getTrashHygieneNextPage } from "./trash-hygiene.js";

/**
 * Enqueue a local Edge delete for a raindrop that is gone (trash or confirm-GET).
 * Shared by trash listing and missing-raindrop confirm so job id/payload stay aligned.
 * @returns {Promise<boolean>} true when a new job was added
 */
async function enqueueDeleteEdge(rid, bookmarkId) {
  return queue.enqueueJob({
    id: `de-${rid}`,
    kind: JOB.DELETE_EDGE,
    raindropId: rid,
    bookmarkId,
  });
}

/** True when a delete-edge job for this raindrop is already queued. */
async function hasQueuedDeleteEdge(rid) {
  const target = String(rid);
  const jobs = await queue.list();
  return jobs.some((j) => {
    if (queue.jobKind(j) !== JOB.DELETE_EDGE) return false;
    return j.raindropId != null && String(j.raindropId) === target;
  });
}

export async function finishReconcileCycle({
  client,
  budget,
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
  await finishConfirmGets(client, budget, seenIds, pairs, index, rootId, allowlist, {
    catchUp: false,
  });
  await finishFolderRenamePull(index, config, overrides, rootId, topRoots);
  await ensureAllowlistedOrMirrorAll(
    index,
    rootId,
    config,
    overrides,
    topRoots,
    folderMode,
    allowlist
  );
  // Persist the completed listing's presence oracle. While confirm catch-up is
  // unsettled, keep seenAcc so later heartbeats can confirm-only without
  // re-listing; clear it once deferred confirms drain (settled).
  const after = await getReconcileState();
  const presence = new Set((after.seenAcc || []).map(String));
  for (const id of seenIds) presence.add(String(id));
  await setReconcileState({
    running: false,
    cursorPage: 0,
    outsideCursor: null,
    lastRunAt: Date.now(),
    lastError: null,
    seenAcc: after.unsettledConfirmCatchUp ? [...presence] : null,
  });
  if (enqueued > 0) {
    await appendLog("info", `Pull queued ${enqueued} Raindrop change(s).`);
  }
  return { enqueued, pages, done: true };
}

/**
 * Confirm-only wake: reuse durable seenAcc (no nested re-list). Same Trash /
 * confirm / park / delete-edge safety as a normal finish; spends leftover
 * wake budget with a higher soft confirm backstop so catch-up can drain.
 *
 * @param {{
 *   client: import("./raindrop.js").RaindropClient,
 *   budget: import("./wake-budget.js").WakeBudget|null|undefined,
 *   index: object,
 *   rootId: number|string,
 *   allowlist: object,
 * }} args
 */
export async function runConfirmCatchUp({ client, budget, index, rootId, allowlist }) {
  const pairs = await getPairs();
  const state = await getReconcileState();
  const seenIds = new Set((state.seenAcc || []).map(String));
  await finishConfirmGets(client, budget, seenIds, pairs, index, rootId, allowlist, {
    catchUp: true,
  });
  const after = await getReconcileState();
  await setReconcileState({
    lastRunAt: Date.now(),
    lastError: null,
    seenAcc: after.unsettledConfirmCatchUp ? after.seenAcc : null,
  });
  if (!after.unsettledConfirmCatchUp) {
    await appendLog("info", "Missing-raindrop confirm catch-up settled.");
  }
  return { enqueued: 0, pages: 0, done: true, confirmCatchUp: true };
}

/**
 * Trash soft-delete fast path, then shared GET budget for delete-confirm and
 * tombstone prune. Soft confirm backstop is MAX_ALIVE_CHECKS_PER_TICK on a
 * normal finish; catch-up may use up to SOFT_MAX_REQS_PER_WAKE under spendable.
 *
 * @param {{ catchUp?: boolean }} [opts]
 */
async function finishConfirmGets(
  client,
  budget,
  seenIds,
  pairs,
  index,
  rootId,
  allowlist,
  opts = {}
) {
  const trashHandled = await finishTrashDeleteDetection(client, budget, pairs);
  const softBackstop = opts.catchUp ? SOFT_MAX_REQS_PER_WAKE : MAX_ALIVE_CHECKS_PER_TICK;
  const confirmCap = Math.min(softBackstop, budget?.allowance?.() ?? softBackstop);
  let remaining = confirmCap;
  remaining = await finishDeleteDetection(
    client,
    budget,
    seenIds,
    pairs,
    remaining,
    trashHandled,
    index,
    rootId,
    allowlist
  );
  await finishTombstonePrune(client, budget, seenIds, remaining);
}

/**
 * List Raindrop Trash and enqueue delete-edge for paired ids.
 * Delete-detection only — never pull-create/update from trash.
 * Always starts at page 0 (newest first under Raindrop's default sort) so
 * recent soft-deletes are not starved by a forward cursor; overflow beyond
 * MAX_TRASH_PAGES_PER_TICK falls through to confirm-GET.
 * Writes trash hygiene snapshot (discovery debt for Status safe-to-empty).
 *
 * @param {import("./raindrop.js").RaindropClient} client
 * @param {import("./wake-budget.js").WakeBudget|null|undefined} budget
 * @param {{ byRaindrop: Record<string, string> }} pairs
 * @param {"reconcile"|"check-trash"} [source]
 * @returns {Promise<Set<string>>} raindrop ids handled this pass (skip confirm GET)
 */
async function finishTrashDeleteDetection(client, budget, pairs, source = "reconcile") {
  const handled = new Set();
  // Heartbeat: always page 0 (newest soft-deletes). Check Trash: continue cursor.
  let page = source === "check-trash" ? await getTrashHygieneNextPage() : 0;
  let pages = 0;
  let deleteJobs = 0;
  let pairedPending = 0;
  let scanComplete = false;
  // Heartbeat finish shares leftover spendable (≤ MAX_TRASH_PAGES). Explicit
  // Check Trash may burn more of the wake so large Trash can still complete.
  const softPageCap =
    source === "check-trash"
      ? Math.max(MAX_TRASH_PAGES_PER_TICK, SOFT_MAX_REQS_PER_WAKE)
      : MAX_TRASH_PAGES_PER_TICK;
  const trashCap = Math.min(softPageCap, budget?.allowance?.() ?? softPageCap);

  // No request left — do not stamp a false "incomplete" over a prior good peek.
  if (trashCap <= 0 || (budget && !budget.canSpend(1))) {
    return handled;
  }

  while (pages < trashCap && (!budget || budget.canSpend(1))) {
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
      if (await hasQueuedDeleteEdge(rid)) {
        handled.add(rid);
        continue;
      }
      // Still needs enroll — count, then enroll so post-peek pending drops.
      pairedPending++;
      handled.add(rid);
      const added = await enqueueDeleteEdge(rid, bookmarkId);
      if (added) {
        deleteJobs++;
        pairedPending--;
      } else if (await hasQueuedDeleteEdge(rid)) {
        pairedPending--;
      }
    }

    if (isListPageDone(page, RAINDROP_LIST_PER_PAGE, items, count)) {
      scanComplete = true;
      break;
    }
    page++;
  }

  if (pages === 0) return handled;

  if (deleteJobs > 0) {
    await appendLog(
      "info",
      `Pull queued ${deleteJobs} local delete(s) for raindrops found in Trash.`
    );
  }

  // Heartbeat truncated peeks only enroll — don't thrash Status to "partial".
  // Check Trash owns the complete-scan oracle (and Continue cursor).
  if (source === "reconcile" && !scanComplete) {
    return handled;
  }

  await writeTrashHygieneSnapshot({
    scanComplete,
    pairedPending,
    source,
    // After incomplete Check Trash, next click resumes here (not page 0 again).
    nextPage: scanComplete ? 0 : page,
  });
  return handled;
}

/**
 * Trash-only hygiene peek (Check Trash): list Trash, enroll paired deletes,
 * refresh the durable snapshot. Does not run confirm-GET or full reconcile.
 *
 * @param {{
 *   client: import("./raindrop.js").RaindropClient,
 *   budget?: import("./wake-budget.js").WakeBudget|null,
 * }} opts
 * @returns {Promise<{ handled: number, scanComplete: boolean, pairedPending: number }>}
 */
export async function runTrashHygienePeek({ client, budget }) {
  const pairs = await getPairs();
  await finishTrashDeleteDetection(client, budget, pairs, "check-trash");
  const state = await getReconcileState();
  return {
    handled: 0,
    scanComplete: !!state.trashScanComplete,
    pairedPending: Number(state.trashPairedPending) || 0,
  };
}

/**
 * Walk a rotating window of candidates under a GET budget; persist offset.
 * Empty candidate list resets the offset so a later non-empty list starts at 0.
 * Stops early when the shared wake budget is exhausted (unchecked stay deferred).
 *
 * @param {{
 *   candidates: any[],
 *   offsetKey: string,
 *   maxGets: number,
 *   visit: (candidate: any) => Promise<void>,
 *   budget?: import("./wake-budget.js").WakeBudget|null,
 * }} opts
 * @returns {Promise<{ checked: number, remaining: number }>}
 */
async function rotateConfirmWindow({ candidates, offsetKey, maxGets, visit, budget }) {
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
  let checked = 0;
  for (let n = 0; n < toCheck; n++) {
    if (budget && !budget.canSpend(1)) break;
    await visit(candidates[(offset + n) % candidates.length]);
    checked++;
  }
  await setReconcileState({
    [offsetKey]: (offset + checked) % candidates.length,
  });
  return { checked, remaining: maxGets - checked };
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
 * emptied trash, etc.). Skips ids already handled by the Trash fast path and
 * ids parked as out-of-scope alives.
 */
async function finishDeleteDetection(
  client,
  budget,
  seenIds,
  pairs,
  maxGets,
  skipIds,
  index,
  rootId,
  allowlist
) {
  const acc = await seenAccWithLive(seenIds);

  // Back in scoped listing → eligible for delete-confirm again if they leave later.
  const parked = await getParkedAliveIds();
  if (parked.size) {
    const toUnpark = [];
    for (const rid of parked) {
      if (acc.has(String(rid))) toUnpark.push(rid);
    }
    if (toUnpark.length) await unparkAliveIds(toUnpark);
  }

  // Drop park entries for pairs that no longer exist.
  const parkedAfterUnpark = await getParkedAliveIds();
  if (parkedAfterUnpark.size) {
    const kept = [...parkedAfterUnpark].filter((rid) => pairs.byRaindrop[rid] != null);
    if (kept.length !== parkedAfterUnpark.size) await setParkedAliveIds(kept);
  }
  const parkedSkip = await getParkedAliveIds();

  // Build the full candidate list first, then walk a rotating window so pairs
  // past the per-tick budget are not starved across cycles.
  const candidates = [];
  for (const [rid, bookmarkId] of Object.entries(pairs.byRaindrop)) {
    if (acc.has(String(rid))) continue;
    if (skipIds?.has(String(rid))) continue;
    if (parkedSkip.has(String(rid))) continue;
    if (await hasTombstone(rid)) continue;
    candidates.push([rid, bookmarkId]);
  }

  let deleteJobs = 0;
  const newlyParked = [];
  const { checked, remaining } = await rotateConfirmWindow({
    candidates,
    offsetKey: "aliveConfirmOffset",
    maxGets,
    budget,
    visit: async ([rid, bookmarkId]) => {
      // Pairs outside the nested root listing (e.g. cleared outside-root allowlist)
      // never appear in seenIds — confirm with a direct get before deleting Edge.
      const probe = await probeLivingRaindrop(client, rid);
      if (probe.status === "unknown") {
        client.throwIfShouldPause();
        return;
      }
      if (probe.status === "alive") {
        const col = raindropCollectionId(probe.item);
        if (!isInScopedListing(col, index, rootId, allowlist)) {
          newlyParked.push(String(rid));
        }
        client.throwIfShouldPause();
        return;
      }
      const added = await enqueueDeleteEdge(rid, bookmarkId);
      if (added) deleteJobs++;
      client.throwIfShouldPause();
    },
  });

  if (newlyParked.length) {
    await parkAliveIds(newlyParked);
    await appendLog(
      "info",
      `Parked ${newlyParked.length} out-of-scope alive pair(s) (skipped future missing-raindrop checks).`
    );
  }
  if (deleteJobs > 0) {
    await appendLog(
      "info",
      `Pull queued ${deleteJobs} local delete(s) for raindrops confirmed gone.`
    );
  }
  const deferred = Math.max(0, candidates.length - checked);
  if (deferred > 0) {
    await appendLog(
      "info",
      `Reconcile postponed ${deferred} missing-raindrop check(s) ` +
        `(confirm budget this cycle; continues next heartbeat).`
    );
    await setReconcileState({ unsettledConfirmCatchUp: true });
  } else {
    await setReconcileState({
      unsettledConfirmCatchUp: false,
      lastSettledAt: Date.now(),
    });
  }
  return remaining;
}

/**
 * Drop tombstones for raindrops confirmed gone (not in this cycle's listing and
 * GET says absent/trash). Living offload targets remain listed → kept.
 * Uses leftover confirm budget after delete-detection.
 * @returns {Promise<number>} unused GET budget
 */
async function finishTombstonePrune(client, budget, seenIds, maxGets) {
  const acc = await seenAccWithLive(seenIds);

  const stones = await getTombstones();
  const candidates = Object.keys(stones).filter((rid) => !acc.has(rid));
  const absent = [];

  const { remaining } = await rotateConfirmWindow({
    candidates,
    offsetKey: "tombstonePruneOffset",
    maxGets,
    budget,
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
 * Heals missing folderCollections (pull-created before mapping existed) by
 * matching the parent mirror path + a single unmapped sibling folder.
 * Uses the live collection index (no extra API). Skips Edge top roots and exclude.
 */
async function finishFolderRenamePull(index, config, overrides, rootId, topRoots) {
  let enqueued = 0;
  if (rootId != null) {
    enqueued += await healUnmappedFolderCollections(
      index,
      rootId,
      config,
      overrides,
      topRoots
    );
  }

  const map = await getFolderCollections();
  for (const [folderId, collectionId] of Object.entries(map)) {
    const col = getById(index, collectionId);
    if (!col) {
      // Collection gone from Raindrop — drop stale mapping (titles handled elsewhere).
      await clearFolderCollection(folderId);
      continue;
    }

    const node = await getNodeOrNull(folderId);
    if (!node) {
      await clearFolderCollection(folderId);
      continue;
    }
    if (node.url || node.parentId === "0") continue;

    const wantTitle = col.title || "";
    if ((node.title || "") === wantTitle) continue;
    // Do not push canonical bar/other titles onto local Favorites/Other roots.
    if (rootTitlesEqual(node.title, wantTitle)) continue;

    if (await isFolderExcluded(folderId, node.parentId, overrides, config.defaultPolicy)) {
      continue;
    }

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
 * Learn folder→collection for Raindrop paths that already exist in Edge, or for
 * a single unmapped sibling when the leaf title drifted (rename without map).
 * @returns {Promise<number>} rename jobs enqueued during heal
 */
async function healUnmappedFolderCollections(index, rootId, config, overrides, topRoots) {
  const map = await getFolderCollections();
  const mappedColIds = new Set(Object.values(map).map(String));
  let enqueued = 0;

  for (const { collectionId, relativeSegments } of collectionsUnderRoot(index, rootId)) {
    if (!relativeSegments.length) continue;
    if (mappedColIds.has(String(collectionId))) continue;

    const col = getById(index, collectionId);
    if (!col) continue;
    const wantTitle = col.title || "";

    // Path already matches current Raindrop titles — record map only.
    const exactLeaf = await resolveExistingMirrorParent(
      relativeSegments,
      config.rootName,
      topRoots
    );
    if (exactLeaf) {
      const node = await getNodeOrNull(exactLeaf);
      if (node && !node.url && node.parentId !== "0") {
        await recordFolderCollection(exactLeaf, collectionId);
        mappedColIds.add(String(collectionId));
      }
      continue;
    }

    const parentFolderId = await resolveMirrorParentFolderId(
      relativeSegments,
      config.rootName,
      topRoots
    );
    if (!parentFolderId) continue;

    const folders = (await getChildren(parentFolderId)).filter((c) => !c.url);
    const titled = folders.find((f) => (f.title || "") === wantTitle);
    if (titled && titled.parentId !== "0") {
      await recordFolderCollection(titled.id, collectionId);
      mappedColIds.add(String(collectionId));
      continue;
    }

    const candidates = [];
    for (const f of folders) {
      if (f.parentId === "0") continue;
      if (rootTitlesEqual(f.title, wantTitle)) continue;
      const existing = map[String(f.id)] ?? (await getFolderCollectionId(f.id));
      if (existing != null) continue;
      if (await isFolderExcluded(f.id, f.parentId, overrides, config.defaultPolicy)) {
        continue;
      }
      candidates.push(f);
    }
    const folder = await pickHealFolderCandidate(candidates, collectionId);
    if (!folder) continue;
    // Never bind/rename the outside-root Raindrop landing zone.
    if (await edgeFolderIsOutsideRootLanding(folder.id)) continue;

    await recordFolderCollection(folder.id, collectionId);
    mappedColIds.add(String(collectionId));
    if ((folder.title || "") === wantTitle) continue;
    if (rootTitlesEqual(folder.title, wantTitle)) continue;

    const added = await queue.enqueueJob({
      id: `ref-${folder.id}`,
      kind: JOB.PULL_RENAME_FOLDER,
      folderId: String(folder.id),
      collectionId: String(collectionId),
      title: wantTitle,
    });
    if (added) enqueued++;
  }

  return enqueued;
}

/**
 * Prefer a unique unmapped sibling; if several, the one whose title still appears
 * on a collectionCache path for this collection id (pre-rename path key).
 * @param {{ id: string, title?: string }[]} candidates
 * @param {string|number} collectionId
 */
async function pickHealFolderCandidate(candidates, collectionId) {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length < 2) return null;
  const cache = await getCollectionCache();
  const hits = [];
  for (const f of candidates) {
    const title = f.title || "";
    if (!title) continue;
    for (const [path, id] of Object.entries(cache || {})) {
      if (String(id) !== String(collectionId)) continue;
      if (path === title || path.endsWith(`/${title}`)) {
        hits.push(f);
        break;
      }
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Edge folder that should contain the leaf collection segment, or null if the
 * parent path is missing / the leaf is an Edge top root (not healable).
 */
async function resolveMirrorParentFolderId(relativeSegments, rootName, topRoots) {
  const segs = relativeSegments || [];
  if (segs.length >= 2) {
    return resolveExistingMirrorParent(segs.slice(0, -1), rootName, topRoots);
  }
  if (segs.length !== 1) return null;
  // Single segment: top-root alias → titles []; loose under-root collection →
  // titles [rootName, leaf] under Other. Never treat Other favorites itself as
  // the parent (that previously made Raindrop/ a false rename candidate).
  const { startId, titles } = await resolveMirrorPlacement(segs, rootName, topRoots);
  if (!titles.length) return null;
  const parentTitles = titles.slice(0, -1);
  if (!parentTitles.length) return startId || null;
  return resolveExistingMirrorParent(parentTitles, rootName, topRoots);
}

/** True when folder sits under Other…/Raindrop/… (outside-root allowlist zone). */
async function edgeFolderIsOutsideRootLanding(folderId) {
  const { segments } = await walkAncestorsFromFolder(folderId, { soft: true });
  return isOutsideRootLandingSegments(segments);
}

/**
 * Probe whether Raindrop still has a non-trashed item for this id.
 * Fail-soft on transient errors (5xx/network): `unknown` so we neither
 * false-delete nor park. Only definite absence (null / 404 / trash) ⇒ gone.
 * @returns {Promise<{ status: 'gone' }|{ status: 'alive', item: object }|{ status: 'unknown' }>}
 */
async function probeLivingRaindrop(client, rid) {
  try {
    const item = await client.getRaindrop(rid);
    if (!item) return { status: "gone" };
    const col = raindropCollectionId(item);
    if (col === RAINDROP_TRASH_COLLECTION_ID || col === String(RAINDROP_TRASH_COLLECTION_ID)) {
      return { status: "gone" };
    }
    return { status: "alive", item };
  } catch (err) {
    if (err instanceof AuthError || err instanceof RateLimitError) throw err;
    if (isNotFoundError(err)) return { status: "gone" };
    return { status: "unknown" };
  }
}

/** True when Raindrop still has a non-trashed item (or probe is inconclusive). */
async function raindropStillAlive(client, rid) {
  const probe = await probeLivingRaindrop(client, rid);
  return probe.status !== "gone";
}
