// Bulk lane v1: Match existing — link Edge bookmarks to Raindrop export.csv by URL.
// Dry-run then apply; no deletes, moves, or raindrop creates.

import { collectAllBookmarks } from "./bookmarks.js";
import { indexExportByUrl } from "./export-csv.js";
import { resolveIndexedUrls, urlMatchKeys } from "./url-match.js";
import { RaindropClient, RateLimitError, AuthError } from "./raindrop.js";
import { handleClientError } from "./client-errors.js";
import { adoptExportCsv } from "./presence.js";
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
 *   replacesRid?: string|null,
 * }} MatchPair
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   raindropIds?: string[],
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
 * Shared plan/apply rule for claiming a (bookmarkId, raindropId) pair.
 * Stale ids on either side are not conflicts:
 *  - reverse link to a bookmark id missing from `liveIds` (bookmark gone /
 *    Edge renumbered ids) → the raindrop is claimable;
 *  - forward link to a raindrop id missing from `liveRaindropIds` (ghost
 *    from a trashed fork, when the export set is supplied) → the bookmark is
 *    claimable. Without `liveRaindropIds` a differing forward link still
 *    counts as a conflict (older callers).
 * @param {string} bid
 * @param {string} rid
 * @param {{ byBookmark?: Record<string, string>, byRaindrop?: Record<string, string> }} pairs
 * @param {Set<string>} liveIds live Edge bookmark ids
 * @param {Set<string>} [liveRaindropIds] live raindrop ids (export)
 * @returns {'already' | 'conflict' | 'match'}
 */
export function classifyPairClaim(bid, rid, pairs, liveIds, liveRaindropIds) {
  const byBookmark = pairs.byBookmark || {};
  const byRaindrop = pairs.byRaindrop || {};
  const bidS = String(bid);
  const ridS = String(rid);
  const existingRid = byBookmark[bidS];
  const existingBid = byRaindrop[ridS];

  if (existingRid != null && String(existingRid) === ridS) {
    return "already";
  }
  if (existingRid != null && String(existingRid) !== ridS) {
    const forwardIsStale = liveRaindropIds != null && !liveRaindropIds.has(String(existingRid));
    if (!forwardIsStale) return "conflict";
  }
  if (existingBid != null && String(existingBid) !== bidS && liveIds.has(String(existingBid))) {
    return "conflict";
  }
  return "match";
}

/**
 * Build a Match existing plan from CSV text + current Edge bookmarks / pairs.
 * Pure aside from bookmark/pair reads when used via planMatchExisting().
 * @param {string} csvText
 * @param {{ id: string, url: string }[]} edgeBookmarks
 * @param {{ byBookmark: Record<string, string>, byRaindrop: Record<string, string> }} pairs
 * @returns {Omit<MatchPlan, 'ok'|'error'|'reason'> & { ok: true }}
 */
export function planMatchFromExport(csvText, edgeBookmarks, pairs) {
  const { byKey, raindropIds, raindropCount, urlById } = indexExportByUrl(csvText);
  /** Live Edge ids — stale pair map entries (Edge Sync rewrite) are not conflicts. */
  const liveIds = new Set(edgeBookmarks.map((b) => String(b.id)));
  /** Live raindrop ids — a forward link to an id outside the export is a ghost, not a conflict. */
  const liveRaindropIds = new Set([...raindropIds].map(String));

  /** @type {Map<string, Set<string>>} bid → candidate rids */
  const candidates = new Map();
  let edgeOnly = 0;
  let ambiguous = 0;

  for (const bm of edgeBookmarks) {
    const bid = String(bm.id);
    const { ids } = resolveIndexedUrls(byKey, bm.url, (rid) => {
      const u = urlById.get(rid);
      return u ? urlMatchKeys(u)[0] : null;
    });
    if (ids.length === 0) {
      edgeOnly++;
      continue;
    }
    if (ids.length > 1) {
      ambiguous++;
      continue;
    }
    candidates.set(bid, new Set(ids));
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
    const verdict = classifyPairClaim(bid, rid, pairs, liveIds, liveRaindropIds);
    if (verdict === "already") {
      alreadyPaired++;
      claimedRids.add(rid);
      continue;
    }
    if (verdict === "conflict") {
      conflicts++;
      continue;
    }
    // Record the forward link this row replaces (a stale ghost id, or none) so
    // Apply can refuse if drain re-paired the bookmark after the export.
    const prior = pairs.byBookmark?.[bid];
    matched.push({
      bookmarkId: bid,
      raindropId: rid,
      replacesRid: prior != null ? String(prior) : null,
    });
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
    /** Export ids, so Apply can honour the same stale-forward-link rule. */
    raindropIds: [...liveRaindropIds],
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
  const exportStartedAt = Date.now();
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

  // One export serves Match and the engine's presence snapshot.
  await adoptExportCsv(csv, exportStartedAt);
  const all = await collectAllBookmarks();
  const edgeBookmarks = all.map(({ node }) => ({
    id: String(node.id),
    url: node.url,
  }));
  const pairs = await getPairs();
  return planMatchFromExport(csv, edgeBookmarks, pairs);
}

/**
 * Apply a previously computed plan.
 * @param {MatchPair[]} matched
 * @param {{ liveRaindropIds?: Iterable<string> }} [opts] export ids from the plan;
 *   when given, a forward link to an id outside the export is stale (rebind).
 * @returns {Promise<{ ok: boolean, paired: number, error?: string, reason?: string }>}
 */
export async function applyMatchExisting(matched, { liveRaindropIds } = {}) {
  await ensurePairsMigrated();

  if (!Array.isArray(matched)) {
    return { ok: false, paired: 0, error: "Invalid match list" };
  }

  const nodes = new Map(
    (await collectAllBookmarks()).map(({ node, segments }) => [String(node.id), { node, segments }])
  );
  const liveIds = new Set(nodes.keys());
  const liveRids = liveRaindropIds ? new Set([...liveRaindropIds].map(String)) : undefined;

  let paired = 0;
  for (const row of matched) {
    if (!row?.bookmarkId || !row?.raindropId) continue;
    const bid = String(row.bookmarkId);
    const rid = String(row.raindropId);
    if (!liveIds.has(bid)) continue;
    const pairs = await getPairs();
    // Changed since the plan (e.g. an upload paired it to a new raindrop that
    // is not in the export snapshot) → skip; the new pair wins.
    const now = pairs.byBookmark?.[bid];
    const planned = row.replacesRid ?? null;
    if ((now != null ? String(now) : null) !== (planned != null ? String(planned) : null)) {
      continue;
    }
    if (classifyPairClaim(bid, rid, pairs, liveIds, liveRids) !== "match") continue;
    const { node, segments } = nodes.get(bid);
    await recordSynced(bid, rid, {
      url: node.url,
      title: node.title ?? null,
      edgeParentId: node.parentId ?? null,
      edgePathAtSync: segments,
    });
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

/** Zeroed MatchPlan (rate-limit / auth / SW catch paths). @returns {MatchPlan} */
export function emptyPlan({ ok = true, error, reason } = {}) {
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
