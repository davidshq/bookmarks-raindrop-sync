// One-shot completion of the v1 → v2 pair migration.
//
// store.js converts a legacy { byBookmark, byRaindrop } map into id-only
// records on first load, keeps the v1 map under PAIRS_V1_BACKUP, and sets
// `migrationPartial`. This module finishes the job once a client exists:
//
//   1. read the Edge tree once and take a presence snapshot (outside the pair
//      lock, since the lock also guards logging and must not wait on a fetch);
//   2. under the lock, fill url/title/placement from live nodes, take the URL
//      from the export for records whose bookmark id is gone, apply the stale
//      Edge / Raindrop rebind rules, and drop records unresolved on both sides;
//   3. log one summary line and clear `migrationPartial`.
//
// If the export cannot be fetched, records keep what the tree gave them,
// `migrationPartial` stays set (absence-based deletes stay blocked), and the
// next wake with a client retries. The v1 backup is dropped by the next
// completed reconcile finish, not here.

import { getStoredPairs, rewritePairRecords, appendLog } from "./store.js";
import { ensurePresence, isUsableForUrls } from "./presence.js";
import { loadTreeIndex } from "./tree-index.js";
import { rebindPass } from "./pair-rebind.js";

/**
 * Pure resolution step. Records the caller built from v1 (possibly already
 * partly filled) plus the tree and an optional URL-usable snapshot.
 * @param {Record<string, import("./store.js").PairRecord>} records
 * @param {import("./tree-index.js").TreeIndex} treeIndex
 * @param {import("./presence.js").PresenceSnapshot|null} snapshot
 * @param {number} [now]
 * @returns {{
 *   records: Record<string, import("./store.js").PairRecord>,
 *   kept: number, reboundEdge: number, reboundRaindrop: number, dropped: number,
 * }}
 */
export function resolveMigratedRecords(records, treeIndex, snapshot, now = Date.now()) {
  // The pass fills URLs from live nodes and, for dead bookmark ids, from the export.
  const pass = rebindPass({ records, treeIndex, snapshot, now });
  const out = pass.records;
  let dropped = 0;
  if (snapshot) {
    for (const [rid, rec] of Object.entries(out)) {
      const edgeLive = rec.bookmarkId != null && treeIndex.byId.has(String(rec.bookmarkId));
      const rdLive = snapshot.ids.has(rid);
      if (!edgeLive && !rdLive) {
        delete out[rid];
        dropped++;
      }
    }
  }
  return {
    records: out,
    kept: Object.keys(out).length,
    reboundEdge: pass.edgeRebinds.length,
    reboundRaindrop: pass.raindropRebinds.length,
    dropped,
  };
}

/**
 * Finish a pending migration. Cheap no-op when nothing is pending.
 * @param {{
 *   client?: import("./raindrop.js").RaindropClient|null,
 *   budget?: import("./wake-budget.js").WakeBudget|null,
 * }} [opts]
 * @returns {Promise<{ pending: boolean, completed?: boolean }>}
 */
export async function completePairMigration({ client, budget } = {}) {
  const before = await getStoredPairs();
  if (!before.migrationPartial) return { pending: false };

  const treeIndex = await loadTreeIndex();
  let snapshot = null;
  try {
    const got = await ensurePresence({ client, budget, reason: "on-demand" });
    snapshot = isUsableForUrls(got.snapshot) ? got.snapshot : null;
  } catch {
    snapshot = null; // auth / rate limit: stay partial, retry on a later wake
  }

  const summary = await rewritePairRecords((stored) => {
    if (!stored.migrationPartial) {
      return { records: stored.records, result: null };
    }
    const out = resolveMigratedRecords(stored.records, treeIndex, snapshot);
    return {
      records: out.records,
      migrationPartial: !snapshot,
      migrationLogged: true,
      result: { ...out, firstLog: !stored.migrationLogged },
    };
  });
  if (!summary) return { pending: false };

  if (snapshot) {
    await appendLog(
      "info",
      `Pair migration: kept ${summary.kept}, rebound ${summary.reboundEdge + summary.reboundRaindrop} ` +
        `(${summary.reboundEdge} Edge id, ${summary.reboundRaindrop} Raindrop id), ` +
        `dropped ${summary.dropped} unresolvable.`
    );
    return { pending: false, completed: true };
  }
  if (summary.firstLog) {
    await appendLog(
      "warn",
      `Pair migration: built ${summary.kept} record(s) from the browser tree; ` +
        `Raindrop export unavailable, so absence-based deletes stay off until it succeeds.`
    );
  }
  return { pending: true };
}
