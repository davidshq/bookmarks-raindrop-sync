// Repair pairs: rebuild the Edge ↔ Raindrop pair records from what exists.
//
// Why this exists: when Edge renumbers bookmark ids (checksum reassignment,
// profile rebuild) or forked raindrops get trashed, pair records point at dead
// ids. The engine's rebind pass fixes those on every completed reconcile; this
// is the same pass on demand, plus pruning and tombstone cleanup, behind a
// dry-run the user confirms.
//
// Plan (dry-run, one export request, shared with the presence snapshot):
//   1. Rebind pass (pair-rebind.js), both sides: a dead bookmark id rebinds to
//      the same URL under its recorded path, then anywhere in the synced
//      scope; a dead raindrop id rebinds to the oldest live raindrop with the
//      URL. Edge-side and Raindrop-side rebinds are reported separately.
//   2. Prune every record still dead on either side after rebind. Both-dead,
//      Edge-dead and Raindrop-dead are counted separately.
//   3. Re-match by URL for bookmarks left unpaired (planMatchFromExport — same
//      claim rules as Match existing).
//   4. Delete tombstones whose raindrop id is alive in the export are cleared
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
//   - rewrite PAIRS with kept + rebound + matched records, merged with
//     post-plan changes;
//   - clear alive tombstones;
//   - drop queued delete jobs (they were computed against the old map);
//   - reset the delete breaker and recompute pair health.
// No Raindrop writes, no Edge writes.

import {
  getPairs,
  getStoredPairs,
  rewritePairs,
  recordsFromLegacy,
  getTombstones,
  pruneTombstones,
  resetDeleteBreaker,
  setPairHealth,
  appendLog,
  ensurePairsMigrated,
} from "./store.js";
import * as queue from "./queue.js";
import { indexExportByUrl } from "./export-csv.js";
import {
  planMatchFromExport,
  emptyPlan,
  fetchExportForPlan,
  inScopeBookmarks,
} from "./match-existing.js";
import { adoptExportCsv, buildSnapshot, loadPresence } from "./presence.js";
import { loadTreeIndex, treeIndexFromList } from "./tree-index.js";
import { rebindPass } from "./pair-rebind.js";
import { computePairHealth } from "./pair-health.js";

/**
 * @typedef {{
 *   ok: boolean,
 *   error?: string,
 *   reason?: string,
 *   edgeScanned: number,
 *   raindropCount: number,
 *   pairsBefore: number,
 *   keptLive: number,
 *   edgeRebinds: number,
 *   raindropRebinds: number,
 *   pruneBothDead: number,
 *   pruneEdgeDead: number,
 *   pruneRaindropDead: number,
 *   matched: { bookmarkId: string, raindropId: string, url?: string }[],
 *   ambiguous: number,
 *   conflicts: number,
 *   edgeOnly: number,
 *   raindropOnly: number,
 *   tombstonesAlive: string[],
 *   tombstonesTotal: number,
 *   queuedDeletes: number,
 *   keptPairs?: Record<string, string>,
 *   keptRecords?: Record<string, import("./store.js").PairRecord>,
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
 * Pure planner.
 * @param {string} csvText Raindrop export
 * @param {import("./tree-index.js").TreeIndex|{ id: string, url: string, path?: string[] }[]} edge
 *   live tree index, or a flat bookmark list (every entry in scope)
 * @param {{ records?: Record<string, object>, byBookmark?: Record<string, string>, byRaindrop?: Record<string, string> }} pairs
 *   pair view (records) or a legacy id map
 * @param {Record<string, { reason?: string }>} tombstones
 * @returns {Omit<RepairPlan, 'ok'|'error'|'reason'|'queuedDeletes'>}
 */
export function planRepairFromInputs(csvText, edge, pairs, tombstones) {
  const treeIndex = Array.isArray(edge) ? treeIndexFromList(edge) : edge;
  const snapshot = buildSnapshot(csvText);
  const { raindropCount } = indexExportByUrl(csvText);
  const liveRids = snapshot.ids;
  const liveBids = new Set(treeIndex.byId.keys());

  const records = pairs.records ?? recordsFromLegacy(pairs);
  const pairsSnapshot = {};
  for (const [rid, rec] of Object.entries(records)) {
    if (rec?.bookmarkId != null) pairsSnapshot[String(rec.bookmarkId)] = rid;
  }
  let keptLive = 0;
  for (const [rid, rec] of Object.entries(records)) {
    if (liveBids.has(String(rec.bookmarkId)) && liveRids.has(rid)) keptLive++;
  }
  // Reverse-only legacy entries (byRaindrop without a byBookmark twin) are
  // dropped by rebuilding from byBookmark; count them as both-dead noise.
  const reverseOnly = pairs.records
    ? 0
    : Object.keys(pairs.byRaindrop || {}).filter((rid) => !records[String(rid)]).length;

  const pass = rebindPass({ records, treeIndex, snapshot });
  const kept = {};
  const keptRecords = {};
  let pruneBothDead = reverseOnly;
  let pruneEdgeDead = 0;
  let pruneRaindropDead = 0;
  for (const [rid, rec] of Object.entries(pass.records)) {
    const edgeAlive = rec.bookmarkId != null && liveBids.has(String(rec.bookmarkId));
    const rdAlive = liveRids.has(rid);
    if (edgeAlive && rdAlive) {
      kept[String(rec.bookmarkId)] = rid;
      keptRecords[rid] = rec;
    } else if (!edgeAlive && !rdAlive) {
      pruneBothDead++;
    } else if (!edgeAlive) {
      pruneEdgeDead++;
    } else {
      pruneRaindropDead++;
    }
  }
  // A Raindrop rebind that merged over a dead-bookmark record removed that record.
  pruneEdgeDead += pass.raindropRebinds.filter((r) => r.replacedBookmarkId != null).length;

  const keptView = { byBookmark: { ...kept }, byRaindrop: {} };
  for (const [bid, rid] of Object.entries(kept)) keptView.byRaindrop[rid] = bid;
  const edgeBookmarks = inScopeBookmarks(treeIndex);
  const match = planMatchFromExport(csvText, edgeBookmarks, keptView, {
    liveBookmarkIds: treeIndex.byId.keys(),
  });
  const urlByBid = new Map(edgeBookmarks.map((b) => [b.id, b.url]));

  const tombstonesAlive = Object.entries(tombstones || {})
    .filter(([rid]) => liveRids.has(String(rid)))
    .filter(([, t]) => CLEARABLE_TOMBSTONE_REASONS.has(String(t?.reason ?? "delete")))
    .map(([rid]) => rid);

  return {
    edgeScanned: treeIndex.byId.size,
    raindropCount,
    pairsBefore: Object.keys(records).length + reverseOnly,
    keptLive,
    edgeRebinds: pass.edgeRebinds.filter((r) => kept[r.to] === r.raindropId).length,
    raindropRebinds: pass.raindropRebinds.filter((r) => keptRecords[r.to]).length,
    pruneBothDead,
    pruneEdgeDead,
    pruneRaindropDead,
    matched: match.matched.map((m) => ({ ...m, url: urlByBid.get(m.bookmarkId) })),
    ambiguous: match.ambiguous,
    conflicts: match.conflicts,
    edgeOnly: match.edgeOnly,
    raindropOnly: match.raindropOnly,
    tombstonesAlive,
    tombstonesTotal: Object.keys(tombstones || {}).length,
    keptPairs: kept,
    keptRecords,
    pairsSnapshot,
  };
}

/** @returns {Promise<RepairPlan>} */
export async function planRepairPairs() {
  const fetched = await fetchExportForPlan(emptyRepairPlan);
  if ("early" in fetched) return fetched.early;
  const { csv, exportStartedAt } = fetched;

  const treeIndex = await loadTreeIndex();
  const pairs = await getPairs();
  const tombstones = await getTombstones();
  const plan = planRepairFromInputs(csv, treeIndex, pairs, tombstones);
  if (plan.raindropCount === 0 && plan.pairsBefore > 0) {
    await appendLog("warn", "Repair pairs refused: Raindrop export returned no items.");
    return emptyRepairPlan({
      ok: false,
      error: "Raindrop export returned no items; refusing to prune every pair. Try again later.",
    });
  }
  await adoptExportCsv(csv, exportStartedAt);
  const queuedDeletes = (await queue.list()).filter(queue.isDeleteJob).length;
  await appendLog(
    "info",
    `Repair pairs dry-run: keep ${plan.keptLive}, rebind ${plan.edgeRebinds} Edge id(s) and ` +
      `${plan.raindropRebinds} Raindrop id(s), match ${plan.matched.length} by URL, ` +
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
  const treeIndex = await loadTreeIndex();
  const liveBids = new Set(treeIndex.byId.keys());
  const seed = { ...(plan.keptRecords || {}) };
  for (const row of plan.matched) {
    if (!seed[String(row.raindropId)]) seed[String(row.raindropId)] = { url: row.url ?? null };
  }
  const { pairCount, rebound } = await rewritePairs((current) => ({
    ...mergeRepairPlan(plan, current, liveBids),
    seed,
  }));
  const reboundTotal = rebound + (plan.edgeRebinds || 0) + (plan.raindropRebinds || 0);

  const tombstonesCleared = (plan.tombstonesAlive || []).length;
  if (tombstonesCleared) await pruneTombstones(plan.tombstonesAlive);

  const deletesDropped = await queue.removeWhere(queue.isDeleteJob);
  await resetDeleteBreaker();

  const stored = await getStoredPairs();
  await setPairHealth(
    computePairHealth({ records: stored.records, treeIndex, snapshot: await loadPresence() })
  );

  await appendLog(
    "info",
    `Repair pairs applied: ${pairCount} pair(s) (${reboundTotal} rebound), ` +
      `${tombstonesCleared} tombstone(s) cleared, ${deletesDropped} queued delete(s) dropped.`
  );
  return { ok: true, pairs: pairCount, rebound: reboundTotal, tombstonesCleared, deletesDropped };
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
    edgeRebinds: 0,
    raindropRebinds: 0,
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
