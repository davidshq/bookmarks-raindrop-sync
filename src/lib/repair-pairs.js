// Repair pairs: rebuild the Edge ↔ Raindrop pair map from what actually exists.
//
// Why this exists: when Edge renumbers bookmark ids (checksum reassignment,
// profile rebuild) or forked raindrops get trashed, the pair map fills with
// entries whose Edge id or Raindrop id is dead. Reconcile then reads absence
// as "user deleted" and removes real bookmarks. Match existing alone cannot
// fix that — it never drops dead entries and never clears tombstones.
//
// Plan (dry-run, one export request):
//   1. Prune every pair whose bookmark id is not in the live tree OR whose
//      raindrop id is not in the export. Both-dead, Edge-dead and
//      Raindrop-dead are counted separately for the summary.
//   2. Re-match by URL on the pruned map (planMatchFromExport — same claim
//      rules as Match existing, including the stale-forward-link rule).
//   3. Delete tombstones whose raindrop id is alive in the export are cleared
//      so pull-create can recreate the Edge side. Offload tombstones
//      (`edge-offload`) are never cleared: that raindrop is alive on purpose
//      and clearing would pull the offloaded bookmark back into the browser.
// Safety:
//   - an export with zero ids while pairs exist is refused (a bad response
//     must not empty the map);
//   - apply merges under the pair lock: any pair recorded or removed after
//     the dry-run (drain kept running while the confirm dialog was open)
//     wins over the plan.
// Apply:
//   - rewrite PAIRS with kept-live + matched, merged with post-plan changes;
//   - clear alive tombstones;
//   - drop queued delete jobs (they were computed against the old map);
//   - reset reconcile presence state so the next cycle lists fresh.
// No Raindrop writes, no Edge writes.

import { JOB } from "./constants.js";
import {
  getConfig,
  getPairs,
  rewritePairs,
  getTombstones,
  pruneTombstones,
  setReconcileState,
  resetDeleteBreaker,
  appendLog,
  isRateLimited,
  ensurePairsMigrated,
} from "./store.js";
import * as queue from "./queue.js";
import { collectAllBookmarks } from "./bookmarks.js";
import { indexExportByUrl } from "./export-csv.js";
import { planMatchFromExport, emptyPlan } from "./match-existing.js";
import { RaindropClient, RateLimitError, AuthError } from "./raindrop.js";
import { handleClientError } from "./client-errors.js";

/**
 * @typedef {{
 *   ok: boolean,
 *   error?: string,
 *   reason?: string,
 *   edgeScanned: number,
 *   raindropCount: number,
 *   pairsBefore: number,
 *   keptLive: number,
 *   pruneBothDead: number,
 *   pruneEdgeDead: number,
 *   pruneRaindropDead: number,
 *   matched: { bookmarkId: string, raindropId: string }[],
 *   ambiguous: number,
 *   conflicts: number,
 *   edgeOnly: number,
 *   raindropOnly: number,
 *   tombstonesAlive: string[],
 *   tombstonesTotal: number,
 *   queuedDeletes: number,
 *   keptPairs?: Record<string, string>,
 *   pairsSnapshot?: Record<string, string>,
 * }} RepairPlan
 */

/** Tombstone reasons Repair may clear when the raindrop is alive. */
const CLEARABLE_TOMBSTONE_REASONS = new Set([
  "raindrop-remote-delete",
  "edge-user-delete",
  "delete",
]);

/**
 * Pure planner. `pairs` is the current map, `edgeBookmarks` the live tree,
 * `csvText` the Raindrop export, `tombstones` the current tombstone map.
 * @returns {Omit<RepairPlan, 'ok'|'error'|'reason'|'queuedDeletes'>}
 */
export function planRepairFromInputs(csvText, edgeBookmarks, pairs, tombstones) {
  const { raindropIds, raindropCount } = indexExportByUrl(csvText);
  const liveRids = new Set([...raindropIds].map(String));
  const liveBids = new Set(edgeBookmarks.map((b) => String(b.id)));

  const byBookmark = pairs.byBookmark || {};
  const kept = {};
  let pruneBothDead = 0;
  let pruneEdgeDead = 0;
  let pruneRaindropDead = 0;
  for (const [bid, rid] of Object.entries(byBookmark)) {
    const edgeAlive = liveBids.has(String(bid));
    const rdAlive = liveRids.has(String(rid));
    if (edgeAlive && rdAlive) {
      kept[String(bid)] = String(rid);
    } else if (!edgeAlive && !rdAlive) {
      pruneBothDead++;
    } else if (!edgeAlive) {
      pruneEdgeDead++;
    } else {
      pruneRaindropDead++;
    }
  }
  // Reverse-only entries (byRaindrop without a byBookmark twin) are dropped by
  // rebuilding from byBookmark; count them as both-dead noise.
  const reverseOnly = Object.keys(pairs.byRaindrop || {}).filter(
    (rid) => !Object.values(byBookmark).some((r) => String(r) === String(rid))
  ).length;
  pruneBothDead += reverseOnly;

  const keptPairs = { byBookmark: { ...kept }, byRaindrop: {} };
  for (const [bid, rid] of Object.entries(kept)) keptPairs.byRaindrop[rid] = bid;

  const match = planMatchFromExport(csvText, edgeBookmarks, keptPairs);

  const tombstonesAlive = Object.entries(tombstones || {})
    .filter(([rid]) => liveRids.has(String(rid)))
    .filter(([, t]) => CLEARABLE_TOMBSTONE_REASONS.has(String(t?.reason ?? "delete")))
    .map(([rid]) => rid);

  return {
    edgeScanned: edgeBookmarks.length,
    raindropCount,
    pairsBefore: Object.keys(byBookmark).length,
    keptLive: Object.keys(kept).length,
    pruneBothDead,
    pruneEdgeDead,
    pruneRaindropDead,
    matched: match.matched,
    ambiguous: match.ambiguous,
    conflicts: match.conflicts,
    edgeOnly: match.edgeOnly,
    raindropOnly: match.raindropOnly,
    tombstonesAlive,
    tombstonesTotal: Object.keys(tombstones || {}).length,
    keptPairs: kept,
    pairsSnapshot: { ...byBookmark },
  };
}

/** @returns {Promise<RepairPlan>} */
export async function planRepairPairs() {
  await ensurePairsMigrated();
  if (await isRateLimited()) return emptyRepairPlan({ reason: "rate_limited" });
  const config = await getConfig();
  if (!config.token) return emptyRepairPlan({ ok: false, error: "No Raindrop token configured" });

  const client = new RaindropClient(config.token);
  let csv;
  try {
    csv = await client.exportRaindropsCsv(0);
    client.throwIfShouldPause();
  } catch (err) {
    if (await handleClientError(err)) {
      if (err instanceof RateLimitError) return emptyRepairPlan({ reason: "rate_limited" });
      if (err instanceof AuthError) return emptyRepairPlan({ ok: false, error: err.message });
    }
    throw err;
  }

  const edgeBookmarks = (await collectAllBookmarks()).map(({ node }) => ({
    id: String(node.id),
    url: node.url,
  }));
  const pairs = await getPairs();
  const tombstones = await getTombstones();
  const plan = planRepairFromInputs(csv, edgeBookmarks, pairs, tombstones);
  if (plan.raindropCount === 0 && plan.pairsBefore > 0) {
    await appendLog("warn", "Repair pairs refused: Raindrop export returned no items.");
    return emptyRepairPlan({
      ok: false,
      error: "Raindrop export returned no items; refusing to prune every pair. Try again later.",
    });
  }
  const queuedDeletes = (await queue.list()).filter((j) => {
    const k = queue.jobKind(j);
    return k === JOB.DELETE_EDGE || k === JOB.DELETE_RAINDROP;
  }).length;
  await appendLog(
    "info",
    `Repair pairs dry-run: keep ${plan.keptLive}, rebind ${plan.matched.length}, ` +
      `prune ${plan.pruneBothDead + plan.pruneEdgeDead + plan.pruneRaindropDead} dead ` +
      `(${plan.pruneEdgeDead} Edge-dead, ${plan.pruneRaindropDead} Raindrop-dead, ${plan.pruneBothDead} both), ` +
      `clear ${plan.tombstonesAlive.length} alive tombstone(s), drop ${queuedDeletes} queued delete(s).`
  );
  return { ok: true, ...plan, queuedDeletes };
}

/**
 * Apply a plan from planRepairPairs. Rebuilds PAIRS from keptPairs + matched.
 * @param {RepairPlan} plan
 * @returns {Promise<{ ok: boolean, pairs: number, rebound: number, tombstonesCleared: number, deletesDropped: number, error?: string }>}
 */
export async function applyRepairPairs(plan) {
  await ensurePairsMigrated();
  if (!plan || !plan.keptPairs || !Array.isArray(plan.matched)) {
    return {
      ok: false,
      pairs: 0,
      rebound: 0,
      tombstonesCleared: 0,
      deletesDropped: 0,
      error: "Missing plan",
    };
  }
  if (plan.raindropCount === 0 && plan.pairsBefore > 0) {
    return {
      ok: false,
      pairs: 0,
      rebound: 0,
      tombstonesCleared: 0,
      deletesDropped: 0,
      error: "Plan came from an empty export; refusing to apply.",
    };
  }
  // Re-check liveness of the Edge side at apply time (tree may have changed).
  const liveBids = new Set((await collectAllBookmarks()).map(({ node }) => String(node.id)));
  const { pairCount, rebound } = await rewritePairs((current) =>
    mergeRepairPlan(plan, current, liveBids)
  );

  const tombstonesCleared = (plan.tombstonesAlive || []).length;
  if (tombstonesCleared) await pruneTombstones(plan.tombstonesAlive);

  const deletesDropped = await queue.removeWhere((j) => {
    const k = queue.jobKind(j);
    return k === JOB.DELETE_EDGE || k === JOB.DELETE_RAINDROP;
  });

  // Presence state was computed against the old map — start the next cycle clean.
  await setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: null,
    unsettledConfirmCatchUp: false,
    aliveConfirmOffset: 0,
    tombstonePruneOffset: 0,
    parkedAliveIds: [],
    running: false,
    lastError: null,
  });
  await resetDeleteBreaker();

  await appendLog(
    "info",
    `Repair pairs applied: ${pairCount} pair(s) (${rebound} rebound by URL), ` +
      `${tombstonesCleared} tombstone(s) cleared, ${deletesDropped} queued delete(s) dropped.`
  );
  return { ok: true, pairs: pairCount, rebound, tombstonesCleared, deletesDropped };
}

/**
 * Pure merge for apply. `current` is byBookmark read under the pair lock;
 * `plan.pairsSnapshot` is byBookmark at dry-run time.
 *  - A bookmark whose mapping changed after the plan (new pair, re-pair, or
 *    removed pair) keeps its current state — the plan is stale for it.
 *  - Otherwise plan.keptPairs apply, then plan.matched rebinds fill gaps,
 *    never reusing a raindrop id already claimed.
 *  - Bookmarks no longer in the tree are dropped.
 * @param {RepairPlan} plan
 * @param {Record<string, string>} current
 * @param {Set<string>} liveBids
 * @returns {{ byBookmark: Record<string, string>, result: { pairCount: number, rebound: number, kept: number } }}
 */
export function mergeRepairPlan(plan, current, liveBids) {
  const snap = plan.pairsSnapshot || {};
  const norm = (v) => (v != null ? String(v) : null);
  const touched = new Set();
  for (const bid of new Set([...Object.keys(snap), ...Object.keys(current)])) {
    if (norm(snap[bid]) !== norm(current[bid])) touched.add(String(bid));
  }

  const next = {};
  for (const bid of touched) {
    if (current[bid] != null && liveBids.has(bid)) next[bid] = String(current[bid]);
  }
  let kept = 0;
  for (const [bid, rid] of Object.entries(plan.keptPairs || {})) {
    if (touched.has(bid) || !liveBids.has(String(bid))) continue;
    next[String(bid)] = String(rid);
    kept++;
  }
  const claimed = new Set(Object.values(next));
  let rebound = 0;
  for (const row of plan.matched || []) {
    const bid = String(row.bookmarkId);
    const rid = String(row.raindropId);
    if (touched.has(bid) || !liveBids.has(bid) || next[bid] || claimed.has(rid)) continue;
    next[bid] = rid;
    claimed.add(rid);
    rebound++;
  }
  return {
    byBookmark: next,
    result: { pairCount: Object.keys(next).length, rebound, kept },
  };
}

/** @returns {RepairPlan} */
export function emptyRepairPlan({ ok = true, error, reason } = {}) {
  const base = emptyPlan();
  return {
    ok,
    edgeScanned: 0,
    raindropCount: 0,
    pairsBefore: 0,
    keptLive: 0,
    pruneBothDead: 0,
    pruneEdgeDead: 0,
    pruneRaindropDead: 0,
    matched: base.matched,
    ambiguous: 0,
    conflicts: 0,
    edgeOnly: 0,
    raindropOnly: 0,
    tombstonesAlive: [],
    tombstonesTotal: 0,
    queuedDeletes: 0,
    ...(error ? { error } : {}),
    ...(reason ? { reason } : {}),
  };
}
