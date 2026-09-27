// Reconcile pull enqueue helpers (shared by root and outside-root listing).
// Drift gates share computePullUpdatePlan with drain apply (pull-update.js).

import { JOB, RAINDROP_FOLDER_MODE } from "./constants.js";
import { hasTombstone, appendLog, recordFolderCollection } from "./store.js";
import * as queue from "./queue.js";
import { isExcluded } from "./policy.js";
import {
  getNodeOrNull,
  ancestorIdsForMirrorPath,
  ancestorIdsFromFolder,
  mirrorPathExists,
  ensureMirrorFolderPath,
} from "./bookmarks.js";
import {
  collectionsUnderRoot,
  collectionsForAllowlistPicker,
  recordFolderCollectionsForPulledPath,
} from "./collections.js";
import { isAllowlistActive, isCollectionAllowed, canCreateRaindropOnlyPath } from "./allowlist.js";
import { computePullUpdatePlan } from "./pull-update.js";

export async function maybeEnqueuePullCreate(item, ctx, resolveRelative) {
  const rid = String(item._id);
  ctx.seenIds.add(rid);

  if (await hasTombstone(rid)) return 0;
  if (!item.link) return 0;
  if (item.type === "file" || item.type === "document") return 0;

  const colId = item.collection?.$id ?? item.collection?.id;
  const relative = resolveRelative(colId);
  // null/undefined ⇒ skip; [] is valid (bookmark living directly under sync root).
  if (relative == null) return 0;

  if (
    await pathIsExcluded(
      relative,
      ctx.topRoots,
      ctx.overrides,
      ctx.config.defaultPolicy,
      ctx.config.rootName
    )
  ) {
    return 0;
  }

  const bookmarkId = ctx.pairs.byRaindrop[rid];
  if (bookmarkId) {
    return maybeEnqueuePullUpdate(item, ctx, relative, bookmarkId, colId);
  }

  const edgeExists = await mirrorPathExists(relative, ctx.config.rootName, ctx.topRoots);
  if (
    !canCreateRaindropOnlyPath({
      allowlist: ctx.allowlist,
      collectionId: colId,
      index: ctx.index,
      rootId: ctx.rootId,
      edgePathExists: edgeExists,
      folderMode: ctx.folderMode,
    })
  ) {
    return 0;
  }

  const added = await queue.enqueueJob({
    id: `pull-${rid}`,
    kind: JOB.PULL_CREATE,
    raindropId: rid,
    link: item.link,
    title: item.title || item.link,
    relativeSegments: relative,
    collectionId: colId != null ? String(colId) : null,
  });
  return added ? 1 : 0;
}

/**
 * Enqueue Raindrop→Edge field/placement update when the paired Edge bookmark drifted.
 * Missing destination folders are gated like pull-create (`existing-only` / allowlist);
 * title/URL drift can still enqueue when placement create is blocked.
 * @returns {Promise<0|1>}
 */
async function maybeEnqueuePullUpdate(item, ctx, relative, bookmarkId, colId) {
  const node = await getNodeOrNull(bookmarkId);
  if (!node?.url) return 0;

  const plan = await computePullUpdatePlan({
    node,
    wantTitle: item.title || item.link || "",
    wantLink: item.link || "",
    relative,
    rootName: ctx.config.rootName,
    topRoots: ctx.topRoots,
    collectionId: colId,
    allowlist: ctx.allowlist,
    folderMode: ctx.folderMode,
    index: ctx.index,
    rootId: ctx.rootId,
    overrides: ctx.overrides,
    defaultPolicy: ctx.config.defaultPolicy,
  });
  if (plan.skip) return 0;

  const added = await queue.enqueueJob({
    id: `pu-${String(item._id)}`,
    kind: JOB.PULL_UPDATE,
    raindropId: String(item._id),
    bookmarkId: String(bookmarkId),
    link: plan.wantLink,
    title: plan.wantTitle,
    relativeSegments: relative,
    collectionId: colId != null ? String(colId) : null,
  });
  return added ? 1 : 0;
}

/**
 * Empty-folder ensure: allowlisted collections always (when allowlist active);
 * otherwise full mirror-all under root when mode is mirror-all.
 * Logs a verify count (paths present or created-if-missing), not "N new folders".
 */
export async function ensureAllowlistedOrMirrorAll(
  index,
  rootId,
  config,
  overrides,
  topRoots,
  folderMode,
  allowlist
) {
  let targets;
  if (isAllowlistActive(allowlist)) {
    targets = collectionsForAllowlistPicker(index, rootId).filter(({ collectionId }) =>
      isCollectionAllowed(collectionId, index, rootId, allowlist)
    );
  } else if (folderMode === RAINDROP_FOLDER_MODE.MIRROR_ALL) {
    targets = collectionsUnderRoot(index, rootId);
  } else {
    return;
  }

  let ensured = 0;
  for (const { relativeSegments, collectionId } of targets) {
    if (!relativeSegments.length) continue;
    if (
      await pathIsExcluded(
        relativeSegments,
        topRoots,
        overrides,
        config.defaultPolicy,
        config.rootName
      )
    ) {
      continue;
    }
    const leafId = await ensureMirrorFolderPath(relativeSegments, config.rootName, topRoots);
    if (leafId && leafId !== "0") {
      try {
        const ancestors = await ancestorIdsFromFolder(leafId);
        await recordFolderCollectionsForPulledPath(
          index,
          rootId,
          collectionId,
          relativeSegments,
          ancestors,
          recordFolderCollection
        );
      } catch {
        // Empty-folder ensure already succeeded; rename map is best-effort.
      }
    }
    ensured++;
  }
  if (ensured > 0) {
    // Paths checked/created-if-missing — not "created N folders this cycle".
    const label = isAllowlistActive(allowlist)
      ? "Verified allowlisted"
      : "Verified mirrored";
    await appendLog("info", `${label} local folder path(s): ${ensured}.`);
  }
}

async function pathIsExcluded(relativeSegments, topRoots, overrides, defaultPolicy, rootName) {
  const ancestorIds = await ancestorIdsForMirrorPath(relativeSegments, rootName, topRoots);
  return isExcluded(ancestorIds, overrides, defaultPolicy);
}
