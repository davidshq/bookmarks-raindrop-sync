// Durable queue job processors (upload, pull, delete, folder rename).
// Invoked only from drain.js. Confirm-before-act and suppress rules live here.
//
// Crash-safe creates: before createRaindrop / createBookmark the job is patched
// with createAttemptedAt / pullCreateAttemptedAt. A service-worker death between
// the side effect and recordSynced leaves the job queued with the marker; the
// next drain reclaims by URL instead of forking a duplicate. Same pattern as
// offloadRaindropId for destructive offload.

import {
  POLICY,
  JOB,
  SYNC_MODE,
  RAINDROP_FOLDER_MODE,
  OUTSIDE_ROOT_MIRROR_FOLDER,
} from "./constants.js";
import { rootTitlesEqual } from "./bookmark-roots.js";
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
  isFolderExcluded,
} from "./bookmarks.js";
import { resolvePolicy, isExcluded } from "./policy.js";
import { isNotFoundError } from "./raindrop.js";
import {
  ensureCollectionPath,
  findRootCollection,
  collectionIdFromRelative,
  collectionPathFromRoot,
  raindropUploadSegments,
  recordFolderCollectionsAlongPath,
  recordFolderCollectionsForPulledPath,
  applyCollectionTitleInIndex,
} from "./collections.js";
import { canCreateRaindropOnlyPath } from "./allowlist.js";
import { computePullUpdatePlan } from "./pull-update.js";
import { filterUrlMatchingItems, pickMoveRebindCandidate } from "./move-rebind.js";
import { urlMatchKeys } from "./url-match.js";

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
 * Search Raindrop for a URL and pick a claimable raindrop id (move rebind or
 * crash-recovery after createAttemptedAt).
 * @param {string} bookmarkId
 * @param {string} url
 * @param {import("./raindrop.js").RaindropClient} client
 * @returns {Promise<{ kind: 'unique'|'multi'|'conflict'|'none', rid?: string, extras: number }>}
 */
async function tryReclaimRaindropByUrl(bookmarkId, url, client) {
  const { items } = await client.searchRaindrops(url);
  const matching = filterUrlMatchingItems(url, items);
  if (!matching.length) return { kind: "none", extras: 0 };

  const pairs = await getPairs();
  const liveIds = new Set([String(bookmarkId)]);
  for (const item of matching) {
    const otherBid = pairs.byRaindrop?.[String(item._id)];
    if (otherBid == null) continue;
    const other = await getNodeOrNull(String(otherBid));
    if (other?.url) liveIds.add(String(otherBid));
  }

  const pick = pickMoveRebindCandidate(bookmarkId, matching, pairs, liveIds);
  if (pick.kind === "none" || pick.kind === "conflict") {
    return { kind: pick.kind, extras: 0 };
  }
  return { kind: pick.kind, rid: pick.rid, extras: pick.extras || 0 };
}

/**
 * Apply a URL reclaim: record pair, optionally log extras, update Edge-owned fields.
 * @returns {Promise<string|null>} raindrop id, or null if update 404'd
 */
async function applyReclaimedRaindrop(job, node, rid, extras, collectionId, pathLabel, client) {
  await recordSynced(job.id, rid);
  if (extras > 0) {
    await appendLog(
      "warn",
      `Reclaimed with ${extras} extra Raindrop copy(ies) left: ${node.title || node.url}`
    );
  }
  try {
    await client.updateRaindrop(rid, {
      link: node.url,
      title: node.title,
      collectionId,
    });
    if (job.reason === "move") {
      await appendLog("info", `Moved: ${node.title || node.url} → ${pathLabel}`);
    } else {
      await appendLog("info", `Synced: ${node.title || node.url}`);
    }
    return rid;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    await forgetPairByRaindrop(rid);
    return null;
  }
}

async function processUpload(job, ctx) {
  const { client, config, overrides, cache, getIndex } = ctx;

  let node;
  try {
    node = await getNode(job.id);
  } catch {
    // Bookmark already gone: if offload had stashed a raindrop id, finish the
    // tombstone. Otherwise the upload target disappeared (user delete) and the
    // job has nothing left to do.
    await finishInterruptedOffload(job);
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

  if (rid) {
    try {
      await client.updateRaindrop(rid, {
        link: node.url,
        title: node.title,
        collectionId,
      });
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

  // Unpaired move, or crash recovery after createAttemptedAt: reclaim by URL
  // instead of forking a second Raindrop copy.
  const shouldReclaim =
    !rid && (job.reason === "move" || job.createAttemptedAt != null);
  if (shouldReclaim) {
    const rebound = await tryReclaimRaindropByUrl(job.id, node.url, client);
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
        client
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
    await recordSynced(job.id, item._id);
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

  const node = await getNodeOrNull(folderId);
  if (!node) {
    await clearFolderCollection(folderId);
    await queue.remove(job.id);
    return;
  }
  if (node.url) {
    await queue.remove(job.id);
    return;
  }
  // Browser top roots keep local titles; Raindrop stays on canonical bar/other.
  if (node.parentId === "0") {
    await queue.remove(job.id);
    return;
  }

  if (await isFolderExcluded(folderId, node.parentId, overrides, config.defaultPolicy)) {
    await queue.remove(job.id);
    return;
  }

  const collectionId = await getFolderCollectionId(folderId);
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

  // Crash recovery: prior drain may have created the Edge bookmark without
  // recording the pair. Reclaim instead of creating a duplicate.
  if (job.pullCreateAttemptedAt != null) {
    const orphan = await findUnpairedPullCreateOrphan(parentId, job.link, rid);
    if (orphan) {
      await suppressCreate(orphan.id);
      await recordSynced(orphan.id, rid);
      await recordPulledFolderCollections({
        getIndex,
        index,
        rootId,
        collectionId,
        relative,
        rootName: config.rootName,
        edgeLeafFolderId: orphan.parentId,
      });
      await appendLog("info", `Pulled: ${job.title || job.link}`);
      await queue.remove(job.id);
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
  await recordSynced(node.id, rid);
  // Learn folder→collection so later Raindrop renames can pull-rename in place.
  await recordPulledFolderCollections({
    getIndex,
    index,
    rootId,
    collectionId,
    relative,
    rootName: config.rootName,
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
  const want = new Set(urlMatchKeys(link));
  if (!want.size) return null;
  const children = await getChildren(parentId);
  for (const child of children) {
    if (!child?.url || !child.id) continue;
    const keys = urlMatchKeys(child.url);
    if (!keys.some((k) => want.has(k))) continue;
    const existingRid = await getRaindropId(child.id);
    if (existingRid == null || existingRid === String(raindropId)) return child;
  }
  return null;
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
  if (!edgeLeafFolderId || edgeLeafFolderId === "0" || !(relative || []).length) return;
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
    const path =
      rootId != null && collectionPathFromRoot(index, collectionId, rootId).length
        ? [rootName, ...relative].join("/")
        : (relative[0] || "").toLowerCase() === OUTSIDE_ROOT_MIRROR_FOLDER.toLowerCase()
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

  const node = await getNodeOrNull(folderId);
  if (!node) {
    await clearFolderCollection(folderId);
    await queue.remove(job.id);
    return;
  }
  if (node.url || node.parentId === "0") {
    await queue.remove(job.id);
    return;
  }

  // Alias-only drift (Favorites bar ↔ Bookmarks bar) must not rename local roots.
  if (rootTitlesEqual(node.title, wantTitle)) {
    await queue.remove(job.id);
    return;
  }

  if (await isFolderExcluded(folderId, node.parentId, overrides, config.defaultPolicy)) {
    await queue.remove(job.id);
    return;
  }

  // Mapping must still point at this collection.
  const mapped = await getFolderCollectionId(folderId);
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
  return jobs.some((j) => {
    const kind = queue.jobKind(j);
    if (kind !== JOB.DELETE_RAINDROP && kind !== JOB.DELETE_EDGE) return false;
    return j.raindropId != null && String(j.raindropId) === target;
  });
}

async function processDeleteRaindrop(job, ctx) {
  const { client } = ctx;
  const rid = job.raindropId != null ? String(job.raindropId) : null;
  if (!rid) {
    await queue.remove(job.id);
    return;
  }

  try {
    await client.deleteRaindrop(rid);
  } catch (err) {
    // Already gone is fine.
    if (!isNotFoundError(err)) throw err;
  }
  await clearPairWithTombstone(rid, "edge-user-delete");
  const label = job.title || job.url || rid;
  await appendLog("info", `Deleted from Raindrop: ${label} (propagated from browser).`);
  await queue.remove(job.id);
}

/**
 * Propagate a missing Raindrop item to Edge. Skips the Edge remove when the
 * paired bookmark sits under an effective `exclude` policy (hands-off subtree),
 * but still clears the pair and tombstones so reconcile does not re-queue.
 */
async function processDeleteEdge(job, ctx) {
  const { config, overrides } = ctx;
  const rid = job.raindropId != null ? String(job.raindropId) : null;
  const bookmarkId = job.bookmarkId;

  if (bookmarkId) {
    // Missing node → already gone; still clear pair/tombstone below.
    // Catch remove/prune races the same way so a vanished bookmark cannot
    // abort the job before clearPairWithTombstone / queue.remove.
    const node = await getNodeOrNull(bookmarkId);
    if (node) {
      try {
        const parentId = node.parentId;
        const ancestorIds = await ancestorIdsFromFolder(parentId);
        const label = node.title || node.url || bookmarkId;
        if (isExcluded(ancestorIds, overrides, config.defaultPolicy)) {
          await appendLog(
            "info",
            `Skipped local delete for excluded bookmark ${label} (raindrop gone).`
          );
        } else {
          await suppressRemove(bookmarkId);
          await removeNode(bookmarkId);
          if (config.pruneEmpty) await pruneIfEmpty(parentId, config, overrides);
          await appendLog(
            "info",
            `Deleted local bookmark ${label} (propagated from Raindrop).`
          );
        }
      } catch {
        // Already gone between get and remove — still clear mapping below.
      }
    }
  }

  if (rid) {
    await clearPairWithTombstone(rid, "raindrop-remote-delete");
  } else if (bookmarkId) {
    await forgetSynced(bookmarkId);
  }
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
    if (!folder || folder.parentId === "0") return;
    if (overrides[id]?.policy === POLICY.EXCLUDE) return;
    const children = await getChildren(id);
    if (children.length > 0) return;
    const parentId = folder.parentId;
    await removeFolder(id);
    await appendLog("info", `Pruned empty folder: ${folder.title}`);
    id = parentId;
  }
}
