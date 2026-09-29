// Resolve an existing Raindrop by URL instead of creating a second copy.
// Claim rules match Match-existing (`classifyPairClaim`); pair-rebind.js uses
// the same pick for stale Raindrop ids.

import { pickUrlMatches } from "./url-match.js";
import { classifyPairClaim } from "./match-existing.js";
import { compareIds } from "./tree-index.js";

/**
 * Keep search hits that match `edgeUrl`: exact primary key first; a lone loose
 * (tracking-param) hit only when no exact hit exists. Never merges distinct
 * content-selecting query variants (?v=A vs ?v=B).
 * @param {string} edgeUrl
 * @param {{ _id?: number|string, link?: string }[]} items
 * @returns {{ _id: number|string, link?: string }[]}
 */
export function filterUrlMatchingItems(edgeUrl, items) {
  const withIds = (items || []).filter((item) => item && item._id != null);
  return pickUrlMatches(edgeUrl, withIds, (item) => item.link);
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

  const claimable = items
    .map((item) => String(item._id))
    .filter(
      (rid) => classifyPairClaim(bookmarkId, rid, pairs, liveIds, liveRaindropIds) !== "conflict"
    );

  if (!claimable.length) return { kind: "conflict" };

  claimable.sort(compareIds);

  const rid = claimable[0];
  if (claimable.length === 1) return { kind: "unique", rid, extras: 0 };
  return { kind: "multi", rid, extras: claimable.length - 1 };
}
