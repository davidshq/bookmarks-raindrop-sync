// Resolve an existing Raindrop by URL instead of creating a second copy.
// Claim rules match Match-existing (`classifyPairClaim`); pair-rebind.js uses
// the same pick for stale Raindrop ids.

import { urlMatchKind } from "./url-match.js";
import { classifyPairClaim } from "./match-existing.js";

/**
 * Keep search hits that match `edgeUrl`: exact primary key first; a lone loose
 * (tracking-param) hit only when no exact hit exists. Never merges distinct
 * content-selecting query variants (?v=A vs ?v=B).
 * @param {string} edgeUrl
 * @param {{ _id?: number|string, link?: string }[]} items
 * @returns {{ _id: number|string, link?: string }[]}
 */
export function filterUrlMatchingItems(edgeUrl, items) {
  /** @type {{ item: { _id: number|string, link?: string }, kind: 'exact'|'loose' }[]} */
  const classified = [];
  for (const item of items || []) {
    if (!item || item._id == null) continue;
    const kind = urlMatchKind(edgeUrl, item.link || "");
    if (kind) classified.push({ item, kind });
  }
  const exact = classified.filter((c) => c.kind === "exact").map((c) => c.item);
  if (exact.length) return exact;
  const loose = classified.filter((c) => c.kind === "loose").map((c) => c.item);
  if (loose.length === 1) return loose;
  return [];
}

/**
 * @typedef {{
 *   kind: 'unique' | 'multi' | 'conflict' | 'none',
 *   rid?: string,
 *   extras?: number,
 * }} MoveRebindPick
 */

/**
 * Pick a claimable raindrop id by URL (oldest id wins on multi). Used by
 * upload reclaim, the stale-Raindrop-id rebind, and survival checks.
 * @param {string} bookmarkId
 * @param {{ _id?: number|string }[]} matchingItems URL-filtered hits
 * @param {{ byBookmark?: Record<string, string>, byRaindrop?: Record<string, string> }} pairs
 * @param {Set<string>} liveIds live Edge bookmark ids
 * @param {Set<string>} [liveRaindropIds] snapshot ids; a forward link to an id
 *   outside it is stale (rebindable), not a conflict
 * @returns {MoveRebindPick}
 */
export function pickMoveRebindCandidate(
  bookmarkId,
  matchingItems,
  pairs,
  liveIds,
  liveRaindropIds
) {
  const items = matchingItems || [];
  if (!items.length) return { kind: "none" };

  /** @type {{ rid: string }[]} */
  const claimable = [];
  for (const item of items) {
    const rid = String(item._id);
    const verdict = classifyPairClaim(bookmarkId, rid, pairs, liveIds, liveRaindropIds);
    if (verdict === "conflict") continue;
    claimable.push({ rid });
  }

  if (!claimable.length) return { kind: "conflict" };

  claimable.sort((a, b) => {
    const na = Number(a.rid);
    const nb = Number(b.rid);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0;
  });

  const rid = claimable[0].rid;
  if (claimable.length === 1) return { kind: "unique", rid, extras: 0 };
  return { kind: "multi", rid, extras: claimable.length - 1 };
}
