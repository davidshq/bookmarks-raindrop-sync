// Thin promise wrappers and path resolution over the chrome.bookmarks API.
//
// Mirror placement (Raindrop relative path → Edge parent) lives in
// resolveMirrorPlacement / resolveEdgeParentForMirror / ancestorIdsForMirrorPath
// / mirrorPathExists / ensureMirrorFolderPath so pull-create, existing-only skip,
// mirror-all empty folders, and exclude checks cannot drift.
//
// Those path helpers share walkFolderTitles (create vs stop-on-missing) so the
// Edge title walk cannot diverge. Top-root picking uses rootRole aliases with
// locale fallbacks so Favorites bar ↔ Bookmarks bar stay aligned.
//
// Live Edge folder ancestry (resolveLocation / ancestorIdsFromFolder) shares
// walkAncestorsFromFolder so upload policy and delete-propagation exclude gates
// walk the same chain. Upload throws on missing ancestors; delete gates soft-truncate.
//
// Folder rename/exclude gates share folderPolicyAncestorIds / isFolderExcluded
// (folder + parents) so push rename, pull rename, and onChanged cannot disagree.
// Soft misses use getNodeOrNull (missing id → null) instead of try/catch at each site.
//
// Note on identity: the on-disk Chromium "guid" is not exposed by the
// chrome.bookmarks API. We use the node `id`, which is stable across browser
// restarts and survives renames/moves within the profile — which is exactly the
// rename-survival property the design wanted from a GUID.

import { ABSOLUTE_ROOT_ID } from "./constants.js";
import { findTopRootByAlias, rootRole, rootTitlesEqual } from "./bookmark-roots.js";
import { isOutsideRootContainer } from "./collections.js";
import { isExcluded } from "./policy.js";

export async function getNode(id) {
  const [node] = await chrome.bookmarks.get(id);
  return node;
}

/** Like getNode, but returns null when the id is missing (soft miss). */
export async function getNodeOrNull(id) {
  try {
    return await getNode(id);
  } catch {
    return null;
  }
}

export async function getTree() {
  return chrome.bookmarks.getTree();
}

export async function getChildren(id) {
  return chrome.bookmarks.getChildren(id);
}

export async function removeNode(id) {
  await chrome.bookmarks.remove(id);
}

export async function removeFolder(id) {
  // remove() rejects on non-empty folders; this is only called on empties.
  await chrome.bookmarks.remove(id);
}

export async function createBookmark({ parentId, title, url }) {
  return chrome.bookmarks.create({ parentId, title: title || url, url });
}

export async function createFolder({ parentId, title }) {
  return chrome.bookmarks.create({ parentId, title });
}

/** Update Edge-owned fields on an existing bookmark (title and/or url). */
export async function updateBookmark(id, { title, url } = {}) {
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (url !== undefined) patch.url = url;
  if (Object.keys(patch).length === 0) return getNode(id);
  return chrome.bookmarks.update(id, patch);
}

/** Move a bookmark or folder to a new parent (index optional). */
export async function moveBookmark(id, { parentId, index } = {}) {
  const destination = {};
  if (parentId !== undefined) destination.parentId = parentId;
  if (index !== undefined) destination.index = index;
  return chrome.bookmarks.move(id, destination);
}

/** Top-level user-visible roots under the invisible absolute root (id "0"). */
export async function getTopRoots() {
  return getChildren(ABSOLUTE_ROOT_ID);
}

/**
 * Walk folder titles under `startId`.
 * @param {"create"|"stop"} [onMissing="stop"] create missing folders, or stop.
 * @returns {{ parentId: string, ancestorIds: string[], complete: boolean }}
 *   ancestorIds is nearest-first including startId; complete is false if a
 *   title was missing and onMissing was "stop".
 */
async function walkFolderTitles(startId, titles, { onMissing = "stop" } = {}) {
  const ancestorIds = [startId];
  let parentId = startId;
  for (const title of titles) {
    const children = await getChildren(parentId);
    let folder = children.find((c) => !c.url && (c.title || "") === title);
    if (!folder) {
      if (onMissing === "create") {
        folder = await createFolder({ parentId, title });
      } else {
        return { parentId, ancestorIds, complete: false };
      }
    }
    parentId = folder.id;
    ancestorIds.unshift(folder.id);
  }
  return { parentId, ancestorIds, complete: true };
}

/**
 * Ensure folder titles under `parentId` exist; return the deepest folder id.
 * Creates missing folders as needed.
 */
export async function ensureFolderPath(parentId, titles) {
  const walked = await walkFolderTitles(parentId, titles, { onMissing: "create" });
  return walked.parentId;
}

/**
 * Map a Raindrop-relative collection path to a browser placement plan.
 * `relativeSegments` is under the Raindrop root (root title already stripped),
 * e.g. ["Bookmarks bar", "Work"] or ["Inbox"].
 *
 * Toolbar/other first segments match local top roots by alias
 * (Favorites bar ↔ Bookmarks bar, Other favorites ↔ Other bookmarks).
 *
 * Returns `{ startId, titles }` such that `ensureFolderPath(startId, titles)`
 * is the parent for a pull-create. Policy checks walk the same plan without
 * creating missing folders.
 */
export async function resolveMirrorPlacement(relativeSegments, rootName, topRoots) {
  const tops = topRoots ?? (await getTopRoots());
  const other =
    tops.find((t) => rootRole(t.title) === "other") ||
    tops.find((t) => rootRole(t.title) !== "toolbar") ||
    tops[0];
  const bar =
    tops.find((t) => rootRole(t.title) === "toolbar") ||
    tops.find((t) => /favorite/i.test(t.title || "") && t !== other) ||
    tops[0];

  if (!other && !bar) {
    throw new Error("No browser bookmark roots found");
  }

  const base = other || bar;

  if (relativeSegments.length === 0) {
    // Directly under Raindrop root → Other bookmarks/<rootName>
    return { startId: base.id, titles: [rootName] };
  }

  const [first, ...rest] = relativeSegments;
  // Sync-root mirror folder and outside-root Raindrop container both live under
  // the other-bookmarks root; match either prefix so we do not nest oddly.
  const firstLower = (first || "").toLowerCase();
  if (firstLower === (rootName || "").toLowerCase() || isOutsideRootContainer(first)) {
    return { startId: base.id, titles: relativeSegments };
  }

  const match = findTopRootByAlias(tops, first);
  if (match) {
    return { startId: match.id, titles: rest };
  }

  // Exact title under a top root (non-alias) — rare but keep prior behavior.
  const exact = tops.find((t) => (t.title || "").toLowerCase() === firstLower);
  if (exact) {
    return { startId: exact.id, titles: rest };
  }

  // Unrecognized first segment → Other bookmarks/<rootName>/<segments…>
  return { startId: base.id, titles: [rootName, ...relativeSegments] };
}

/** Create (as needed) the Edge parent folder for a Raindrop-mirrored path. */
export async function resolveEdgeParentForMirror(relativeSegments, rootName, topRoots) {
  const { startId, titles } = await resolveMirrorPlacement(relativeSegments, rootName, topRoots);
  return ensureFolderPath(startId, titles);
}

/**
 * True when every folder title in the mirror placement already exists in Edge.
 * Does not create folders — used by existing-only mode (reconcile + pull-create).
 */
export async function mirrorPathExists(relativeSegments, rootName, topRoots) {
  const { startId, titles } = await resolveMirrorPlacement(relativeSegments, rootName, topRoots);
  const { complete } = await walkFolderTitles(startId, titles, { onMissing: "stop" });
  return complete;
}

/**
 * Existing Edge parent id for a Raindrop mirror path, or null if any folder is missing.
 * Does not create folders — used to detect placement drift for pull-update.
 */
export async function resolveExistingMirrorParent(relativeSegments, rootName, topRoots) {
  const { startId, titles } = await resolveMirrorPlacement(relativeSegments, rootName, topRoots);
  const { parentId, complete } = await walkFolderTitles(startId, titles, { onMissing: "stop" });
  return complete ? parentId : null;
}

/**
 * Ensure the Edge folder path for a Raindrop-relative collection (no bookmark).
 * Used by mirror-all empty-collection mirroring.
 */
export async function ensureMirrorFolderPath(relativeSegments, rootName, topRoots) {
  return resolveEdgeParentForMirror(relativeSegments, rootName, topRoots);
}

/**
 * Nearest-first ancestor folder ids for the Edge path a mirror pull would use.
 * Walks existing folders only (stops at the first missing title) so exclude
 * policy can be evaluated without creating folders.
 */
export async function ancestorIdsForMirrorPath(relativeSegments, rootName, topRoots) {
  const { startId, titles } = await resolveMirrorPlacement(relativeSegments, rootName, topRoots);
  const { ancestorIds } = await walkFolderTitles(startId, titles, { onMissing: "stop" });
  return ancestorIds;
}

/**
 * Walk folder ids from `folderId` up to (but not including) absolute root "0".
 * Returns nearest-first ids and root-first titles for the same chain.
 *
 * @param {string} folderId
 * @param {{ soft?: boolean }} [opts] soft=true truncates on missing nodes
 *   (delete/exclude gates); soft=false (default) rethrows so upload can retry
 *   instead of syncing with a partial path / missed exclude override.
 */
export async function walkAncestorsFromFolder(folderId, { soft = false } = {}) {
  const ancestorIds = [];
  const segments = [];
  let id = folderId;
  while (id && id !== ABSOLUTE_ROOT_ID) {
    ancestorIds.push(id);
    try {
      const node = await getNode(id);
      segments.unshift(node.title);
      id = node.parentId;
    } catch (err) {
      if (soft) break;
      throw err;
    }
  }
  return { segments, ancestorIds };
}

/**
 * Nearest-first ancestor folder ids from `folderId` up to (not including) "0".
 * Soft-truncates if a folder is already gone (best-effort exclude on delete).
 */
export async function ancestorIdsFromFolder(folderId) {
  return (await walkAncestorsFromFolder(folderId, { soft: true })).ancestorIds;
}

/**
 * Nearest-first ids for folder policy: the folder itself, then its parents.
 * Shared by rename/exclude gates (push, pull, onChanged).
 *
 * @param {string|number} folderId
 * @param {string|null|undefined} parentId
 * @returns {Promise<string[]>}
 */
export async function folderPolicyAncestorIds(folderId, parentId) {
  const parentAncestors =
    parentId && parentId !== ABSOLUTE_ROOT_ID ? await ancestorIdsFromFolder(parentId) : [];
  return [String(folderId), ...parentAncestors];
}

/**
 * True when the folder (or a nearer ancestor override) is effectively exclude.
 * Shared by rename push/pull and onChanged folder-title gates.
 */
export async function isFolderExcluded(folderId, parentId, overrides, defaultPolicy) {
  const ancestorIds = await folderPolicyAncestorIds(folderId, parentId);
  return isExcluded(ancestorIds, overrides, defaultPolicy);
}

/**
 * Folder gate shared by push and pull renames. `gone`: the node no longer
 * exists (caller drops its folder→collection mapping). `skip`: a URL node, a
 * browser top root (local titles stay; Raindrop keeps canonical ones), or an
 * excluded folder. Otherwise the live folder node.
 * With `wantTitle` (pull renames), a folder already titled that way — including
 * bar/other alias drift — is also `skip`, checked before the ancestor walk.
 * @returns {Promise<{ gone: true } | { skip: true } | { node: chrome.bookmarks.BookmarkTreeNode }>}
 */
export async function renamableFolder(folderId, overrides, defaultPolicy, { wantTitle } = {}) {
  const node = await getNodeOrNull(folderId);
  if (!node) return { gone: true };
  if (node.url || node.parentId === ABSOLUTE_ROOT_ID) return { skip: true };
  if (wantTitle != null && rootTitlesEqual(node.title, wantTitle)) return { skip: true };
  if (await isFolderExcluded(folderId, node.parentId, overrides, defaultPolicy)) {
    return { skip: true };
  }
  return { node };
}

// Resolve a bookmark's location into:
//   segments      : folder titles from the top root down to the parent folder
//                   e.g. ["Favorites bar", "Work", "ProjectA"]
//   ancestorIds   : the same folders' ids, nearest-first (parent folder first)
//                   e.g. [ProjectA.id, Work.id, FavoritesBar.id]
// The invisible absolute root (id "0") is excluded. The top root folder (e.g.
// "Favorites bar" / "Other favorites") is included so both Edge roots are
// preserved under the chosen Raindrop root collection.
// Throws if an ancestor is missing so processUpload defers instead of
// writing an incomplete Raindrop path.
export async function resolveLocation(node) {
  if (!node?.parentId || node.parentId === ABSOLUTE_ROOT_ID) {
    return { segments: [], ancestorIds: [] };
  }
  return walkAncestorsFromFolder(node.parentId);
}

/**
 * Collect URL bookmark ids under `folderId` (depth-first, not including the
 * folder itself). Used when Chromium fires a single onMoved for a folder move.
 */
export async function collectUrlDescendantIds(folderId) {
  const out = [];
  const walk = async (id) => {
    const children = await getChildren(id);
    for (const child of children) {
      if (child.url) out.push(String(child.id));
      else await walk(child.id);
    }
  };
  await walk(String(folderId));
  return out;
}
