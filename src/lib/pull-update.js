// Shared Raindrop→Edge pull-update planning.
//
// Reconcile enqueue (maybeEnqueuePullUpdate) and drain apply (processPullUpdate)
// must agree on title/URL/parent drift and the create-path / exclude gates.
// Both call computePullUpdatePlan so those decisions cannot diverge.

import { ABSOLUTE_ROOT_ID } from "./constants.js";
import { sameBookmarkUrl } from "./url-match.js";
import { canCreateRaindropOnlyPath } from "./allowlist.js";
import { ancestorIdsFromFolder, resolveExistingMirrorParent } from "./bookmarks.js";
import { isExcluded } from "./policy.js";

/**
 * Decide what a pull-update should change on an Edge bookmark.
 * No Edge or Raindrop writes — callers enqueue or apply from the result.
 *
 * @param {{
 *   node: { title?: string, url?: string, parentId?: string },
 *   wantTitle: string,
 *   wantLink: string,
 *   relative: string[],
 *   rootName: string,
 *   topRoots: object[],
 *   collectionId: string|number|null|undefined,
 *   allowlist: Record<string, { path?: string }>|null|undefined,
 *   folderMode: string,
 *   index: { byId: Map }|null|undefined,
 *   rootId: string|number|null|undefined,
 *   overrides: Record<string, { policy?: string }>,
 *   defaultPolicy: string,
 * }} opts
 * @returns {Promise<{
 *   skip: boolean,
 *   titleDiff: boolean,
 *   urlDiff: boolean,
 *   parentDiff: boolean,
 *   existingParent: string|null,
 *   shouldCreatePath: boolean,
 *   wantTitle: string,
 *   wantLink: string,
 * }>}
 */
export async function computePullUpdatePlan(opts) {
  const {
    node,
    wantTitle,
    wantLink,
    relative,
    rootName,
    topRoots,
    collectionId,
    allowlist,
    folderMode,
    index,
    rootId,
    overrides,
    defaultPolicy,
  } = opts;

  const title = wantTitle || wantLink || "";
  const link = wantLink || "";

  // Current Edge location under exclude → hands-off (destination gated separately).
  if (node.parentId && node.parentId !== ABSOLUTE_ROOT_ID) {
    const currentAncestors = await ancestorIdsFromFolder(node.parentId);
    if (isExcluded(currentAncestors, overrides, defaultPolicy)) {
      return {
        skip: true,
        titleDiff: false,
        urlDiff: false,
        parentDiff: false,
        existingParent: null,
        shouldCreatePath: false,
        wantTitle: title,
        wantLink: link,
      };
    }
  }

  const titleDiff = (node.title || "") !== title;
  // Browser-normalized compare: a verbatim Raindrop link that Chromium
  // rewrites on save (e.g. trailing "/" on an origin) is not drift.
  const urlDiff = !sameBookmarkUrl(node.url || "", link);

  const existingParent = await resolveExistingMirrorParent(relative, rootName, topRoots);
  let shouldCreatePath = false;
  let parentDiff;

  if (existingParent == null) {
    // Would need to create Edge folders — same gate as pull-create.
    shouldCreatePath = canCreateRaindropOnlyPath({
      allowlist,
      collectionId,
      index,
      rootId,
      edgePathExists: false,
      folderMode,
    });
    parentDiff = shouldCreatePath;
  } else {
    parentDiff = String(node.parentId) !== String(existingParent);
  }

  return {
    skip: !titleDiff && !urlDiff && !parentDiff,
    titleDiff,
    urlDiff,
    parentDiff,
    existingParent,
    shouldCreatePath,
    wantTitle: title,
    wantLink: link,
  };
}
