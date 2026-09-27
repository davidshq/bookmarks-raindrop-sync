// Resolve an existing Raindrop by URL when an unpaired Edge move would otherwise
// create a second copy. Claim rules match Match-existing (`classifyPairClaim`).

import { urlMatchKeys } from "./url-match.js";
import { classifyPairClaim } from "./match-existing.js";

/**
 * Keep search hits whose link shares a stable URL match key with `edgeUrl`.
 * @param {string} edgeUrl
 * @param {{ _id?: number|string, link?: string }[]} items
 * @returns {{ _id: number|string, link?: string }[]}
 */
export function filterUrlMatchingItems(edgeUrl, items) {
  const want = new Set(urlMatchKeys(edgeUrl));
  if (!want.size) return [];
  const out = [];
  for (const item of items || []) {
    if (!item || item._id == null) continue;
    const keys = urlMatchKeys(item.link || "");
    if (keys.some((k) => want.has(k))) out.push(item);
  }
  return out;
}

/**
 * @typedef {{
 *   kind: 'unique' | 'multi' | 'conflict' | 'none',
 *   rid?: string,
 *   extras?: number,
 * }} MoveRebindPick
 */

/**
 * Pick a claimable raindrop id for an unpaired move (oldest id wins on multi).
 * @param {string} bookmarkId
 * @param {{ _id?: number|string }[]} matchingItems URL-filtered hits
 * @param {{ byBookmark?: Record<string, string>, byRaindrop?: Record<string, string> }} pairs
 * @param {Set<string>} liveIds
 * @returns {MoveRebindPick}
 */
export function pickMoveRebindCandidate(bookmarkId, matchingItems, pairs, liveIds) {
  const items = matchingItems || [];
  if (!items.length) return { kind: "none" };

  /** @type {{ rid: string }[]} */
  const claimable = [];
  for (const item of items) {
    const rid = String(item._id);
    const verdict = classifyPairClaim(bookmarkId, rid, pairs, liveIds);
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
