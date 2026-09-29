// In-memory index over the Edge bookmark tree for URL lookups by the rebind,
// survival-check and pair-health code. Built from one getTree() read.
//
// "Synced scope" is where a surviving copy of a URL counts: every URL bookmark
// whose effective folder policy is not `exclude`, except that the outside-root
// landing zone (Other favorites / Raindrop / …) counts only while a Raindrop
// allowlist is active. A copy outside that scope does not keep a raindrop
// alive and is never rebound to.

import { urlMatchKeys } from "./url-match.js";
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
 *   parentId: string|null,
 *   path: string[],
 *   ancestorIds: string[],
 *   inScope: boolean,
 * }} TreeEntry
 *
 * @typedef {{
 *   byId: Map<string, TreeEntry>,
 *   byUrlKey: Map<string, string[]>,
 * }} TreeIndex
 */

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
  const walk = (node, path, ancestorIds) => {
    for (const child of node.children ?? []) {
      if (child.url) {
        const entry = {
          id: String(child.id),
          url: String(child.url),
          title: child.title || "",
          parentId: child.parentId != null ? String(child.parentId) : null,
          path,
          ancestorIds,
          inScope: false,
        };
        entry.inScope = !!isInScope(entry);
        byId.set(entry.id, entry);
        for (const key of urlMatchKeys(entry.url)) {
          const list = byUrlKey.get(key) || [];
          list.push(entry.id);
          byUrlKey.set(key, list);
        }
      } else {
        walk(child, [...path, child.title || ""], [String(child.id), ...ancestorIds]);
      }
    }
  };
  for (const root of roots || []) walk(root, [], []);
  return { byId, byUrlKey };
}

/**
 * Tree index from a flat list (tests, Repair inputs without folder structure).
 * @param {{ id: string, url: string, title?: string, parentId?: string, path?: string[], ancestorIds?: string[], inScope?: boolean }[]} list
 * @returns {TreeIndex}
 */
export function treeIndexFromList(list) {
  const byId = new Map();
  const byUrlKey = new Map();
  for (const b of list || []) {
    if (!b?.url) continue;
    const entry = {
      id: String(b.id),
      url: String(b.url),
      title: b.title || "",
      parentId: b.parentId != null ? String(b.parentId) : null,
      path: b.path || [],
      ancestorIds: b.ancestorIds || [],
      inScope: b.inScope !== false,
    };
    byId.set(entry.id, entry);
    for (const key of urlMatchKeys(entry.url)) {
      const ids = byUrlKey.get(key) || [];
      ids.push(entry.id);
      byUrlKey.set(key, ids);
    }
  }
  return { byId, byUrlKey };
}

/**
 * Tree entries whose URL shares a match key with `url`, in id order.
 * @param {TreeIndex} treeIndex
 * @param {string} url
 * @returns {TreeEntry[]}
 */
export function treeEntriesForUrl(treeIndex, url) {
  if (!url) return [];
  const seen = new Set();
  const out = [];
  for (const key of urlMatchKeys(url)) {
    for (const id of treeIndex.byUrlKey.get(key) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = treeIndex.byId.get(id);
      if (entry) out.push(entry);
    }
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
