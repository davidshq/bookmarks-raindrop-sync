// Mirrors an Edge folder path into nested Raindrop collections (ensure-if-missing).
//
// Raindrop allows duplicate collection titles, so "does this collection exist?"
// is answered by matching title within a given parent — never by global title.
// We build an in-memory index of existing collections once per drain pass and
// also persist a path -> collectionId cache so steady-state syncs make zero
// collection lookups. Cache hits are validated against the live index so a
// deleted/renamed Raindrop collection cannot keep receiving new raindrops.
//
// Index maps store dual keys (id + String(id)); use getById / getByParent so
// call sites never miss a collection due to number/string mismatch.
//
// Parent-chain walks share walkCollectionAncestors (path-from-root, absolute
// path, allowlist membership). Outside-root landing uses isOutsideRootLandingSegments
// (rootRole + Raindrop container) so upload and folder→collection recording agree.

import { canonicalizeUploadSegments, rootRole } from "./bookmark-roots.js";
import { OUTSIDE_ROOT_MIRROR_FOLDER } from "./constants.js";

const ROOT = "root"; // sentinel parent key for top-level collections

/**
 * Lookup a collection by id, tolerating number vs string keys (index stores both).
 * @param {{ byId?: Map }|null|undefined} index
 * @param {string|number|null|undefined} id
 */
export function getById(index, id) {
  if (id == null || !index?.byId) return null;
  return index.byId.get(id) || index.byId.get(String(id)) || null;
}

/**
 * Children map for a parent id (title→collection), with number/string key fallback.
 * @param {{ byParent?: Map }|null|undefined} index
 * @param {string|number} parentId
 * @returns {Map|undefined}
 */
export function getByParent(index, parentId) {
  if (parentId == null || !index?.byParent) return undefined;
  return index.byParent.get(parentId) || index.byParent.get(String(parentId));
}

/**
 * Build collection indexes from the account's root and nested collections.
 * @returns {{ byParent: Map, byId: Map<string|number, object> }}
 */
export async function buildCollectionIndex(client) {
  const [roots, children] = await Promise.all([
    client.getRootCollections(),
    client.getChildCollections(),
  ]);
  const byParent = new Map();
  const byId = new Map();
  const add = (col) => {
    const parentId = col.parent && col.parent.$id ? col.parent.$id : ROOT;
    if (!byParent.has(parentId)) byParent.set(parentId, new Map());
    byParent.get(parentId).set((col.title || "").toLowerCase(), col);
    byId.set(col._id, col);
    byId.set(String(col._id), col);
  };
  roots.forEach(add);
  children.forEach(add);
  return { byParent, byId };
}

/** Find a root-level collection by title (case-insensitive). */
export function findRootCollection(index, title) {
  const siblings = getByParent(index, ROOT);
  return siblings?.get((title || "").toLowerCase()) ?? null;
}

/**
 * Walk Raindrop collection parents from `startId` toward the account top.
 *
 * `visit(col)` returns `"continue"`, `"stop"` (success), or `"abort"` (failure).
 * Hitting a null parent after continues yields `{ ok: true, hitTop: true }`.
 * Cycles, missing start, or `"abort"` yield `{ ok: false }`.
 *
 * @param {{ byId?: Map }|null|undefined} index
 * @param {string|number} startId
 * @param {(col: object) => "continue"|"stop"|"abort"} visit
 * @returns {{ ok: boolean, hitTop: boolean }}
 */
export function walkCollectionAncestors(index, startId, visit) {
  let current = getById(index, startId);
  if (!current) return { ok: false, hitTop: false };
  const seen = new Set();
  while (current) {
    if (seen.has(current._id)) return { ok: false, hitTop: false };
    seen.add(current._id);
    const action = visit(current);
    if (action === "abort") return { ok: false, hitTop: false };
    if (action === "stop") return { ok: true, hitTop: false };
    const parentId = current.parent?.$id;
    if (parentId == null) return { ok: true, hitTop: true };
    current = getById(index, parentId);
    if (!current) return { ok: false, hitTop: false };
  }
  return { ok: false, hitTop: false };
}

/**
 * Titles from the configured root down to `collectionId` (inclusive of root).
 * Returns [] if the collection is not under the root.
 */
export function collectionPathFromRoot(index, collectionId, rootId) {
  const titles = [];
  const result = walkCollectionAncestors(index, collectionId, (col) => {
    titles.unshift(col.title || "");
    if (String(col._id) === String(rootId)) return "stop";
    return "continue";
  });
  // Must stop on the root — walking off the top without hitting it is a miss.
  if (!result.ok || result.hitTop) return [];
  return titles;
}

/** True when `id` is present in the live collection index. */
export function collectionIdAlive(index, id) {
  return getById(index, id) != null;
}

/**
 * Every collection under `rootId` (including the root), with relative segments
 * (root title stripped). Dedupes by `_id` because the index stores dual keys.
 * @returns {{ collectionId: number|string, relativeSegments: string[] }[]}
 */
export function collectionsUnderRoot(index, rootId) {
  if (!index?.byId) return [];
  const seen = new Set();
  const out = [];
  for (const col of index.byId.values()) {
    if (!col || seen.has(col._id)) continue;
    seen.add(col._id);
    const full = collectionPathFromRoot(index, col._id, rootId);
    if (!full.length) continue;
    out.push({ collectionId: col._id, relativeSegments: full.slice(1) });
  }
  return out;
}

/**
 * Titles from the Raindrop top-level collection down to `collectionId`.
 * @returns {string[]} empty if id missing
 */
export function collectionAbsolutePath(index, collectionId) {
  const titles = [];
  const result = walkCollectionAncestors(index, collectionId, (col) => {
    titles.unshift(col.title || "");
    return "continue";
  });
  return result.ok ? titles : [];
}

/**
 * True when Edge segments are the outside-root landing zone:
 * Other bookmarks|favorites / Raindrop / …
 * Uses rootRole so bare "Other" is not treated as a top root.
 * @param {string[]|null|undefined} edgeSegments
 */
export function isOutsideRootLandingSegments(edgeSegments) {
  const segs = edgeSegments || [];
  return (
    segs.length >= 2 &&
    rootRole(segs[0]) === "other" &&
    (segs[1] || "").toLowerCase() === OUTSIDE_ROOT_MIRROR_FOLDER.toLowerCase()
  );
}

/**
 * Edge mirror relative segments for a Raindrop collection.
 * Under the sync root → path with root title stripped (today's layout).
 * Outside the sync root → `Raindrop / …` absolute path so placement nests under
 * Other favorites / Raindrop and never attaches to an Edge top whose title
 * matches a Raindrop top-level collection (e.g. "Favorites bar").
 * @returns {string[]|null} null if collection unknown
 */
export function mirrorRelativeSegments(index, collectionId, syncRootId) {
  const under = collectionPathFromRoot(index, collectionId, syncRootId);
  if (under.length) return under.slice(1);
  const absolute = collectionAbsolutePath(index, collectionId);
  if (!absolute.length) return null;
  return [OUTSIDE_ROOT_MIRROR_FOLDER, ...absolute];
}

/**
 * Map Edge folder segments (from resolveLocation) to a Raindrop collection path
 * for upload via ensureCollectionPath.
 *
 * Normal Edge paths nest under the sync root: `[rootName, ...segments]`.
 * The outside-root landing zone `Other favorites / Raindrop / <rest>` maps to
 * account-level collections `<rest>` so drops round-trip to the original
 * outside-root collection instead of creating Edge/Other favorites/Raindrop/….
 * A bare Raindrop container (no `<rest>`) falls back to the under-root path.
 *
 * @param {string[]} edgeSegments
 * @param {string} rootName
 * @returns {string[]}
 */
export function raindropUploadSegments(edgeSegments, rootName) {
  const segs = edgeSegments || [];
  if (isOutsideRootLandingSegments(segs)) {
    const rest = segs.slice(2);
    if (rest.length) return rest;
  }
  // Toolbar/other top roots → Chrome-style canonical titles in Raindrop.
  return [rootName, ...canonicalizeUploadSegments(segs)];
}

/**
 * All Raindrop collections for the allowlist picker / prune / ensure.
 * Skips the bare sync-root collection. `underSyncRoot` marks membership.
 * @returns {{ collectionId: number|string, relativeSegments: string[], underSyncRoot: boolean }[]}
 */
export function collectionsForAllowlistPicker(index, syncRootId) {
  if (!index?.byId) return [];
  const seen = new Set();
  const out = [];
  for (const col of index.byId.values()) {
    if (!col || seen.has(col._id)) continue;
    seen.add(col._id);
    if (syncRootId != null && String(col._id) === String(syncRootId)) continue;
    const relative = mirrorRelativeSegments(index, col._id, syncRootId);
    if (!relative) continue;
    const underSyncRoot =
      syncRootId != null && collectionPathFromRoot(index, col._id, syncRootId).length > 0;
    out.push({ collectionId: col._id, relativeSegments: relative, underSyncRoot });
  }
  return out;
}

/**
 * Resolve a Raindrop collection id from titles relative to `rootId`
 * (e.g. ["Favorites bar", "Work"]). Returns null if any segment is missing.
 */
export function collectionIdFromRelative(index, rootId, relativeSegments) {
  if (!index?.byParent || rootId == null) return null;
  let parentId = rootId;
  let col = getById(index, rootId);
  for (const title of relativeSegments || []) {
    const siblings = getByParent(index, parentId);
    col = siblings?.get((title || "").toLowerCase()) ?? null;
    if (!col) return null;
    parentId = col._id;
  }
  return col ? col._id : null;
}

/**
 * Ensure every collection along `fullSegments` exists (e.g.
 * ["Edge", "Favorites bar", "Work"]) and return the deepest collection's id.
 *
 * `cache` is the path→id map (loaded once per drain, mutated here).
 * `persist(path, id)` writes a warm entry; optional `uncache(path)` drops a
 * stale entry when the cached id is missing from the live index.
 */
export async function ensureCollectionPath(client, index, fullSegments, cache, persist, uncache) {
  const byParent = index.byParent || index;
  let parentId = ROOT;
  let pathSoFar = "";
  let collectionId = null;

  for (const title of fullSegments) {
    pathSoFar = pathSoFar ? `${pathSoFar}/${title}` : title;

    if (cache[pathSoFar] != null) {
      const cachedId = cache[pathSoFar];
      if (collectionIdAlive(index, cachedId)) {
        collectionId = cachedId;
        parentId = collectionId;
        continue;
      }
      // Stale: collection deleted/renamed in Raindrop since we cached the path.
      delete cache[pathSoFar];
      if (typeof uncache === "function") await uncache(pathSoFar);
    }

    // Prefer getByParent when index has byId/byParent shape; fall back for
    // legacy callers that pass a bare byParent Map as `index`.
    const siblings = index.byParent != null ? getByParent(index, parentId) : byParent.get(parentId);
    let col = siblings && siblings.get(title.toLowerCase());
    if (!col) {
      col = await client.createCollection(title, parentId === ROOT ? null : parentId);
      if (!byParent.has(parentId)) byParent.set(parentId, new Map());
      byParent.get(parentId).set(title.toLowerCase(), col);
      if (index.byId) {
        index.byId.set(col._id, col);
        index.byId.set(String(col._id), col);
      }
    }

    collectionId = col._id;
    cache[pathSoFar] = collectionId;
    await persist(pathSoFar, collectionId);
    parentId = collectionId;
  }

  return collectionId;
}

/**
 * Persist Edge folder id → Raindrop collection id for each mirrored segment
 * after ensureCollectionPath has warmed `cache`. Enables in-place folder renames
 * when onChanged lacks the old title.
 *
 * @param {string[]} edgeSegments root-first Edge folder titles (resolveLocation)
 * @param {string[]} ancestorIds nearest-first Edge folder ids
 * @param {string[]} fullSegments Raindrop path from raindropUploadSegments
 * @param {Record<string, string|number>} cache path → collectionId
 * @param {(folderId: string, collectionId: string|number) => Promise<void>} record
 */
export async function recordFolderCollectionsAlongPath(
  edgeSegments,
  ancestorIds,
  fullSegments,
  cache,
  record
) {
  if (typeof record !== "function") return;
  const segs = edgeSegments || [];
  const full = fullSegments || [];
  const edgeIdsRootFirst = [...(ancestorIds || [])].reverse();

  // Under sync root: full = [rootName, ...segs] — zip edge folders to full.slice(1).
  if (full.length === segs.length + 1 && segs.length === edgeIdsRootFirst.length) {
    for (let i = 0; i < segs.length; i++) {
      const path = full.slice(0, i + 2).join("/");
      const colId = cache[path];
      const folderId = edgeIdsRootFirst[i];
      if (colId != null && folderId != null) await record(String(folderId), colId);
    }
    return;
  }

  // Outside-root landing: Other favorites / Raindrop / rest → full = rest.
  if (isOutsideRootLandingSegments(segs)) {
    const restFolders = edgeIdsRootFirst.slice(2);
    for (let i = 0; i < full.length && i < restFolders.length; i++) {
      const path = full.slice(0, i + 1).join("/");
      const colId = cache[path];
      if (colId != null) await record(String(restFolders[i]), colId);
    }
  }
}

/**
 * Persist Edge folder id → Raindrop collection id after a pull/mirror create.
 * Upload learns this via recordFolderCollectionsAlongPath; pull-create must too
 * or Raindrop→Edge folder renames never find a mapping.
 *
 * @param {{ byId?: Map }|null|undefined} index
 * @param {string|number|null|undefined} rootId sync-root collection id (null if unknown)
 * @param {string|number} collectionId leaf Raindrop collection for the path
 * @param {string[]} relativeSegments mirror relative (root title stripped, or Raindrop/…)
 * @param {string[]} edgeAncestorIds nearest-first from the leaf Edge folder
 * @param {(folderId: string, collectionId: string|number) => Promise<void>} record
 */
export async function recordFolderCollectionsForPulledPath(
  index,
  rootId,
  collectionId,
  relativeSegments,
  edgeAncestorIds,
  record
) {
  if (typeof record !== "function" || collectionId == null) return;
  const relative = relativeSegments || [];
  const edgeIds = edgeAncestorIds || [];
  if (!relative.length || !edgeIds.length) return;

  // Under sync root: zip relative segments to collections between leaf and root.
  if (rootId != null && collectionPathFromRoot(index, collectionId, rootId).length) {
    const colIds = [];
    const result = walkCollectionAncestors(index, collectionId, (col) => {
      if (String(col._id) === String(rootId)) return "stop";
      colIds.push(col._id);
      return "continue";
    });
    if (!result.ok || result.hitTop) return;
    if (colIds.length !== relative.length) return;
    for (let i = 0; i < colIds.length; i++) {
      const folderId = edgeIds[i];
      if (folderId != null) await record(String(folderId), colIds[i]);
    }
    return;
  }

  // Outside sync root: relative is [Raindrop, ...absolute]; map absolute only.
  if ((relative[0] || "").toLowerCase() !== OUTSIDE_ROOT_MIRROR_FOLDER.toLowerCase()) {
    return;
  }
  const colIds = [];
  const walked = walkCollectionAncestors(index, collectionId, (col) => {
    colIds.push(col._id);
    return "continue";
  });
  if (!walked.ok || !colIds.length) return;
  for (let i = 0; i < colIds.length && i < edgeIds.length; i++) {
    await record(String(edgeIds[i]), colIds[i]);
  }
}

/**
 * Keep an in-memory collection index consistent after PUT /collection title.
 * @param {{ byParent?: Map, byId?: Map }|null|undefined} index
 * @param {string|number} collectionId
 * @param {string} newTitle
 */
export function applyCollectionTitleInIndex(index, collectionId, newTitle) {
  const col = getById(index, collectionId);
  if (!col) return;
  const parentId = col.parent && col.parent.$id != null ? col.parent.$id : ROOT;
  const siblings = getByParent(index, parentId);
  if (siblings) {
    siblings.delete((col.title || "").toLowerCase());
    col.title = newTitle;
    siblings.set((newTitle || "").toLowerCase(), col);
  } else {
    col.title = newTitle;
  }
}
