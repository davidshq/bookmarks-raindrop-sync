// In-memory index over the Edge bookmark tree for URL lookups by the rebind,
// survival-check and pair-health code. Built from one getTree() read.
//
// "Synced scope" is where a surviving copy of a URL counts: every URL bookmark
// whose effective folder policy is not `exclude`, except that the outside-root
// landing zone (Other favorites / Raindrop / …) counts only while a Raindrop
// allowlist is active. A copy outside that scope does not keep a raindrop
// alive and is never rebound to.

import { indexUrlKeys, resolveIndexedUrls } from "./url-match.js";
import { isExcluded } from "./policy.js";
import { isOutsideRootLandingSegments } from "./collections.js";
import { isAllowlistActive } from "./allowlist.js";
import { getTree } from "./bookmarks.js";
import { getConfig, getOverrides } from "./store.js";

/**
 * @typedef {{
 *   id: string,
 *   url: string,
 *   title: string,
 *   dateAdded: number|null,
 *   parentId: string|null,
 *   path: string[],
 *   ancestorIds: string[],
 *   inScope: boolean,
 * }} TreeEntry
 *
 * @typedef {{
 *   byId: Map<string, TreeEntry>,
 *   byUrlKey: Map<string, string[]>,
 *   byDateAdded?: Map<number, string[]>,
 * }} TreeIndex
 */

/** File `entry` under its dateAdded (the id-independent identity). */
function indexDateAdded(byDateAdded, entry) {
  if (typeof entry.dateAdded !== "number") return;
  const list = byDateAdded.get(entry.dateAdded);
  if (list) list.push(entry.id);
  else byDateAdded.set(entry.dateAdded, [entry.id]);
}

/**
 * Entries whose dateAdded equals `dateAdded` (normally one; imports and burst
 * creates can share a millisecond).
 * @param {TreeIndex} treeIndex
 * @param {number|null|undefined} dateAdded
 * @returns {TreeEntry[]}
 */
export function treeEntriesByDateAdded(treeIndex, dateAdded) {
  if (typeof dateAdded !== "number") return [];
  return (treeIndex.byDateAdded?.get(dateAdded) || [])
    .map((id) => treeIndex.byId.get(id))
    .filter(Boolean);
}

/**
 * Scope predicate over a tree entry's folder path and ancestor ids.
 * @param {{ overrides?: object, defaultPolicy?: string, allowlistActive?: boolean }} opts
 * @returns {(entry: { path: string[], ancestorIds: string[] }) => boolean}
 */
export function makeScopePredicate({ overrides = {}, defaultPolicy, allowlistActive = false }) {
  return (entry) => {
    if (isExcluded(entry.ancestorIds, overrides, defaultPolicy)) return false;
    if (isOutsideRootLandingSegments(entry.path)) return !!allowlistActive;
    return true;
  };
}

/**
 * Index URL bookmarks under the given roots (as returned by getTree()).
 * `path` is folder titles from the top root down to the parent (same shape as
 * resolveLocation().segments); `ancestorIds` is nearest-first.
 * @param {object[]} roots
 * @param {{ isInScope?: (entry: { path: string[], ancestorIds: string[] }) => boolean }} [opts]
 * @returns {TreeIndex}
 */
export function buildTreeIndex(roots, { isInScope = () => true } = {}) {
  /** @type {Map<string, TreeEntry>} */
  const byId = new Map();
  /** @type {Map<string, string[]>} */
  const byUrlKey = new Map();
  /** @type {Map<number, string[]>} */
  const byDateAdded = new Map();
  const walk = (node, path, ancestorIds) => {
    for (const child of node.children ?? []) {
      if (child.url) {
        const entry = {
          id: String(child.id),
          url: String(child.url),
          title: child.title || "",
          dateAdded: child.dateAdded ?? null,
          parentId: child.parentId != null ? String(child.parentId) : null,
          path,
          ancestorIds,
          inScope: false,
        };
        entry.inScope = !!isInScope(entry);
        byId.set(entry.id, entry);
        indexUrlKeys(byUrlKey, entry.url, entry.id);
        indexDateAdded(byDateAdded, entry);
      } else {
        walk(child, [...path, child.title || ""], [String(child.id), ...ancestorIds]);
      }
    }
  };
  for (const root of roots || []) walk(root, [], []);
  return { byId, byUrlKey, byDateAdded };
}

/**
 * Tree index from a flat list (tests, Repair inputs without folder structure).
 * @param {{ id: string, url: string, title?: string, parentId?: string, path?: string[], ancestorIds?: string[], inScope?: boolean }[]} list
 * @returns {TreeIndex}
 */
export function treeIndexFromList(list) {
  const byId = new Map();
  const byUrlKey = new Map();
  /** @type {Map<number, string[]>} */
  const byDateAdded = new Map();
  for (const b of list || []) {
    if (!b?.url) continue;
    const entry = {
      id: String(b.id),
      url: String(b.url),
      title: b.title || "",
      dateAdded: b.dateAdded ?? null,
      parentId: b.parentId != null ? String(b.parentId) : null,
      path: b.path || [],
      ancestorIds: b.ancestorIds || [],
      inScope: b.inScope !== false,
    };
    byId.set(entry.id, entry);
    indexUrlKeys(byUrlKey, entry.url, entry.id);
    indexDateAdded(byDateAdded, entry);
  }
  return { byId, byUrlKey, byDateAdded };
}

/**
 * Tree entries matching `url` (exact key first; loose only if unique), id order.
 * @param {TreeIndex} treeIndex
 * @param {string} url
 * @returns {TreeEntry[]}
 */
export function treeEntriesForUrl(treeIndex, url) {
  if (!url || !treeIndex) return [];
  const { ids } = resolveIndexedUrls(treeIndex.byUrlKey, url, (id) => treeIndex.byId.get(id)?.url);
  const out = [];
  for (const id of ids) {
    const entry = treeIndex.byId.get(id);
    if (entry) out.push(entry);
  }
  return out.sort(compareIds);
}

/** Numeric-aware id order (Chromium ids are decimal strings). */
export function compareIds(a, b) {
  const x = typeof a === "object" ? a.id : a;
  const y = typeof b === "object" ? b.id : b;
  const nx = Number(x);
  const ny = Number(y);
  if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Read the live tree with scope flags from current config and overrides.
 * @returns {Promise<TreeIndex>}
 */
export async function loadTreeIndex() {
  const config = await getConfig();
  const overrides = await getOverrides();
  const isInScope = makeScopePredicate({
    overrides,
    defaultPolicy: config.defaultPolicy,
    allowlistActive: isAllowlistActive(config.raindropFolderAllowlist),
  });
  return buildTreeIndex(await getTree(), { isInScope });
}
