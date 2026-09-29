// Pair health for Options → Status (docs/sync-engine-rewrite.md §6).
//
// Computed from the pair records, the Edge tree and the presence snapshot with
// no extra requests, after each completed reconcile finish and after Repair
// apply. The Status page only renders the stored result; it never fetches the
// export itself. URL counts use each URL's primary match key and only Edge
// bookmarks in the synced scope.

import { primaryUrlKey } from "./url-match.js";
import { isPairBookmarkLive } from "./pair-rebind.js";

/**
 * @typedef {{
 *   at: number,
 *   pairs: number,
 *   liveLive: number,
 *   staleEdgeId: number,
 *   staleRaindropId: number|null,
 *   edgeOnlyUrls: number|null,
 *   raindropOnlyUrls: number|null,
 *   duplicateUrlGroupsEdge: number,
 *   duplicateUrlGroupsRaindrop: number|null,
 *   snapshotAt: number|null,
 *   snapshotAgeMs: number|null,
 *   complete: boolean,
 *   urlIndexed: boolean,
 * }} PairHealth
 *
 * Counts that need the snapshot are null when there is none; URL counts on the
 * Raindrop side are null when the snapshot has no URL index (restored ids only).
 */

/**
 * @param {{
 *   records: Record<string, import("./store.js").PairRecord>,
 *   treeIndex: import("./tree-index.js").TreeIndex,
 *   snapshot?: import("./presence.js").PresenceSnapshot|null,
 *   now?: number,
 * }} input
 * @returns {PairHealth}
 */
export function computePairHealth({ records, treeIndex, snapshot = null, now = Date.now() }) {
  let liveLive = 0;
  let staleEdgeId = 0;
  let staleRaindropId = 0;
  for (const [rid, rec] of Object.entries(records || {})) {
    const edgeLive =
      rec?.bookmarkId != null &&
      isPairBookmarkLive(rec, treeIndex.byId.get(String(rec.bookmarkId)));
    const rdLive = snapshot ? snapshot.ids.has(rid) : null;
    if (!edgeLive) staleEdgeId++;
    if (rdLive === false) staleRaindropId++;
    if (edgeLive && rdLive) liveLive++;
  }

  /** @type {Map<string, number>} */
  const edgeKeys = new Map();
  for (const entry of treeIndex.byId.values()) {
    if (!entry.inScope) continue;
    const key = primaryUrlKey(entry.url);
    if (key) edgeKeys.set(key, (edgeKeys.get(key) || 0) + 1);
  }
  let duplicateUrlGroupsEdge = 0;
  for (const n of edgeKeys.values()) if (n > 1) duplicateUrlGroupsEdge++;

  const urlIndexed = !!snapshot?.urlIndexed;
  let edgeOnlyUrls = null;
  let raindropOnlyUrls = null;
  let duplicateUrlGroupsRaindrop = null;
  if (urlIndexed) {
    /** @type {Map<string, number>} */
    const rdKeys = new Map();
    for (const url of snapshot.urlById.values()) {
      const key = primaryUrlKey(url);
      if (key) rdKeys.set(key, (rdKeys.get(key) || 0) + 1);
    }
    edgeOnlyUrls = 0;
    for (const [key] of edgeKeys) {
      // byUrlKey holds every match key, so query / slash noise is not "Edge-only".
      if (!snapshot.byUrlKey.has(key)) edgeOnlyUrls++;
    }
    const edgeAllKeys = new Set(treeIndex.byUrlKey.keys());
    raindropOnlyUrls = 0;
    duplicateUrlGroupsRaindrop = 0;
    for (const [key, n] of rdKeys) {
      if (n > 1) duplicateUrlGroupsRaindrop++;
      if (!edgeAllKeys.has(key)) raindropOnlyUrls++;
    }
  }

  return {
    at: now,
    pairs: Object.keys(records || {}).length,
    liveLive,
    staleEdgeId,
    staleRaindropId: snapshot ? staleRaindropId : null,
    edgeOnlyUrls,
    raindropOnlyUrls,
    duplicateUrlGroupsEdge,
    duplicateUrlGroupsRaindrop,
    snapshotAt: snapshot?.at ?? null,
    snapshotAgeMs: snapshot ? Math.max(0, now - snapshot.at) : null,
    complete: !!snapshot?.complete,
    urlIndexed,
  };
}

/**
 * One-line Status summary. `now` re-ages the snapshot for display.
 * @param {PairHealth|null|undefined} h
 * @param {number} [now]
 * @returns {string|null}
 */
export function formatPairHealth(h, now = Date.now()) {
  if (!h) return null;
  const n = (v) => (v == null ? "?" : String(v));
  const age =
    h.snapshotAt != null ? `${Math.max(0, Math.round((now - h.snapshotAt) / 60000))} min` : "none";
  return (
    `Pairs ${h.pairs}: ${h.liveLive} live↔live, ${h.staleEdgeId} stale Edge id, ` +
    `${n(h.staleRaindropId)} stale Raindrop id. ` +
    `Edge-only URLs ${n(h.edgeOnlyUrls)}, Raindrop-only URLs ${n(h.raindropOnlyUrls)}. ` +
    `Duplicate URL groups: Edge ${h.duplicateUrlGroupsEdge}, Raindrop ${n(h.duplicateUrlGroupsRaindrop)}. ` +
    `Snapshot age ${age}${h.complete ? "" : " (incomplete)"}.`
  );
}

/** True when Status should offer Repair pairs. */
export function pairHealthNeedsRepair(h) {
  return !!h && (h.staleEdgeId > 0 || (h.staleRaindropId ?? 0) > 0);
}
