// Bulk lane v1: Match existing — link Edge bookmarks to Raindrop export.csv by URL.
// Dry-run then apply; no deletes, moves, or raindrop creates.

import { collectAllBookmarks } from "./bookmarks.js";
import { indexExportByUrl } from "./export-csv.js";
import { urlMatchKeys } from "./url-match.js";
import { RaindropClient, RateLimitError, AuthError } from "./raindrop.js";
import { handleClientError } from "./client-errors.js";
import {
  getConfig,
  getPairs,
  recordSynced,
  appendLog,
  isRateLimited,
  ensurePairsMigrated,
} from "./store.js";

/**
 * @typedef {{
 *   bookmarkId: string,
 *   raindropId: string,
 * }} MatchPair
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   matched: MatchPair[],
 *   alreadyPaired: number,
 *   ambiguous: number,
 *   conflicts: number,
 *   edgeOnly: number,
 *   raindropOnly: number,
 *   edgeScanned: number,
 *   raindropCount: number,
 *   error?: string,
 *   reason?: string,
 * }} MatchPlan
 */

/**
 * Build a Match existing plan from CSV text + current Edge bookmarks / pairs.
 * Pure aside from bookmark/pair reads when used via planMatchExisting().
 * @param {string} csvText
 * @param {{ id: string, url: string }[]} edgeBookmarks
 * @param {{ byBookmark: Record<string, string>, byRaindrop: Record<string, string> }} pairs
 * @returns {Omit<MatchPlan, 'ok'|'error'|'reason'> & { ok: true }}
 */
export function planMatchFromExport(csvText, edgeBookmarks, pairs) {
  const { byKey, raindropIds, raindropCount } = indexExportByUrl(csvText);
  const byBookmark = pairs.byBookmark || {};
  const byRaindrop = pairs.byRaindrop || {};
  /** Live Edge ids — stale pair map entries (Edge Sync rewrite) are not conflicts. */
  const liveIds = new Set(edgeBookmarks.map((b) => String(b.id)));

  /** @type {Map<string, Set<string>>} bid → candidate rids */
  const candidates = new Map();
  let edgeOnly = 0;
  let ambiguous = 0;

  for (const bm of edgeBookmarks) {
    const bid = String(bm.id);
    const rids = new Set();
    for (const key of urlMatchKeys(bm.url)) {
      const hits = byKey.get(key);
      if (!hits) continue;
      for (const rid of hits) rids.add(rid);
    }
    if (rids.size === 0) {
      edgeOnly++;
      continue;
    }
    if (rids.size > 1) {
      ambiguous++;
      continue;
    }
    candidates.set(bid, rids);
  }

  // Collapse rid claimed by multiple Edge bookmarks → ambiguous.
  /** @type {Map<string, string[]>} rid → bids */
  const byRid = new Map();
  for (const [bid, rids] of candidates) {
    const rid = [...rids][0];
    const list = byRid.get(rid) || [];
    list.push(bid);
    byRid.set(rid, list);
  }

  /** @type {MatchPair[]} */
  const matched = [];
  let alreadyPaired = 0;
  let conflicts = 0;
  /** @type {Set<string>} */
  const claimedRids = new Set();

  for (const [rid, bids] of byRid) {
    if (bids.length > 1) {
      ambiguous += bids.length;
      continue;
    }
    const bid = bids[0];
    const existingRid = byBookmark[bid];
    const existingBid = byRaindrop[rid];

    if (existingRid != null && String(existingRid) === String(rid)) {
      alreadyPaired++;
      claimedRids.add(rid);
      continue;
    }
    if (existingRid != null && String(existingRid) !== String(rid)) {
      conflicts++;
      continue;
    }
    // Reverse map points at another bookmark: conflict only if that id still exists.
    if (
      existingBid != null &&
      String(existingBid) !== String(bid) &&
      liveIds.has(String(existingBid))
    ) {
      conflicts++;
      continue;
    }
    matched.push({ bookmarkId: bid, raindropId: rid });
    claimedRids.add(rid);
  }

  // Export ids not already paired or newly matchable 1:1 (includes ambiguous/conflict leftovers).
  let raindropOnly = 0;
  for (const rid of raindropIds) {
    if (!claimedRids.has(rid)) raindropOnly++;
  }

  return {
    ok: true,
    matched,
    alreadyPaired,
    ambiguous,
    conflicts,
    edgeOnly,
    raindropOnly,
    edgeScanned: edgeBookmarks.length,
    raindropCount,
  };
}

/**
 * Dry-run: fetch export + scan Edge + return plan (matched list included for Apply).
 * @returns {Promise<MatchPlan>}
 */
export async function planMatchExisting() {
  await ensurePairsMigrated();

  if (await isRateLimited()) {
    return emptyPlan({ reason: "rate_limited" });
  }

  const config = await getConfig();
  if (!config.token) {
    return emptyPlan({ ok: false, error: "No Raindrop token configured" });
  }

  const client = new RaindropClient(config.token);
  let csv;
  try {
    csv = await client.exportRaindropsCsv(0);
    client.throwIfShouldPause();
  } catch (err) {
    if (await handleClientError(err)) {
      if (err instanceof RateLimitError) {
        return emptyPlan({ reason: "rate_limited" });
      }
      if (err instanceof AuthError) {
        return emptyPlan({ ok: false, error: err.message });
      }
    }
    throw err;
  }

  const all = await collectAllBookmarks();
  const edgeBookmarks = all.map(({ node }) => ({
    id: String(node.id),
    url: node.url,
  }));
  const pairs = await getPairs();
  return planMatchFromExport(csv, edgeBookmarks, pairs);
}

/**
 * Apply a previously computed plan (or re-plan then apply when matched omitted).
 * @param {MatchPair[]} matched
 * @returns {Promise<{ ok: boolean, paired: number, error?: string, reason?: string }>}
 */
export async function applyMatchExisting(matched) {
  await ensurePairsMigrated();

  if (!Array.isArray(matched)) {
    return { ok: false, paired: 0, error: "Invalid match list" };
  }

  const liveIds = new Set(
    (await collectAllBookmarks()).map(({ node }) => String(node.id))
  );

  let paired = 0;
  for (const row of matched) {
    if (!row?.bookmarkId || !row?.raindropId) continue;
    const bid = String(row.bookmarkId);
    const rid = String(row.raindropId);
    if (!liveIds.has(bid)) continue;
    const pairs = await getPairs();
    const existingRid = pairs.byBookmark[bid];
    const existingBid = pairs.byRaindrop[rid];
    if (existingRid != null && String(existingRid) !== rid) {
      continue;
    }
    if (
      existingBid != null &&
      String(existingBid) !== bid &&
      liveIds.has(String(existingBid))
    ) {
      continue;
    }
    if (existingRid != null && String(existingRid) === rid) {
      continue;
    }
    await recordSynced(bid, rid);
    paired++;
  }

  await appendLog(
    "info",
    `Match existing (export): recorded ${paired} pair(s) of ${matched.length} planned.`
  );
  return { ok: true, paired };
}

/**
 * Dry-run entry: plan + activity log. Apply uses applyMatchExisting(plan.matched).
 * @returns {Promise<MatchPlan>}
 */
export async function runMatchExistingDryRun() {
  const plan = await planMatchExisting();
  if (!plan.ok || plan.reason) return plan;
  await appendLog(
    "info",
    `Match existing dry-run: would pair ${plan.matched.length}, ` +
      `already paired ${plan.alreadyPaired}, ambiguous ${plan.ambiguous}, ` +
      `conflicts ${plan.conflicts}, Edge-only ${plan.edgeOnly}, ` +
      `Raindrop-only ${plan.raindropOnly} (export ${plan.raindropCount}, Edge ${plan.edgeScanned}).`
  );
  return plan;
}

/** @returns {MatchPlan} */
function emptyPlan({ ok = true, error, reason } = {}) {
  return {
    ok,
    matched: [],
    alreadyPaired: 0,
    ambiguous: 0,
    conflicts: 0,
    edgeOnly: 0,
    raindropOnly: 0,
    edgeScanned: 0,
    raindropCount: 0,
    ...(error ? { error } : {}),
    ...(reason ? { reason } : {}),
  };
}

export { RateLimitError, AuthError };
