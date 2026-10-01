// Durable queue job processors (upload, pull, delete, folder rename).
// Invoked only from drain.js. Confirm-before-act and suppress rules live here.
//
// Reclaim before every create: an upload with no pair looks up its URL in the
// presence snapshot (or one Raindrop search when the snapshot is stale and
// cannot be refreshed) and binds to a claimable existing raindrop instead of
// creating a copy. createAttemptedAt / pullCreateAttemptedAt still mark
// in-flight creates so a SW death between the side effect and recordSynced
// reclaims on retry; a snapshot older than the marker cannot see that create,
// so marked jobs search. Same pattern as offloadRaindropId for offload.
//
// Deletes need evidence plus a failed survival check (delete-evidence spec):
//   delete-raindrop  onRemoved payload (ledger) and no other copy of the URL in
//                    the synced scope; a surviving copy rebinds the pair.
//   delete-edge      Trash or snapshot absence, re-checked here against the
//                    current snapshot; a surviving raindrop rebinds the pair.

import { POLICY, JOB, SYNC_MODE, RAINDROP_FOLDER_MODE, ABSOLUTE_ROOT_ID } from "./constants.js";
import {
  getCollectionCache,
  cacheCollection,
  uncacheCollection,
  rewriteCollectionCacheForRename,
  recordFolderCollection,
  getFolderCollectionId,
  clearFolderCollection,
  recordSynced,
  getRaindropId,
  getBookmarkIdForRaindrop,
  getPairs,
  forgetSynced,
  forgetPairByRaindrop,
  getPairRecord,
  getStoredPairs,
  applyPairChanges,
  getEdgeRemoved,
  removeEdgeRemoved,
  clearPairWithTombstone,
  addTombstone,
  hasTombstone,
  suppressRemove,
  suppressCreate,
  expectExtensionCreate,
  noteExtensionCreate,
  abortExtensionCreate,
  releaseExtensionCreate,
  suppressChange,
  appendLog,
  noteDeleteExecuted,
} from "./store.js";
import * as queue from "./queue.js";
import {
  getNode,
  getNodeOrNull,
  getChildren,
  removeNode,
  removeFolder,
  resolveLocation,
  createBookmark,
  updateBookmark,
  moveBookmark,
  resolveEdgeParentForMirror,
  getTopRoots,
  mirrorPathExists,
  ancestorIdsFromFolder,
  walkAncestorsFromFolder,
  renamableFolder,
} from "./bookmarks.js";
import { resolvePolicy, isExcluded } from "./policy.js";
import { isNotFoundError, AuthError, RateLimitError } from "./raindrop.js";
import {
  ensureCollectionPath,
  findRootCollection,
  collectionIdFromRelative,
  isUnderRoot,
  raindropUploadSegments,
  recordFolderCollectionsAlongPath,
  recordFolderCollectionsForPulledPath,
  applyCollectionTitleInIndex,
  isOutsideRootContainer,
} from "./collections.js";
import { canCreateRaindropOnlyPath } from "./allowlist.js";
import { computePullUpdatePlan } from "./pull-update.js";
import { filterUrlMatchingItems, pickMoveRebindCandidate } from "./move-rebind.js";
import { pickUrlMatches, primaryUrlKey, urlMatchKind } from "./url-match.js";
import { PRESENCE_STALE_MS } from "./constants.js";
import { ensurePresence, isUsableForUrls, resolveIdsForUrl } from "./presence.js";
import { loadTreeIndex, treeEntriesByDateAdded } from "./tree-index.js";
import {
  edgeSurvivorCandidates,
  isDifferentBookmark,
  isPairBookmarkLive,
  livePairBookmarkIds,
  placementFromEntry,
  rebindStaleEdgeId,
  rebindStaleRaindropId,
} from "./pair-rebind.js";

/** Job kinds that run in one-way mode (Edge→Raindrop). */
const ONE_WAY_KINDS = new Set([JOB.UPLOAD, JOB.RENAME_COLLECTION]);

export async function processJob(job, ctx) {
  const kind = queue.jobKind(job);
  const bidirectional = ctx.config.syncMode === SYNC_MODE.BIDIRECTIONAL;

  // Bidirectional-only jobs are no-ops in one-way mode; upload + folder rename
  // still run (Edge→Raindrop).
  if (!bidirectional && !ONE_WAY_KINDS.has(kind)) {
    await queue.remove(job.id);
    return;
  }

  switch (kind) {
    case JOB.PULL_CREATE:
      await processPullCreate(job, ctx);
      break;
    case JOB.PULL_UPDATE:
      await processPullUpdate(job, ctx);
      break;
    case JOB.PULL_RENAME_FOLDER:
      await processPullRenameFolder(job, ctx);
      break;
    case JOB.DELETE_RAINDROP:
      await processDeleteRaindrop(job, ctx);
      break;
    case JOB.DELETE_EDGE:
      await processDeleteEdge(job, ctx);
      break;
    case JOB.RENAME_COLLECTION:
      await processRenameCollection(job, ctx);
      break;
    case JOB.UPLOAD:
    default:
      await processUpload(job, ctx);
      break;
  }
}

/**
 * Pick a claimable raindrop id among URL matches for an unpaired bookmark.
 * A match paired to another *live* bookmark is a conflict; one paired to a
 * gone bookmark is claimable.
 * @param {string} bookmarkId
 * @param {string[]} rids URL-matching raindrop ids
 * @param {Set<string>} [liveRaindropIds] snapshot ids (forward-link staleness)
 * @returns {Promise<{ kind: 'unique'|'multi'|'conflict'|'none', rid?: string, extras: number }>}
 */
async function pickClaimable(bookmarkId, rids, liveRaindropIds) {
  if (!rids.length) return { kind: "none", extras: 0 };
  const pairs = await getPairs();
  const pending = await queue.pendingUploadIds();
  const liveIds = new Set([String(bookmarkId)]);
  for (const rid of rids) {
    const otherBid = pairs.byRaindrop?.[String(rid)];
    if (otherBid == null) continue;
    const other = await getNodeOrNull(String(otherBid));
    if (isPairBookmarkLive(pairs.records[String(rid)], other, pending)) {
      liveIds.add(String(otherBid));
    }
  }
  const items = rids.map((rid) => ({ _id: rid }));
  const pick = pickMoveRebindCandidate(bookmarkId, items, pairs, liveIds, liveRaindropIds);
  if (pick.kind === "none" || pick.kind === "conflict") {
    return { kind: pick.kind, extras: 0 };
  }
  return { kind: pick.kind, rid: pick.rid, extras: pick.extras || 0 };
}

/**
 * Find an existing raindrop for this URL before creating one. Snapshot first
 * (free when fresh); one search when the snapshot is stale and cannot be
 * refreshed, or predates this job's createAttemptedAt (it cannot see a create
 * that a crashed drain already sent).
 * @param {{ id: string, createAttemptedAt?: number }} job
 * @param {string} url
 * @param {{ client: import("./raindrop.js").RaindropClient, budget?: import("./wake-budget.js").WakeBudget|null }} ctx
 * @returns {Promise<{ kind: string, rid?: string, extras: number, linkMatch: 'exact'|'loose'|'none' }>}
 */
async function tryReclaimRaindropByUrl(job, url, ctx) {
  const { client, budget } = ctx;
  const snapshot = await ensurePresenceOrNull({ client, budget, reason: "on-demand" });
  const now = Date.now();
  const fresh =
    isUsableForUrls(snapshot, now) &&
    now - snapshot.at < PRESENCE_STALE_MS &&
    (job.createAttemptedAt == null || snapshot.at > job.createAttemptedAt);
  if (fresh) {
    // Raindrops this engine paired after the export began are live too; the
    // snapshot just cannot see them yet. Pair records carry the exact key only.
    const pairs = await getPairs();
    const exactKey = primaryUrlKey(url);
    const recent = (pairs.byUrlKey[exactKey] || []).filter((rid) => {
      const seen = pairs.records[rid]?.lastSeenRaindropAt;
      return seen != null && seen >= snapshot.at;
    });
    const known = new Set([...snapshot.ids, ...recent]);
    const resolved = resolveIdsForUrl(snapshot, url);
    // An exact hit from either source outranks a loose snapshot hit.
    const exact = resolved.match === "exact" || recent.length > 0;
    const rids = exact
      ? [...new Set([...(resolved.match === "exact" ? resolved.ids : []), ...recent])]
      : resolved.ids;
    const pick = await pickClaimable(job.id, rids, known);
    return { ...pick, linkMatch: !pick.rid ? "none" : exact ? "exact" : resolved.match };
  }
  const { items } = await client.searchRaindrops(url);
  const matching = filterUrlMatchingItems(url, items);
  const pick = await pickClaimable(
    job.id,
    matching.map((item) => String(item._id))
  );
  let linkMatch = "none";
  if (pick.rid) {
    const hit = matching.find((item) => String(item._id) === pick.rid);
    linkMatch = urlMatchKind(url, hit?.link || "") || "none";
  }
  return { ...pick, linkMatch };
}

/**
 * Pair-record metadata for an Edge bookmark synced into `collectionId`.
 * @param {{ url?: string, title?: string, parentId?: string }} node
 * @param {string[]} segments folder titles, top root first
 * @param {string|number|null} collectionId
 */
function edgeMeta(node, segments, collectionId) {
  return {
    url: node.url ?? null,
    title: node.title ?? null,
    collectionId: collectionId ?? null,
    edgeParentId: node.parentId ?? null,
    edgePathAtSync: segments ?? null,
    dateAdded: node.dateAdded ?? null,
  };
}

/**
 * Apply a URL reclaim: record pair, optionally log extras, update Edge-owned fields.
 * Never rewrites `link` on a loose (tracking-param) match — that would attach
 * tags/notes from an unrelated raindrop to a different URL.
 * @returns {Promise<string|null>} raindrop id, or null if update 404'd
 */
async function applyReclaimedRaindrop(
  job,
  node,
  rid,
  extras,
  collectionId,
  pathLabel,
  client,
  segments,
  linkMatch = "exact"
) {
  await recordSynced(job.id, rid, edgeMeta(node, segments, collectionId));
  if (extras > 0) {
    await appendLog(
      "warn",
      `Reclaimed with ${extras} extra Raindrop copy(ies) left: ${node.title || node.url}`
    );
  }
  try {
    /** @type {{ title: string, collectionId: *, link?: string }} */
    const patch = { title: node.title, collectionId };
    if (linkMatch !== "loose") patch.link = node.url;
    await client.updateRaindrop(rid, patch);
    if (job.reason === "move") {
      await appendLog("info", `Moved: ${node.title || node.url} → ${pathLabel}`);
    } else {
      await appendLog("info", `Synced (existing raindrop): ${node.title || node.url}`);
    }
    return rid;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    await forgetPairByRaindrop(rid);
    return null;
  }
}

/**
 * Re-queue an upload under the id its bookmark (job.dateAdded) holds now.
 * Crash-safety markers (offloadRaindropId, createAttemptedAt) travel with it
 * so a restarted offload still finishes on the right bookmark.
 * @returns {Promise<boolean>} false when that bookmark is gone or ambiguous
 *   (the job is left in place for the caller to finish or drop)
 */
async function retargetUpload(job) {
  const matches = treeEntriesByDateAdded(await loadTreeIndex(), job.dateAdded);
  if (matches.length !== 1) return false;
  const to = matches[0].id;
  await queue.remove(job.id);
  await queue.enqueue(to, {
    ...(job.reason ? { reason: job.reason } : {}),
    dateAdded: job.dateAdded,
  });
  const markers = {};
  if (job.offloadRaindropId != null) markers.offloadRaindropId = job.offloadRaindropId;
  if (job.createAttemptedAt != null) markers.createAttemptedAt = job.createAttemptedAt;
  if (Object.keys(markers).length) await queue.patchJob(to, markers);
  await appendLog("info", `Queued upload moved from id ${job.id} to ${to} (bookmark ids changed).`);
  return true;
}

/**
 * The pair `rid` is bound to `node.id` but `node` is another bookmark. Rebind
 * the pair to its own bookmark by dateAdded (strict: never a URL copy). When
 * that bookmark's id is held by a pair that is itself on the wrong bookmark
 * (ids swapped), move both in one batch. Longer chains are left to
 * reconcile's rebind pass.
 * @returns {Promise<boolean>} whether the pair moved off `node.id`
 */
async function rehomePair(rid, node) {
  const treeIndex = await loadTreeIndex();
  const pairs = await getPairs();
  const now = Date.now();
  const changes = [];
  const plan = (r) => {
    const rec = pairs.records[r];
    const hit = rec ? rebindStaleEdgeId(rec, treeIndex, pairs, { strict: true }) : null;
    if (!hit || hit.entry.id === String(rec.bookmarkId)) return null;
    changes.push({
      type: "edge",
      raindropId: r,
      fromBookmarkId: rec.bookmarkId,
      record: { ...rec, ...placementFromEntry(hit.entry), lastSeenEdgeAt: now },
    });
    return hit.entry.id;
  };
  const to = plan(rid);
  const holder = to != null ? pairs.byBookmark[to] : null;
  if (holder != null && holder !== rid) plan(holder);
  const applied = changes.length ? await applyPairChanges(changes) : [];
  const record = pairs.records[rid];
  const label = record?.title || record?.url || rid;
  if (applied.some((c) => c.raindropId === rid)) {
    await appendLog("info", `Rebound: ${label} (Edge id changed from ${node.id} to ${to}).`);
    return true;
  }
  await appendLog(
    "warn",
    `Bookmark ${node.id} is no longer ${label} (ids changed); not writing it onto that raindrop.`
  );
  return false;
}

async function processUpload(job, ctx) {
  const { client, config, overrides, cache, getIndex } = ctx;

  let node;
  try {
    node = await getNode(job.id);
  } catch {
    // Nothing at this id. The bookmark may hold another id now (renumber);
    // otherwise it is gone: finish a stashed offload's tombstone, else the
    // upload target disappeared (user delete) and the job has nothing to do.
    if (typeof job.dateAdded === "number" && (await retargetUpload(job))) return;
    await finishInterruptedOffload(job);
    return;
  }

  // Queued for another bookmark: ids were reassigned since. Send the job to
  // where that bookmark is now; the one at this id did not change. This runs
  // before the offload branch so a restarted offload never deletes whatever
  // bookmark holds the old id now.
  if (typeof job.dateAdded === "number" && job.dateAdded !== node.dateAdded) {
    if (!(await retargetUpload(job))) await finishInterruptedOffload(job);
    return;
  }

  if (!node.url) {
    await queue.remove(job.id);
    return;
  }

  // Restarted offload: raindrop id was persisted before the local delete.
  // Do not create again — the pair may still point at this bookmark.
  if (job.offloadRaindropId != null) {
    await completeOffload(job, node, ctx, String(job.offloadRaindropId));
    return;
  }

  // Destination-folder policy (current parent after create, move, or change).
  const { segments, ancestorIds } = await resolveLocation(node);
  const effective = resolvePolicy(ancestorIds, overrides, config.defaultPolicy);

  if (isExcluded(ancestorIds, overrides, config.defaultPolicy)) {
    await queue.remove(job.id);
    return;
  }

  const index = await getIndex();
  // Other favorites / Raindrop / … → account-level collection path; else under sync root.
  const fullSegments = raindropUploadSegments(segments, config.rootName);
  const collectionId = await ensureCollectionPath(
    client,
    index,
    fullSegments,
    cache,
    cacheCollection,
    uncacheCollection
  );
  await recordFolderCollectionsAlongPath(
    segments,
    ancestorIds,
    fullSegments,
    cache,
    recordFolderCollection
  );
  const pathLabel = fullSegments.join("/");

  let rid = await getRaindropId(job.id);

  // The pair at this id belongs to another bookmark (ids reassigned): never
  // write this bookmark onto its raindrop. Move that pair to its bookmark if
  // it can be found; this one then uploads unpaired (reclaim by URL first).
  if (rid && isDifferentBookmark(await getPairRecord(rid), node)) {
    const moved = await rehomePair(rid, node);
    // Moved: whatever pair is at this id now (a swap brings this bookmark's
    // own). Not moved: upload unpaired rather than onto the wrong raindrop.
    rid = moved ? ((await getRaindropId(job.id)) ?? null) : null;
    if (rid && isDifferentBookmark(await getPairRecord(rid), node)) rid = null;
  }

  if (rid) {
    try {
      await client.updateRaindrop(rid, {
        link: node.url,
        title: node.title,
        collectionId,
      });
      await recordSynced(job.id, rid, edgeMeta(node, segments, collectionId));
      if (job.reason === "move") {
        await appendLog("info", `Moved: ${node.title || node.url} → ${pathLabel}`);
      } else {
        await appendLog("info", `Updated: ${node.title || node.url}`);
      }
    } catch (err) {
      // Stale pair: raindrop gone — clear mapping; move may rebind by URL below.
      if (!isNotFoundError(err)) throw err;
      await forgetPairByRaindrop(rid);
      rid = null;
    }
  }

  // Every unpaired upload reclaims by URL before creating, whatever its
  // reason: an Import after Chromium renumbered ids must bind, not fork.
  if (!rid) {
    const rebound = await tryReclaimRaindropByUrl(job, node.url, ctx);
    // Move conflict (every match owned by another live bookmark) drops; a
    // plain create in conflict creates — two bookmarks, two raindrops.
    if (rebound.kind === "conflict" && job.reason === "move") {
      await appendLog(
        "warn",
        `Skipped move create (URL already paired elsewhere): ${node.title || node.url}`
      );
      await queue.remove(job.id);
      return;
    }
    if (rebound.rid) {
      rid = await applyReclaimedRaindrop(
        job,
        node,
        rebound.rid,
        rebound.extras || 0,
        collectionId,
        pathLabel,
        client,
        segments,
        rebound.linkMatch || "exact"
      );
    }
  }

  // Create: stash intent before the POST so a SW death between create and
  // recordSynced reclaims the orphan on retry instead of duplicating.
  if (!rid) {
    await queue.patchJob(job.id, { createAttemptedAt: Date.now() });
    const item = await client.createRaindrop({
      link: node.url,
      title: node.title,
      collectionId,
    });
    await recordSynced(job.id, item._id, edgeMeta(node, segments, collectionId));
    rid = String(item._id);
    await appendLog("info", `Synced: ${node.title || node.url}`);
  }

  if (effective === POLICY.SYNC_DELETE) {
    const offloadRid = rid || (await getRaindropId(job.id));
    if (offloadRid) {
      await completeOffload(job, node, ctx, String(offloadRid));
      return;
    }
    const parentId = node.parentId;
    await suppressRemove(job.id);
    await removeNode(job.id);
    await forgetSynced(job.id);
    if (config.pruneEmpty) await pruneIfEmpty(parentId, config, overrides);
  }

  await queue.remove(job.id);
}

/**
 * Offload: persist the raindrop id, write the tombstone, then delete Edge.
 * The pair stays until after the local delete so a retry while the bookmark
 * still exists updates instead of creating a second raindrop.
 * @param {object} job
 * @param {{ parentId?: string }} node
 * @param {{ config: object, overrides: object }} ctx
 * @param {string} offloadRid
 */
async function completeOffload(job, node, ctx, offloadRid) {
  const { config, overrides } = ctx;
  const parentId = node.parentId;
  await queue.patchJob(job.id, { offloadRaindropId: offloadRid });
  await addTombstone(offloadRid, "edge-offload");
  // Suppress so onRemoved does not enqueue a Raindrop delete in bidirectional mode.
  await suppressRemove(job.id);
  await removeNode(job.id);
  await forgetPairByRaindrop(offloadRid);
  if (config.pruneEmpty) await pruneIfEmpty(parentId, config, overrides);
  await queue.remove(job.id);
}

/**
 * Bookmark missing on retry. Finish an in-progress offload if the job stashed
 * a raindrop id; otherwise drop the upload.
 * @param {{ id: string, offloadRaindropId?: string }} job
 */
async function finishInterruptedOffload(job) {
  const rid = job.offloadRaindropId != null ? String(job.offloadRaindropId) : null;
  if (rid) await clearPairWithTombstone(rid, "edge-offload");
  await queue.remove(job.id);
}

/**
 * In-place Raindrop collection rename for a mapped Edge folder.
 */
async function processRenameCollection(job, ctx) {
  const { client, config, overrides, cache, getIndex } = ctx;
  const folderId = job.folderId != null ? String(job.folderId) : String(job.id).replace(/^rc-/, "");

  const gate = await renamableFolder(folderId, overrides, config.defaultPolicy);
  if (!gate.node) {
    if (gate.gone) await clearFolderCollection(folderId);
    await queue.remove(job.id);
    return;
  }
  const { node } = gate;

  // Entry must have been recorded from this folder (dateAdded), not from
  // whatever folder held the id before a renumber.
  const collectionId = await getFolderCollectionId(folderId, node);
  if (collectionId == null) {
    await queue.remove(job.id);
    return;
  }

  try {
    await client.updateCollection(collectionId, { title: node.title });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    await clearFolderCollection(folderId);
    await queue.remove(job.id);
    return;
  }

  await refreshCacheAfterRename(cache, collectionId, node.title, getIndex);

  await appendLog("info", `Renamed folder: ${node.title}`);
  await queue.remove(job.id);
}

/**
 * After a collection rename: rewrite path cache in storage, refresh the in-drain
 * cache object, and update the live collection index title.
 */
async function refreshCacheAfterRename(cache, collectionId, newTitle, getIndex) {
  await rewriteCollectionCacheForRename(collectionId, newTitle);
  const fresh = await getCollectionCache();
  for (const key of Object.keys(cache)) delete cache[key];
  Object.assign(cache, fresh);
  const index = await getIndex();
  applyCollectionTitleInIndex(index, collectionId, newTitle);
}

async function processPullCreate(job, ctx) {
  const { config, getIndex } = ctx;
  const rid = String(job.raindropId);

  // Already paired (e.g. raced with upload).
  if (await getBookmarkIdForRaindrop(rid)) {
    await queue.remove(job.id);
    return;
  }
  // Stale durable jobs must not resurrect after a confirmed or in-flight delete.
  if (await hasTombstone(rid)) {
    await queue.remove(job.id);
    await appendLog("info", `Skipped pull for tombstoned raindrop ${rid}.`);
    return;
  }
  if (await hasPendingDeleteForRaindrop(rid)) {
    await queue.remove(job.id);
    await appendLog("info", `Skipped pull; delete already queued for raindrop ${rid}.`);
    return;
  }
  if (!job.link) {
    await queue.remove(job.id);
    return;
  }

  const relative = job.relativeSegments || [];
  const folderMode = config.raindropFolderMode || RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED;
  const allowlist = config.raindropFolderAllowlist || {};
  const edgeExists = await mirrorPathExists(relative, config.rootName);

  let index = null;
  let rootId = null;
  let collectionId = job.collectionId ?? null;
  if (!edgeExists) {
    index = await getIndex();
    const root = findRootCollection(index, config.rootName);
    rootId = root?._id ?? null;
    // Legacy pull jobs (pre-allowlist) omit collectionId — resolve from path.
    if (collectionId == null && rootId != null && relative.length) {
      collectionId = collectionIdFromRelative(index, rootId, relative);
    }
  }

  if (
    !canCreateRaindropOnlyPath({
      allowlist,
      collectionId,
      index,
      rootId,
      edgePathExists: edgeExists,
      folderMode,
    })
  ) {
    await queue.remove(job.id);
    const pathLabel = relative.length ? relative.join("/") : "(root)";
    await appendLog("info", `Skipped pull: path not allowed (${pathLabel}).`);
    return;
  }

  const parentId = await resolveEdgeParentForMirror(relative, config.rootName);
  const placement = { getIndex, index, rootId, collectionId, relative, rootName: config.rootName };

  // Crash recovery: prior drain may have created the Edge bookmark without
  // recording the pair. Reclaim instead of creating a duplicate.
  if (job.pullCreateAttemptedAt != null) {
    const orphan = await findUnpairedPullCreateOrphan(parentId, job.link, rid);
    if (orphan) {
      await suppressCreate(orphan.id);
      await finishPulledBookmark(orphan, job, rid, placement);
      return;
    }
  }

  // Intent before createBookmark so a SW death between create and recordSynced
  // can reclaim the orphan on retry.
  await queue.patchJob(job.id, { pullCreateAttemptedAt: Date.now() });

  expectExtensionCreate(job.link);
  let node;
  try {
    node = await createBookmark({
      parentId,
      title: job.title || job.link,
      url: job.link,
    });
    // Sync, before any other await, so onCreated that lost the race still sees the id.
    noteExtensionCreate(node.id);
  } catch (err) {
    abortExtensionCreate();
    throw err;
  }
  await suppressCreate(node.id);
  releaseExtensionCreate(node.id);
  await finishPulledBookmark(node, job, rid, placement);
}

/**
 * Pair-record metadata for a pulled (Raindrop→Edge) bookmark.
 * @param {{ url?: string, title?: string, parentId?: string }} node
 * @param {{ link?: string, title?: string }} job
 * @param {string|number|null} collectionId
 */
async function pulledMeta(node, job, collectionId) {
  const { segments } = node.parentId
    ? await walkAncestorsFromFolder(String(node.parentId), { soft: true })
    : { segments: [] };
  return edgeMeta(
    { ...node, url: node.url || job.link, title: node.title || job.title },
    segments,
    collectionId
  );
}

/**
 * Presence snapshot for a drain-time decision, or null when the export is
 * unavailable. Auth and rate-limit errors still propagate to the drain gate.
 */
async function ensurePresenceOrNull(opts) {
  try {
    return (await ensurePresence(opts)).snapshot;
  } catch (err) {
    if (err instanceof AuthError || err instanceof RateLimitError) throw err;
    return null;
  }
}

/**
 * Record a pulled Edge bookmark's pair and folder→collection mapping, then
 * finish the job. Shared by the fresh create and the crash-orphan reclaim.
 */
async function finishPulledBookmark(node, job, rid, placement) {
  const { getIndex, index, rootId, collectionId, relative, rootName } = placement;
  await recordSynced(node.id, rid, await pulledMeta(node, job, collectionId));
  // Learn folder→collection so later Raindrop renames can pull-rename in place.
  await recordPulledFolderCollections({
    getIndex,
    index,
    rootId,
    collectionId,
    relative,
    rootName,
    edgeLeafFolderId: node.parentId,
  });
  await appendLog("info", `Pulled: ${job.title || job.link}`);
  await queue.remove(job.id);
}

/**
 * Find an Edge bookmark under parent matching link that is unpaired (or already
 * this raindrop) — left behind when pull-create was interrupted after createBookmark.
 * @param {string} parentId
 * @param {string} link
 * @param {string} raindropId
 * @returns {Promise<{ id: string, parentId?: string, url?: string, title?: string }|null>}
 */
async function findUnpairedPullCreateOrphan(parentId, link, raindropId) {
  const unclaimed = [];
  for (const child of await getChildren(parentId)) {
    if (!child?.url || !child.id || !urlMatchKind(link, child.url)) continue;
    const existingRid = await getRaindropId(child.id);
    if (existingRid != null && existingRid !== String(raindropId)) continue;
    unclaimed.push(child);
  }
  return pickUrlMatches(link, unclaimed, (child) => child.url)[0] ?? null;
}

/**
 * Best-effort folderCollections write after pull-create / pull-update placement.
 * Missing index/collectionId is a no-op — bookmark sync already succeeded.
 */
async function recordPulledFolderCollections({
  getIndex,
  index: indexIn,
  rootId: rootIdIn,
  collectionId: collectionIdIn,
  relative,
  rootName,
  edgeLeafFolderId,
}) {
  if (!edgeLeafFolderId || edgeLeafFolderId === ABSOLUTE_ROOT_ID || !(relative || []).length)
    return;
  try {
    const index = indexIn || (await getIndex());
    const root = rootIdIn != null ? { _id: rootIdIn } : findRootCollection(index, rootName);
    const rootId = root?._id ?? null;
    let collectionId = collectionIdIn ?? null;
    if (collectionId == null && rootId != null) {
      collectionId = collectionIdFromRelative(index, rootId, relative);
    }
    if (collectionId == null) return;
    const ancestors = await ancestorIdsFromFolder(edgeLeafFolderId);
    await recordFolderCollectionsForPulledPath(
      index,
      rootId,
      collectionId,
      relative,
      ancestors,
      recordFolderCollection
    );
    // Warm path cache so rename-heal can disambiguate siblings without a map.
    const path = isUnderRoot(index, collectionId, rootId)
      ? [rootName, ...relative].join("/")
      : isOutsideRootContainer(relative[0])
        ? relative.slice(1).join("/")
        : relative.join("/");
    if (path) await cacheCollection(path, collectionId);
  } catch {
    // Pairing already done; rename pull can still no-op until a later upload maps.
  }
}

/**
 * Apply Raindrop title/URL/placement onto an existing paired Edge bookmark.
 * Suppresses onMoved/onChanged so the update does not echo Edge→Raindrop.
 * Placement moves that would create missing Edge folders honor the same
 * existing-only / allowlist gate as pull-create; title/URL still apply.
 */
async function processPullUpdate(job, ctx) {
  const { config, overrides, getIndex } = ctx;
  const bookmarkId = job.bookmarkId != null ? String(job.bookmarkId) : null;
  const rid = job.raindropId != null ? String(job.raindropId) : null;

  if (!bookmarkId || !rid || !job.link) {
    await queue.remove(job.id);
    return;
  }
  if (await hasTombstone(rid)) {
    await queue.remove(job.id);
    return;
  }
  // Pair must still point at this bookmark (upload race / delete).
  if ((await getBookmarkIdForRaindrop(rid)) !== bookmarkId) {
    await queue.remove(job.id);
    return;
  }

  const node = await getNodeOrNull(bookmarkId);
  if (!node?.url) {
    await queue.remove(job.id);
    return;
  }
  // After a renumber the id can hold an unrelated bookmark: never rewrite it.
  // Reconcile rebinds the pair by URL; the next listing re-enqueues the update.
  const pending = await queue.pendingUploadIds();
  if (!isPairBookmarkLive(await getPairRecord(rid), node, pending)) {
    await appendLog(
      "warn",
      `Skipped Raindrop→Edge update for ${job.title || job.link}: bookmark ${bookmarkId} ` +
        "now holds a different URL (ids renumbered?)."
    );
    await queue.remove(job.id);
    return;
  }

  const relative = job.relativeSegments || [];
  const index = await getIndex();
  const root = findRootCollection(index, config.rootName);
  const topRoots = await getTopRoots();
  const plan = await computePullUpdatePlan({
    node,
    wantTitle: job.title || job.link,
    wantLink: job.link,
    relative,
    rootName: config.rootName,
    topRoots,
    collectionId: job.collectionId,
    allowlist: config.raindropFolderAllowlist || {},
    folderMode: config.raindropFolderMode || RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    index,
    rootId: root?._id ?? null,
    overrides,
    defaultPolicy: config.defaultPolicy,
  });

  if (plan.skip) {
    await queue.remove(job.id);
    return;
  }

  let targetParent = plan.existingParent;
  if (targetParent == null && plan.shouldCreatePath) {
    targetParent = await resolveEdgeParentForMirror(relative, config.rootName, topRoots);
  }

  const { titleDiff, urlDiff, wantTitle, wantLink } = plan;

  await suppressChange(bookmarkId);

  if (titleDiff || urlDiff) {
    await updateBookmark(bookmarkId, {
      ...(titleDiff ? { title: wantTitle } : {}),
      ...(urlDiff ? { url: wantLink } : {}),
    });
  }

  if (targetParent != null && String(node.parentId) !== String(targetParent)) {
    await suppressChange(bookmarkId); // move may fire separately from update
    const fromParentId = node.parentId != null ? String(node.parentId) : "";
    const toParentId = String(targetParent);
    const fromParent = fromParentId ? await getNodeOrNull(fromParentId) : null;
    const toParent = await getNodeOrNull(toParentId);
    const pathLabel = (relative || []).join("/") || "(root)";
    await moveBookmark(bookmarkId, { parentId: targetParent });
    // from→to + Raindrop path: diagnose non-convergent pull-move loops (same
    // title every cycle) without guessing whether parentDiff was real.
    await appendLog(
      "info",
      `Pulled move: ${wantTitle || wantLink} (${fromParentId || "?"}${
        fromParent?.title ? `:${fromParent.title}` : ""
      } → ${toParentId}${toParent?.title ? `:${toParent.title}` : ""}; ` +
        `raindrop ${pathLabel}` +
        (job.collectionId != null ? ` #${job.collectionId}` : "") +
        `)`
    );
    const after = await getNodeOrNull(bookmarkId);
    if (after && String(after.parentId) !== toParentId) {
      await appendLog(
        "warn",
        `Pulled move did not stick for ${wantTitle || wantLink}: ` +
          `wanted parent ${toParentId}, now ${after.parentId}`
      );
    }
  } else if (titleDiff || urlDiff) {
    await appendLog("info", `Pulled update: ${wantTitle || wantLink}`);
  }

  // Learn/refresh folder→collection on every applied pull-update so folders that
  // were pulled before mapping existed still gain rename sync after any edit.
  const mapLeaf = targetParent ?? plan.existingParent ?? node.parentId;
  if (mapLeaf) {
    await recordPulledFolderCollections({
      getIndex,
      index,
      rootId: root?._id ?? null,
      collectionId: job.collectionId,
      relative,
      rootName: config.rootName,
      edgeLeafFolderId: mapLeaf,
    });
  }

  // Keep the pair's URL and placement in step with what was just written:
  // a bookmark counts as the pair's only while its URL matches the record.
  const applied = await getNodeOrNull(bookmarkId);
  if (applied?.url) {
    await recordSynced(bookmarkId, rid, await pulledMeta(applied, job, job.collectionId));
  }

  await queue.remove(job.id);
}

/**
 * Apply a Raindrop collection title onto the mapped Edge folder (in place).
 * Skips Edge top roots (parentId "0"). Suppresses onChanged echo.
 */
async function processPullRenameFolder(job, ctx) {
  const { config, overrides, cache, getIndex } = ctx;
  const folderId = job.folderId != null ? String(job.folderId) : null;
  const collectionId = job.collectionId;
  const wantTitle = job.title != null ? String(job.title) : "";

  if (!folderId || collectionId == null) {
    await queue.remove(job.id);
    return;
  }

  // Alias-only drift (Favorites bar ↔ Bookmarks bar) must not rename local roots.
  const gate = await renamableFolder(folderId, overrides, config.defaultPolicy, { wantTitle });
  if (!gate.node) {
    if (gate.gone) await clearFolderCollection(folderId);
    await queue.remove(job.id);
    return;
  }
  const { node } = gate;

  // Mapping must still point at this collection, from this folder (dateAdded).
  const mapped = await getFolderCollectionId(folderId, node);
  if (mapped == null || String(mapped) !== String(collectionId)) {
    await queue.remove(job.id);
    return;
  }

  if ((node.title || "") === wantTitle) {
    await queue.remove(job.id);
    return;
  }

  await suppressChange(folderId);
  await updateBookmark(folderId, { title: wantTitle });
  await refreshCacheAfterRename(cache, collectionId, wantTitle, getIndex);

  await appendLog("info", `Pulled folder rename: ${wantTitle}`);
  await queue.remove(job.id);
}

/** True if a delete-raindrop or delete-edge job for this raindrop is still queued. */
async function hasPendingDeleteForRaindrop(rid) {
  const target = String(rid);
  const jobs = await queue.list();
  return jobs.some(
    (j) => queue.isDeleteJob(j) && j.raindropId != null && String(j.raindropId) === target
  );
}

/**
 * Edge→Raindrop delete. Evidence is the onRemoved node payload (ledger entry,
 * or the url/title the handler put on the job). Survival check: another URL
 * bookmark in the synced scope, not bound to a different pair, means the user
 * removed a duplicate — rebind the pair to it and keep the raindrop.
 */
async function processDeleteRaindrop(job, ctx) {
  const { client } = ctx;
  const rid = job.raindropId != null ? String(job.raindropId) : null;
  if (!rid) {
    await queue.remove(job.id);
    return;
  }
  const removedBid = job.bookmarkId != null ? String(job.bookmarkId) : null;
  const entry = removedBid ? (await getEdgeRemoved())[removedBid] : null;
  const record = await getPairRecord(rid);
  const url = entry?.url || job.url || record?.url || null;
  const label = job.title || entry?.title || url || rid;

  if (!entry && !job.url) {
    // No onRemoved payload: absence of the bookmark is not intent to delete.
    await appendLog(
      "info",
      `Skipped Raindrop delete for ${label}: no removal evidence; pair kept.`
    );
    await queue.remove(job.id);
    return;
  }
  if (
    record &&
    removedBid &&
    record.bookmarkId != null &&
    String(record.bookmarkId) !== removedBid
  ) {
    // Pair already points at another bookmark: the removed copy was not the paired one.
    await removeEdgeRemoved(removedBid);
    await queue.remove(job.id);
    return;
  }

  const treeIndex = await loadTreeIndex();
  const pairs = await getPairs();
  // Lowest id wins here; rebind prefers the recorded path (pair-rebind.js).
  const survivor = edgeSurvivorCandidates(treeIndex, url, rid, pairs).find(
    (e) => e.id !== removedBid
  );
  if (survivor) {
    const applied = record
      ? await applyPairChanges([
          {
            type: "edge",
            raindropId: rid,
            fromBookmarkId: record.bookmarkId,
            record: {
              ...record,
              ...placementFromEntry(survivor),
              lastSeenEdgeAt: Date.now(),
            },
          },
        ])
      : [];
    if (removedBid) await removeEdgeRemoved(removedBid);
    await appendLog(
      "info",
      `Kept raindrop for ${label}: another copy is still in the browser ` +
        (applied.length ? "(pair rebound)." : "(pair left unchanged).")
    );
    await queue.remove(job.id);
    return;
  }

  try {
    await client.deleteRaindrop(rid);
    if (ctx.countDelete !== false) await noteDeleteExecuted();
  } catch (err) {
    // Already gone is fine.
    if (!isNotFoundError(err)) throw err;
  }
  await clearPairWithTombstone(rid, "edge-user-delete");
  if (removedBid) await removeEdgeRemoved(removedBid);
  await appendLog("info", `Deleted from Raindrop: ${label} (propagated from browser).`);
  await queue.remove(job.id);
}

/**
 * Raindrop→Edge delete. Re-checks the evidence against the current snapshot:
 * a raindrop that is live again, or whose URL survives under another id,
 * keeps the Edge bookmark (the latter rebinds the pair). Absence-signal jobs
 * also re-check presenceDeletesEnabled and migrationPartial. Skips the Edge
 * remove when the bookmark sits under an effective `exclude` policy but still
 * clears the pair and tombstones so reconcile does not re-queue.
 */
async function processDeleteEdge(job, ctx) {
  const { client, budget, config, overrides } = ctx;
  const rid = job.raindropId != null ? String(job.raindropId) : null;
  const record = rid ? await getPairRecord(rid) : null;
  if (!record) {
    // Pair already gone (rebound, repaired, or deleted by another job).
    await queue.remove(job.id);
    return;
  }
  const url = record.url || job.url || null;
  const label = record.title || url || rid;

  // Jobs queued by older versions carry no signal; hold them to the absence rules.
  const signal = job.signal === "trash" ? "trash" : "absent";
  if (signal === "absent") {
    const { migrationPartial } = await getStoredPairs();
    if (config.presenceDeletesEnabled === false || migrationPartial) {
      await appendLog("info", `Skipped local delete for ${label}: absence-based deletes are off.`);
      await queue.remove(job.id);
      return;
    }
  }

  // Survival check on an export taken after enqueue (a second, independent
  // look), not the one that produced the signal. One export serves a batch.
  // Jobs from older versions have no signalSeq: any usable snapshot will do.
  const afterSeq = job.signalSeq ?? null;
  const snapshot = await ensurePresenceOrNull({
    client,
    budget,
    reason: "on-demand",
    afterSeq,
  });
  if (!isUsableForUrls(snapshot) || (afterSeq != null && (snapshot.seq || 0) <= afterSeq)) {
    // Needs a fresh URL-indexed snapshot; defer rather than guess.
    throw new Error(`Presence snapshot unavailable; local delete of ${label} deferred`);
  }
  if (snapshot.ids.has(rid)) {
    await appendLog("info", `Kept local bookmark ${label}: the raindrop is live again.`);
    await queue.remove(job.id);
    return;
  }

  const treeIndex = await loadTreeIndex();
  const pairs = await getPairs();
  const pending = await queue.pendingUploadIds();
  const liveIds = livePairBookmarkIds(pairs.records, treeIndex, pending);
  const survivor = rebindStaleRaindropId({ ...record, url }, snapshot, pairs, liveIds);
  // Same occupant rule as rebindPass: a survivor already paired may be taken
  // over only when that pair's bookmark is dead.
  const occupant = survivor ? pairs.records[survivor.raindropId] : null;
  const occupantLive =
    occupant?.bookmarkId != null &&
    isPairBookmarkLive(occupant, treeIndex.byId.get(String(occupant.bookmarkId)), pending);
  if (survivor && !occupantLive) {
    const applied = await applyPairChanges([
      {
        type: "raindrop",
        fromRaindropId: rid,
        toRaindropId: survivor.raindropId,
        replacesBookmarkId: occupant ? occupant.bookmarkId : null,
        record: {
          ...record,
          url,
          raindropId: survivor.raindropId,
          lastSeenRaindropAt: Date.now(),
        },
      },
    ]);
    await appendLog(
      "info",
      applied.length
        ? `Rebound: ${label} (Raindrop id changed); local bookmark kept.`
        : `Kept local bookmark ${label}: its URL is live in Raindrop (pair left unchanged).`
    );
    await queue.remove(job.id);
    return;
  }

  // Current bookmark for this pair; a stale or reused id resolves by URL first.
  let bookmarkId = record.bookmarkId != null ? String(record.bookmarkId) : null;
  if (
    bookmarkId &&
    !isPairBookmarkLive({ ...record, url }, treeIndex.byId.get(bookmarkId), pending)
  ) {
    bookmarkId =
      rebindStaleEdgeId({ ...record, url }, treeIndex, pairs, { strict: true })?.entry.id ?? null;
  }

  if (bookmarkId) {
    // Missing node → already gone; still clear pair/tombstone below.
    // Catch remove/prune races the same way so a vanished bookmark cannot
    // abort the job before clearPairWithTombstone / queue.remove.
    const node = await getNodeOrNull(bookmarkId);
    if (node) {
      try {
        const parentId = node.parentId;
        const ancestorIds = await ancestorIdsFromFolder(parentId);
        const nodeLabel = node.title || node.url || bookmarkId;
        if (isExcluded(ancestorIds, overrides, config.defaultPolicy)) {
          await appendLog(
            "info",
            `Skipped local delete for excluded bookmark ${nodeLabel} (raindrop gone).`
          );
        } else {
          await suppressRemove(bookmarkId);
          await removeNode(bookmarkId);
          if (ctx.countDelete !== false) await noteDeleteExecuted();
          if (config.pruneEmpty) await pruneIfEmpty(parentId, config, overrides);
          await appendLog(
            "info",
            `Deleted local bookmark ${nodeLabel} (propagated from Raindrop).`
          );
        }
      } catch {
        // Already gone between get and remove — still clear mapping below.
      }
    }
  }

  await clearPairWithTombstone(rid, "raindrop-remote-delete");
  await queue.remove(job.id);
}

async function pruneIfEmpty(folderId, config, overrides) {
  let id = folderId;
  while (id) {
    let folder;
    try {
      folder = await getNode(id);
    } catch {
      return;
    }
    if (!folder || folder.parentId === ABSOLUTE_ROOT_ID) return;
    if (overrides[id]?.policy === POLICY.EXCLUDE) return;
    const children = await getChildren(id);
    if (children.length > 0) return;
    const parentId = folder.parentId;
    await removeFolder(id);
    await appendLog("info", `Pruned empty folder: ${folder.title}`);
    id = parentId;
  }
}
