// Durable queue job processors (upload, pull, delete, folder rename).
// Invoked only from drain.js. Confirm-before-act and suppress rules live here.

import { POLICY, JOB, SYNC_MODE, RAINDROP_FOLDER_MODE } from "./constants.js";
import {
  getCollectionCache,
  cacheCollection,
  uncacheCollection,
  rewriteCollectionCacheForRename,
  recordFolderCollection,
  getFolderCollectionId,
  clearFolderCollection,
  hasSynced,
  recordSynced,
  getRaindropId,
  getBookmarkIdForRaindrop,
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
  folderPolicyAncestorIds,
} from "./bookmarks.js";
import { resolvePolicy, isExcluded } from "./policy.js";
import { isNotFoundError } from "./raindrop.js";
import {
  ensureCollectionPath,
  findRootCollection,
  collectionIdFromRelative,
  raindropUploadSegments,
  recordFolderCollectionsAlongPath,
  applyCollectionTitleInIndex,
} from "./collections.js";
import { canCreateRaindropOnlyPath } from "./allowlist.js";
import { computePullUpdatePlan } from "./pull-update.js";

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

  if (effective === POLICY.EXCLUDE) {
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
      // Stale pair: raindrop gone — clear mapping and fall through to create.
      if (!isNotFoundError(err)) throw err;
      await forgetPairByRaindrop(rid);
      rid = null;
    }
  }

  if (!rid && !(await hasSynced(job.id))) {
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

  let node;
  try {
    node = await getNode(folderId);
  } catch {
    await clearFolderCollection(folderId);
    await queue.remove(job.id);
    return;
  }
  if (node.url) {
    await queue.remove(job.id);
    return;
  }

  const ancestorIds = await folderPolicyAncestorIds(folderId, node.parentId);
  if (resolvePolicy(ancestorIds, overrides, config.defaultPolicy) === POLICY.EXCLUDE) {
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

  expectExtensionCreate(job.link);
  let node;
  try {
    const parentId = await resolveEdgeParentForMirror(relative, config.rootName);
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
  await appendLog("info", `Pulled: ${job.title || job.link}`);
  await queue.remove(job.id);
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

  let node;
  try {
    node = await getNode(bookmarkId);
  } catch {
    await queue.remove(job.id);
    return;
  }
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
    await moveBookmark(bookmarkId, { parentId: targetParent });
    await appendLog("info", `Pulled move: ${wantTitle || wantLink}`);
  } else if (titleDiff || urlDiff) {
    await appendLog("info", `Pulled update: ${wantTitle || wantLink}`);
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

  let node;
  try {
    node = await getNode(folderId);
  } catch {
    await clearFolderCollection(folderId);
    await queue.remove(job.id);
    return;
  }
  if (node.url || node.parentId === "0") {
    await queue.remove(job.id);
    return;
  }

  const ancestorIds = await folderPolicyAncestorIds(folderId, node.parentId);
  if (resolvePolicy(ancestorIds, overrides, config.defaultPolicy) === POLICY.EXCLUDE) {
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
  await appendLog("info", `Deleted from Raindrop: ${label} (propagated from Edge).`);
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
    try {
      const node = await getNode(bookmarkId);
      const parentId = node.parentId;
      const ancestorIds = await ancestorIdsFromFolder(parentId);
      const label = node.title || node.url || bookmarkId;
      if (isExcluded(ancestorIds, overrides, config.defaultPolicy)) {
        await appendLog(
          "info",
          `Skipped Edge delete for excluded bookmark ${label} (raindrop gone).`
        );
      } else {
        await suppressRemove(bookmarkId);
        await removeNode(bookmarkId);
        if (config.pruneEmpty) await pruneIfEmpty(parentId, config, overrides);
        await appendLog(
          "info",
          `Deleted Edge bookmark ${label} (propagated from Raindrop).`
        );
      }
    } catch {
      // Already gone — still clear mapping.
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
