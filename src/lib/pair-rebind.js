// Stale-id rebind rules for pair records (docs/sync-engine-rewrite.md §1).
//
// Edge bookmark ids and Raindrop ids can both go stale without the user
// deleting anything: Chromium renumbers ids on a Bookmarks checksum mismatch,
// and a trashed duplicate leaves its original alive under another id. A stale
// id is resolved by URL, never by deleting:
//
//   stale Edge id     → same urlKey under edgePathAtSync, else anywhere in the
//                       synced scope; never a bookmark bound to another pair.
//   stale Raindrop id → oldest snapshot id carrying the URL that is not bound
//                       to another live bookmark (pickMoveRebindCandidate).
//
// Only a record whose URL survives nowhere becomes a delete-evidence candidate,
// and the rebind pass itself never enqueues a delete. Everything here is pure
// over (records, tree index, snapshot) so engine, migration, Match and Repair
// share one implementation.

import { primaryUrlKey, urlMatchKeys } from "./url-match.js";
import { makePairRecord, pairsView } from "./store.js";
import { pickMoveRebindCandidate } from "./move-rebind.js";
import { treeEntriesForUrl, compareIds } from "./tree-index.js";
import { idsForUrl } from "./presence.js";

/**
 * @typedef {import("./store.js").PairRecord} PairRecord
 * @typedef {import("./store.js").PairChange} PairChange
 * @typedef {import("./tree-index.js").TreeIndex} TreeIndex
 * @typedef {import("./tree-index.js").TreeEntry} TreeEntry
 * @typedef {import("./presence.js").PresenceSnapshot} PresenceSnapshot
 */

/** Record URL, falling back to its stored key (legacy records may lack url). */
function recordUrl(record) {
  return record?.url || record?.urlKey || null;
}

/**
 * Whether `entry` (tree entry or bookmark node at the record's bookmark id) is
 * still the bookmark `record` is paired with. An id alone is not identity:
 * Chromium renumbers from 1, so an old id can come back on an unrelated
 * bookmark. The id counts only when the URLs share a match key, or when an
 * upload for it is queued (the record's URL lags a local edit until that job
 * lands). A record without a URL falls back to the id.
 * @param {PairRecord|null|undefined} record
 * @param {{ id: string, url?: string }|null|undefined} entry
 * @param {Set<string>|null} [pendingBookmarkIds] ids with a queued upload
 */
export function isPairBookmarkLive(record, entry, pendingBookmarkIds = null) {
  if (!entry?.url) return false;
  if (pendingBookmarkIds?.has(String(entry.id))) return true;
  const url = recordUrl(record);
  if (!url) return true;
  const keys = new Set(urlMatchKeys(url));
  return urlMatchKeys(entry.url).some((k) => keys.has(k));
}

/**
 * Bookmark ids that are live for the record paired to them
 * ({@link isPairBookmarkLive}).
 * @param {Record<string, PairRecord>} records
 * @param {TreeIndex} treeIndex
 * @param {Set<string>|null} [pendingBookmarkIds]
 * @returns {Set<string>}
 */
export function livePairBookmarkIds(records, treeIndex, pendingBookmarkIds = null) {
  const ids = new Set();
  for (const rec of Object.values(records || {})) {
    if (rec?.bookmarkId == null) continue;
    const bid = String(rec.bookmarkId);
    if (isPairBookmarkLive(rec, treeIndex.byId.get(bid), pendingBookmarkIds)) ids.add(bid);
  }
  return ids;
}

/** Same folder path (titles, top root down). */
function samePath(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

/**
 * In-scope live bookmarks for `url` that may carry raindrop `rid`: unpaired,
 * or already paired to `rid`. Id order (treeEntriesForUrl sorts by id).
 * @returns {TreeEntry[]}
 */
export function edgeSurvivorCandidates(treeIndex, url, rid, pairs) {
  return treeEntriesForUrl(treeIndex, url).filter((entry) => {
    if (!entry.inScope) return false;
    const bound = pairs.byBookmark?.[entry.id];
    return bound == null || String(bound) === rid;
  });
}

/**
 * Find a live bookmark for a record whose bookmark id is gone from the tree.
 * @param {PairRecord} record
 * @param {TreeIndex} treeIndex
 * @param {{ byBookmark: Record<string, string> }} pairs current forward links
 * @returns {{ entry: TreeEntry, samePath: boolean }|null}
 */
export function rebindStaleEdgeId(record, treeIndex, pairs) {
  const url = recordUrl(record);
  if (!url) return null;
  const rid = String(record.raindropId);
  const candidates = edgeSurvivorCandidates(treeIndex, url, rid, pairs);
  if (!candidates.length) return null;
  const underPath = candidates.filter((e) => samePath(e.path, record.edgePathAtSync));
  const pick = (underPath.length ? underPath : candidates).sort(compareIds)[0];
  return { entry: pick, samePath: underPath.length > 0 };
}

/**
 * Find a surviving raindrop for a record whose raindrop id is absent from the
 * snapshot. Oldest claimable id wins.
 * @param {PairRecord} record
 * @param {PresenceSnapshot} snapshot
 * @param {{ byBookmark: Record<string, string>, byRaindrop: Record<string, string> }} pairs
 * @param {Set<string>} liveBookmarkIds live Edge bookmark ids
 * @returns {{ raindropId: string, extras: number }|null}
 */
export function rebindStaleRaindropId(record, snapshot, pairs, liveBookmarkIds) {
  const url = recordUrl(record);
  if (!url) return null;
  const rid = String(record.raindropId);
  const items = idsForUrl(snapshot, url)
    .filter((id) => id !== rid)
    .map((id) => ({ _id: id }));
  if (!items.length) return null;
  const bid = record.bookmarkId != null ? String(record.bookmarkId) : "";
  const pick = pickMoveRebindCandidate(bid, items, pairs, liveBookmarkIds, snapshot.ids);
  if (pick.kind !== "unique" && pick.kind !== "multi") return null;
  return { raindropId: pick.rid, extras: pick.extras || 0 };
}

/** Record fields refreshed from a live tree entry. */
export function placementFromEntry(entry) {
  return {
    bookmarkId: entry.id,
    edgeParentId: entry.parentId,
    edgePathAtSync: entry.path,
  };
}

/**
 * Walk every record and resolve stale ids by URL.
 *
 * Edge side runs whenever a tree index is given. Raindrop side runs only when
 * `snapshot` is usable for URL lookups (complete, fresh, URL-indexed); pass
 * null otherwise. Records written after the export began
 * (lastSeenRaindropAt > snapshot.at) are never judged absent.
 *
 * @param {{
 *   records: Record<string, PairRecord>,
 *   treeIndex: TreeIndex,
 *   snapshot?: PresenceSnapshot|null,
 *   urlHints?: Map<string, string>|null,
 *   pendingBookmarkIds?: Set<string>|null,
 *   now?: number,
 * }} input
 *   `urlHints` maps raindrop id → link from another listing (Trash) for
 *   id-only records the tree and export cannot fill. `pendingBookmarkIds`
 *   are bookmark ids with a queued upload ({@link isPairBookmarkLive}).
 * @returns {{
 *   records: Record<string, PairRecord>,
 *   changes: PairChange[],
 *   edgeRebinds: { raindropId: string, from: string|null, to: string, title: string|null, samePath: boolean }[],
 *   raindropRebinds: { from: string, to: string, bookmarkId: string|null, title: string|null, replacedBookmarkId: string|null }[],
 *   staleEdge: string[],
 *   raindropCandidates: string[],
 *   unresolvedRaindrop: string[],
 * }}
 */
export function rebindPass({
  records: input,
  treeIndex,
  snapshot = null,
  urlHints = null,
  pendingBookmarkIds = null,
  now = Date.now(),
}) {
  /** @type {Record<string, PairRecord>} */
  const records = {};
  for (const [rid, rec] of Object.entries(input || {})) records[rid] = { ...rec };
  /** @type {PairChange[]} */
  const changes = [];
  const edgeRebinds = [];
  const raindropRebinds = [];
  const staleEdge = [];
  const raindropCandidates = [];
  const unresolvedRaindrop = [];

  // One mutable index, updated as rebinds land (rebuilding per record is
  // quadratic after a full Chromium renumber).
  const { byBookmark, byRaindrop } = pairsView({ records });
  const view = { byBookmark, byRaindrop };

  // Fill URL for id-only records (v1 migration, old callers). The raindrop's
  // own link wins: after a renumber the node at the old id may be another
  // bookmark. The node fills only when the export has no link for the id, and
  // lends its placement only when its URL agrees.
  for (const [rid, rec] of Object.entries(records)) {
    if (rec.url) continue;
    const entry = rec.bookmarkId != null ? treeIndex.byId.get(String(rec.bookmarkId)) : null;
    const url = snapshot?.urlById?.get(rid) ?? urlHints?.get(rid) ?? entry?.url ?? null;
    if (!url) continue;
    const placed = entry && isPairBookmarkLive({ url }, entry) ? entry : null;
    const next = makePairRecord(rid, {
      ...rec,
      ...(placed ? placementFromEntry(placed) : {}),
      url,
      urlKey: primaryUrlKey(url),
      title: rec.title ?? placed?.title ?? null,
      ...(placed ? { lastSeenEdgeAt: now } : {}),
    });
    changes.push({ type: "fill", raindropId: rid, bookmarkId: rec.bookmarkId, record: next });
    records[rid] = next;
  }

  // Edge side: bookmark id gone from the tree, or reused by another bookmark.
  const edgeLive = (rec) =>
    rec.bookmarkId != null &&
    isPairBookmarkLive(rec, treeIndex.byId.get(String(rec.bookmarkId)), pendingBookmarkIds);
  // A reused id is free for the pair whose bookmark it now is (renumbers can
  // swap or chain ids between pairs).
  for (const [bid, rid] of Object.entries(byBookmark)) {
    if (treeIndex.byId.has(bid) && !edgeLive(records[rid])) {
      delete byBookmark[bid];
      delete byRaindrop[rid];
    }
  }
  for (const rid of Object.keys(records).sort(compareIds)) {
    const rec = records[rid];
    if (!rec) continue;
    const bid = rec.bookmarkId != null ? String(rec.bookmarkId) : null;
    if (edgeLive(rec)) continue;
    const hit = rebindStaleEdgeId(rec, treeIndex, view);
    if (!hit) {
      staleEdge.push(rid);
      continue;
    }
    const next = makePairRecord(rid, {
      ...rec,
      ...placementFromEntry(hit.entry),
      lastSeenEdgeAt: now,
    });
    changes.push({ type: "edge", raindropId: rid, fromBookmarkId: bid, record: next });
    if (bid != null && byBookmark[bid] === rid) delete byBookmark[bid];
    byBookmark[hit.entry.id] = rid;
    byRaindrop[rid] = hit.entry.id;
    edgeRebinds.push({
      raindropId: rid,
      from: bid,
      to: hit.entry.id,
      title: rec.title || hit.entry.title || null,
      samePath: hit.samePath,
    });
    records[rid] = next;
  }

  if (snapshot) {
    const liveBookmarkIds = livePairBookmarkIds(records, treeIndex, pendingBookmarkIds);
    for (const rid of Object.keys(records).sort(compareIds)) {
      const rec = records[rid];
      if (!rec || snapshot.ids.has(rid)) continue;
      if (rec.lastSeenRaindropAt != null && rec.lastSeenRaindropAt > snapshot.at) continue;
      if (!recordUrl(rec)) {
        unresolvedRaindrop.push(rid);
        continue;
      }
      const hit = rebindStaleRaindropId(rec, snapshot, view, liveBookmarkIds);
      // A record already on the survivor may only be replaced when its own
      // bookmark id is dead (the renumber + fork shape: merge into one pair).
      const occupant = hit ? records[hit.raindropId] : null;
      const occupantLive =
        occupant?.bookmarkId != null &&
        isPairBookmarkLive(
          occupant,
          treeIndex.byId.get(String(occupant.bookmarkId)),
          pendingBookmarkIds
        );
      if (!hit || occupantLive) {
        raindropCandidates.push(rid);
        continue;
      }
      const next = makePairRecord(hit.raindropId, { ...rec, lastSeenRaindropAt: now });
      changes.push({
        type: "raindrop",
        fromRaindropId: rid,
        toRaindropId: hit.raindropId,
        replacesBookmarkId: occupant ? occupant.bookmarkId : null,
        record: next,
      });
      if (
        occupant?.bookmarkId != null &&
        byBookmark[String(occupant.bookmarkId)] === hit.raindropId
      ) {
        delete byBookmark[String(occupant.bookmarkId)];
      }
      raindropRebinds.push({
        from: rid,
        to: hit.raindropId,
        bookmarkId: rec.bookmarkId,
        title: rec.title || rec.url || null,
        replacedBookmarkId: occupant ? occupant.bookmarkId : null,
      });
      delete records[rid];
      records[hit.raindropId] = next;
      delete byRaindrop[rid];
      if (rec.bookmarkId != null) {
        byBookmark[String(rec.bookmarkId)] = hit.raindropId;
        byRaindrop[hit.raindropId] = String(rec.bookmarkId);
      }
    }
  }

  return {
    records,
    changes,
    edgeRebinds,
    raindropRebinds,
    staleEdge,
    raindropCandidates,
    unresolvedRaindrop,
  };
}

/** Max individual "Rebound:" lines per pass; the rest go in one summary line. */
export const REBIND_LOG_LINES = 20;

/**
 * Activity-log lines for applied rebinds.
 * @param {{ edgeRebinds: { title: string|null, to: string }[], raindropRebinds: { title: string|null, to: string }[] }} pass
 * @returns {string[]}
 */
export function rebindLogLines({ edgeRebinds, raindropRebinds }) {
  const lines = [
    ...edgeRebinds.map((r) => `Rebound: ${r.title || r.to} (Edge id changed)`),
    ...raindropRebinds.map((r) => `Rebound: ${r.title || r.to} (Raindrop id changed)`),
  ];
  if (lines.length <= REBIND_LOG_LINES) return lines;
  const shown = lines.slice(0, REBIND_LOG_LINES);
  shown.push(
    `Rebound ${lines.length - REBIND_LOG_LINES} more pair(s) by URL ` +
      `(${edgeRebinds.length} Edge, ${raindropRebinds.length} Raindrop in total).`
  );
  return shown;
}
