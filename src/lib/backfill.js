// Backfill: enqueue every existing bookmark whose resolved policy is not
// `exclude` and which has not already been synced. Safe to run anytime.
//
// The durable queue IS the resumable cursor: enqueued ids are persisted, so a
// worker restart mid-backfill resumes from whatever is still queued rather than
// re-walking and re-uploading. The pair map guards against re-uploads too.
// Load it once — hasSynced re-reads PAIRS under the lock per id, which makes
// a large import a storage round-trip per bookmark before the first enqueue.
//
// scanImportScope() is the shared walk for Import enqueue and bulk-candidate
// heuristics (same exclude / already-paired rules).
//
// Before enqueuing, Import refreshes the presence snapshot once so every
// upload in the batch reclaims existing raindrops by URL from the same
// snapshot instead of creating (the Sep 2026 fork storm was an Import after
// Chromium renumbered bookmark ids).

import { getConfig, getOverrides, getPairs, appendLog, setStatus, isRateLimited } from "./store.js";
import { loadTreeIndex } from "./tree-index.js";
import { isExcluded } from "./policy.js";
import { enqueueMany, size, pendingUploadIds } from "./queue.js";
import { livePairBookmarkIds } from "./pair-rebind.js";
import { RaindropClient } from "./raindrop.js";
import { ensurePresence } from "./presence.js";
import { handleClientError } from "./client-errors.js";
import { withWakeBudget } from "./wake-budget.js";

/**
 * Walk Edge bookmarks once: unpaired ids Import would enqueue + pair counts.
 * edgeScanned includes excluded URLs (full tree size for coverage heuristics).
 * @returns {Promise<{
 *   unpairedIds: string[],
 *   unpaired: number,
 *   paired: number,
 *   edgeScanned: number,
 * }>}
 */
export async function scanImportScope() {
  const config = await getConfig();
  const overrides = await getOverrides();
  const pairs = await getPairs();
  const treeIndex = await loadTreeIndex();
  // A pair counts only while its bookmark is the one it was recorded from
  // (dateAdded / URL): after a renumber the id may hold an unsynced bookmark.
  const synced = livePairBookmarkIds(pairs.records, treeIndex, await pendingUploadIds());
  const all = [...treeIndex.byId.values()];

  const unpairedIds = [];
  /** @type {Map<string, number>} */
  const dateAddedById = new Map();
  let paired = 0;
  for (const { id, ancestorIds, dateAdded } of all) {
    if (isExcluded(ancestorIds, overrides, config.defaultPolicy)) continue;
    if (synced.has(id)) {
      paired++;
    } else {
      unpairedIds.push(id);
      if (typeof dateAdded === "number") dateAddedById.set(id, dateAdded);
    }
  }
  return {
    unpairedIds,
    dateAddedById,
    unpaired: unpairedIds.length,
    paired,
    edgeScanned: all.length,
  };
}

/**
 * One export so the Import batch reclaims from a current snapshot. Failure
 * is logged, not fatal: uploads then fall back to per-URL search.
 */
async function refreshPresenceForImport() {
  const config = await getConfig();
  if (!config.token || (await isRateLimited())) return;
  await withWakeBudget(async (budget) => {
    const client = new RaindropClient(config.token);
    budget.bindClient(client);
    try {
      const got = await ensurePresence({ client, budget, reason: "pull-now" });
      if (!got.refreshed) {
        await appendLog("warn", "Import: Raindrop export unavailable; uploads will search by URL.");
      }
    } catch (err) {
      if (!(await handleClientError(err))) {
        await appendLog(
          "warn",
          `Import: presence refresh failed (${err.message}); uploads will search by URL.`
        );
      }
    }
  });
}

export async function startBackfill() {
  await refreshPresenceForImport();
  const { unpairedIds, dateAddedById, edgeScanned } = await scanImportScope();

  // Each job is tied to its bookmark's dateAdded so a renumber between
  // Import and drain retargets the job instead of uploading whatever holds the id.
  const added = await enqueueMany(unpairedIds, { dateAddedById });
  await appendLog("info", `Import queued ${added} bookmark(s) (${edgeScanned} scanned).`);
  await setStatus({ pending: await size(), lastPushAt: Date.now() });
  return { scanned: edgeScanned, queued: added };
}
