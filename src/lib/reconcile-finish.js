// Reconcile cycle finish: presence snapshot refresh, stale-id rebind,
// evidence-based Raindrop→Edge deletes, tombstone prune, folder-rename pull.
//
// Presence comes from one Raindrop export per quiet interval (presence.js), not
// per-id GETs. On finish:
//   1. refresh the snapshot if due (heartbeat: reconcile interval; Pull now:
//      always);
//   2. list Raindrop Trash from page 0 (fast soft-delete signal);
//   3. run the rebind pass (pair-rebind.js): stale Edge ids and stale Raindrop
//      ids rebind by URL instead of reading as deletes;
//   4. enqueue delete-edge only for paired ids with a positive signal (in
//      Trash, or absent from a complete snapshot) whose URL no other live
//      raindrop carries. Absence candidates are skipped while migration is
//      partial, the snapshot is incomplete or aged out, or the
//      presenceDeletesEnabled flag is off. Trash candidates enqueue even
//      then; every delete-edge re-runs the survival check at drain time
//      against an export taken after enqueue;
//   5. drop tombstones for ids absent from a complete snapshot (set
//      difference, no GETs).
// A finish is complete when listing is done and, if a refresh was due, the
// snapshot was refreshed. Completed finishes arm quiet-time cooldown, store
// pair health, and drop the v1 pair backup. A due refresh that the wake could
// not afford sets presencePending so the next wake finishes without re-listing.

import {
  JOB,
  MAX_TRASH_PAGES_PER_TICK,
  RAINDROP_LIST_PER_PAGE,
  RAINDROP_TRASH_COLLECTION_ID,
  SOFT_MAX_REQS_PER_WAKE,
  isListPageDone,
  reconcileIntervalMs,
} from "./constants.js";
import { rootTitlesEqual } from "./bookmark-roots.js";
import {
  getTombstones,
  pruneTombstones,
  getFolderCollections,
  getFolderCollectionId,
  clearFolderCollection,
  recordFolderCollection,
  getCollectionCache,
  getReconcileState,
  setReconcileState,
  getStoredPairs,
  pairsView,
  getConfig,
  applyPairChanges,
  dropPairsV1Backup,
  pruneEdgeRemoved,
  setPairHealth,
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
import { ensureAllowlistedOrMirrorAll } from "./reconcile-enqueue.js";
import { writeTrashHygieneSnapshot } from "./trash-hygiene.js";
import { ensurePresence, isUsableForAbsence, isUsableForUrls } from "./presence.js";
import { loadTreeIndex } from "./tree-index.js";
import { rebindPass, rebindLogLines } from "./pair-rebind.js";
import { computePairHealth } from "./pair-health.js";

/**
 * Enqueue a local Edge delete for a raindrop with a positive gone signal.
 * `signal` rides on the job so drain re-applies the matching rules.
 * @param {string} rid
 * @param {string|null} bookmarkId
 * @param {"trash"|"absent"} signal
 * @param {number} signalSeq presence snapshot seq that judged the survival check
 * @param {string} [url] link from the Trash listing (for id-only records)
 * @returns {Promise<boolean>} true when a new job was added
 */
async function enqueueDeleteEdge(rid, bookmarkId, signal, signalSeq, url) {
  return queue.enqueueJob({
    id: `de-${rid}`,
    kind: JOB.DELETE_EDGE,
    raindropId: rid,
    bookmarkId,
    signal,
    // Drain re-checks against a later export than this one.
    signalSeq,
    ...(url ? { url } : {}),
  });
}

/** Raindrop ids with a delete-edge job already queued. */
async function queuedDeleteEdgeIds() {
  const out = new Set();
  for (const j of await queue.list()) {
    if (queue.jobKind(j) === JOB.DELETE_EDGE && j.raindropId != null) {
      out.add(String(j.raindropId));
    }
  }
  return out;
}

/**
 * Finish a completed listing: presence, deletes, folder renames, ensures.
 * @param {{ force?: boolean }} args `force` is Pull now (always refresh presence)
 */
export async function finishReconcileCycle({
  client,
  budget,
  force = false,
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
  const presence = await finishPresenceAndDeletes({ client, budget, force, config });
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
  await markFinish(presence);
  if (enqueued > 0) {
    await appendLog("info", `Pull queued ${enqueued} Raindrop change(s).`);
  }
  return { enqueued, pages, done: true };
}

/**
 * Wake after a finish whose presence refresh was due but unaffordable: refresh
 * and run delete evidence without re-listing.
 */
export async function finishPendingPresence({ client, budget, force = false, config }) {
  const presence = await finishPresenceAndDeletes({ client, budget, force, config });
  await markFinish(presence);
  return { enqueued: 0, pages: 0, done: true, presenceOnly: true };
}

/** Persist cursor reset + completion; completed finishes also run hygiene. */
async function markFinish(presence) {
  const now = Date.now();
  const completed = !presence.due || presence.refreshed;
  await setReconcileState({
    running: false,
    cursorPage: 0,
    outsideCursor: null,
    lastRunAt: now,
    lastError: null,
    presencePending: !completed,
    ...(completed ? { lastSettledAt: now } : {}),
  });
  if (completed) await afterCompletedFinish(presence, now);
}

/**
 * Pair health, v1 backup drop and ledger prune after a completed finish.
 * @param {{ snapshot: import("./presence.js").PresenceSnapshot|null, treeIndex?: import("./tree-index.js").TreeIndex }} presence
 */
async function afterCompletedFinish(presence, now) {
  const stored = await getStoredPairs();
  const treeIndex = presence.treeIndex ?? (await loadTreeIndex());
  await setPairHealth(
    computePairHealth({ records: stored.records, treeIndex, snapshot: presence.snapshot, now })
  );
  if (!stored.migrationPartial && (await dropPairsV1Backup())) {
    await appendLog("info", "Dropped the pre-migration pair backup after a completed check.");
  }
  await pruneEdgeRemoved(now);
}

/**
 * Refresh presence (if due), list Trash, rebind stale ids, enqueue evidence
 * deletes, prune tombstones.
 * @returns {Promise<{ snapshot: import("./presence.js").PresenceSnapshot|null, due: boolean, refreshed: boolean, treeIndex: import("./tree-index.js").TreeIndex }>}
 */
async function finishPresenceAndDeletes({ client, budget, force, config }) {
  const got = await ensurePresence({
    client,
    budget,
    reason: force ? "pull-now" : "heartbeat",
    intervalMs: reconcileIntervalMs(config),
  });
  client.throwIfShouldPause();
  if (got.snapshot && !got.snapshot.complete && got.refreshed) {
    await appendLog(
      "warn",
      `Raindrop export looks incomplete (${got.snapshot.error || "unknown"}); absence-based deletes skipped.`
    );
  }
  const trash = await listTrash(client, budget, "reconcile");
  const treeIndex = await loadTreeIndex();
  await applyDeleteEvidence({
    snapshot: got.snapshot,
    trash,
    treeIndex,
    config,
    source: "reconcile",
  });
  await pruneTombstonesFromSnapshot(got.snapshot);
  return { snapshot: got.snapshot, due: got.due, refreshed: got.refreshed, treeIndex };
}

/**
 * List Raindrop Trash (paged, from page 0). Delete-detection only — never
 * pull-create/update from Trash. Heartbeat shares leftover spendable
 * (≤ MAX_TRASH_PAGES_PER_TICK); Check Trash may use more of the wake.
 * @param {"reconcile"|"check-trash"} source
 * @returns {Promise<{ ids: Set<string>, links: Map<string, string>, scanComplete: boolean, pages: number }>}
 */
async function listTrash(client, budget, source) {
  const ids = new Set();
  const links = new Map();
  const softPageCap =
    source === "check-trash"
      ? Math.max(MAX_TRASH_PAGES_PER_TICK, SOFT_MAX_REQS_PER_WAKE)
      : MAX_TRASH_PAGES_PER_TICK;
  const trashCap = Math.min(softPageCap, budget?.allowance?.() ?? softPageCap);
  let page = 0;
  let pages = 0;
  let scanComplete = false;
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
      ids.add(rid);
      if (item.link) links.set(rid, item.link);
    }
    if (isListPageDone(page, RAINDROP_LIST_PER_PAGE, items, count)) {
      scanComplete = true;
      break;
    }
    page++;
  }
  return { ids, links, scanComplete, pages };
}

/**
 * Rebind stale ids, then enqueue delete-edge for paired ids whose signal holds
 * and whose URL survives nowhere. Writes the trash hygiene snapshot.
 * @param {{
 *   snapshot: import("./presence.js").PresenceSnapshot|null,
 *   trash: { ids: Set<string>, links: Map<string, string>, scanComplete: boolean, pages: number },
 *   treeIndex: import("./tree-index.js").TreeIndex,
 *   config: object,
 *   source: "reconcile"|"check-trash",
 * }} args
 * @returns {Promise<{ pairedPending: string[] }>}
 */
async function applyDeleteEvidence({ snapshot, trash, treeIndex, config, source }) {
  const now = Date.now();
  const stored = await getStoredPairs();
  const urlSnap = isUsableForUrls(snapshot, now) ? snapshot : null;
  const pass = rebindPass({
    records: stored.records,
    treeIndex,
    snapshot: urlSnap,
    urlHints: trash.links,
    now,
  });
  const applied = await applyPairChanges(pass.changes);
  const appliedEdge = new Set(applied.filter((c) => c.type === "edge").map((c) => c.raindropId));
  const appliedRaindrop = new Set(
    applied.filter((c) => c.type === "raindrop").map((c) => c.fromRaindropId)
  );
  for (const line of rebindLogLines({
    edgeRebinds: pass.edgeRebinds.filter((r) => appliedEdge.has(r.raindropId)),
    raindropRebinds: pass.raindropRebinds.filter((r) => appliedRaindrop.has(r.from)),
  })) {
    await appendLog("info", line);
  }

  const pairs = pairsView(await getStoredPairs());
  const tombstones = await getTombstones();
  const queued = await queuedDeleteEdgeIds();
  const candidates = new Set(pass.raindropCandidates);
  const absenceAllowed =
    config.presenceDeletesEnabled !== false && !stored.migrationPartial && !!urlSnap;

  let trashJobs = 0;
  let absentJobs = 0;
  const pairedPending = [];

  for (const rid of trash.ids) {
    const rec = pairs.records[rid];
    if (!rec || tombstones[rid] || queued.has(rid)) continue; // unpaired or already enrolled
    // Trash is a positive signal on its own. With a usable snapshot the pass
    // already ran the survival check (rebound ids are no longer paired here);
    // without one, enqueue anyway — drain re-checks survival against a later
    // export before removing anything.
    if (!urlSnap || candidates.has(rid)) {
      const url = rec.url || trash.links.get(rid);
      if (await enqueueDeleteEdge(rid, rec.bookmarkId, "trash", snapshot?.seq ?? 0, url)) {
        trashJobs++;
      }
      queued.add(rid);
      continue;
    }
    // Paired after the export began: judged on the next pass. Discovery debt
    // behind safe-to-empty until then.
    pairedPending.push(rid);
  }

  if (absenceAllowed) {
    for (const rid of pass.raindropCandidates) {
      const rec = pairs.records[rid];
      if (!rec || trash.ids.has(rid) || tombstones[rid] || queued.has(rid)) continue;
      if (await enqueueDeleteEdge(rid, rec.bookmarkId, "absent", urlSnap.seq, rec.url)) {
        absentJobs++;
      }
      queued.add(rid);
    }
  }

  if (trashJobs > 0) {
    await appendLog(
      "info",
      `Pull queued ${trashJobs} local delete(s) for raindrops found in Trash.`
    );
  }
  if (absentJobs > 0) {
    await appendLog(
      "info",
      `Pull queued ${absentJobs} local delete(s) for raindrops gone from Raindrop (no other copy of the URL).`
    );
  }

  // Heartbeat truncated peeks only enroll — don't thrash Status to "partial".
  if (trash.pages > 0 && (source === "check-trash" || trash.scanComplete)) {
    let pendingIds = pairedPending;
    if (!trash.scanComplete) {
      // A partial scan restarts at page 0 and may not reach ids an earlier
      // partial scan found; keep those that still need enroll.
      const prev = (await getReconcileState()).trashPendingIds || [];
      const carry = prev.filter(
        (rid) => pairs.records[rid] && !tombstones[rid] && !queued.has(rid)
      );
      pendingIds = [...new Set([...pairedPending, ...carry])];
    }
    await writeTrashHygieneSnapshot({
      scanComplete: trash.scanComplete,
      pendingIds,
      source,
    });
  }
  return { pairedPending };
}

/**
 * Tombstones for ids absent from a complete snapshot are stale (the raindrop
 * is gone for good). Tombstones for present ids (offload) are kept.
 */
async function pruneTombstonesFromSnapshot(snapshot) {
  if (!isUsableForAbsence(snapshot)) return;
  const absent = Object.keys(await getTombstones()).filter((rid) => !snapshot.ids.has(rid));
  if (!absent.length) return;
  await pruneTombstones(absent);
  await appendLog("info", `Pruned ${absent.length} stale tombstone(s).`);
}

/**
 * Check Trash (Options Status): list Trash from page 0, enroll paired deletes,
 * refresh the hygiene snapshot. Does not run a full reconcile listing.
 * @param {{
 *   client: import("./raindrop.js").RaindropClient,
 *   budget?: import("./wake-budget.js").WakeBudget|null,
 * }} opts
 * @returns {Promise<{ handled: number, scanComplete: boolean, pairedPending: number }>}
 */
export async function runTrashHygienePeek({ client, budget }) {
  const config = await getConfig();
  const got = await ensurePresence({ client, budget, reason: "on-demand" });
  client.throwIfShouldPause();
  const trash = await listTrash(client, budget, "check-trash");
  if (trash.pages > 0) {
    await applyDeleteEvidence({
      snapshot: got.snapshot,
      trash,
      treeIndex: await loadTreeIndex(),
      config,
      source: "check-trash",
    });
  }
  const state = await getReconcileState();
  return {
    handled: 0,
    scanComplete: !!state.trashScanComplete,
    pairedPending: Number(state.trashPairedPending) || 0,
  };
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
    enqueued += await healUnmappedFolderCollections(index, rootId, config, overrides, topRoots);
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
