// Queue drain loop: processes due jobs with rate-limit / auth gates.
// Job kind handlers live in job-processors.js; Auth/429 handling in client-errors.js.
// Full wakes share a WakeBudget with reconcile; opportunistic drains use a short budget.

import {
  JOB,
  SOFT_MAX_DRAIN_JOBS_PER_WAKE,
  drainJobsCap,
  deleteBreakerLimit,
} from "./constants.js";
import {
  getConfig,
  getOverrides,
  getCollectionCache,
  getPairs,
  getDeleteBreaker,
  tripDeleteBreaker,
  consumeAllowedDeleteJob,
  setStatus,
  appendLog,
  ensurePairsMigrated,
  isRateLimited,
} from "./store.js";
import * as queue from "./queue.js";
import { RaindropClient } from "./raindrop.js";
import { buildCollectionIndex } from "./collections.js";
import { handleClientError } from "./client-errors.js";
import { processJob } from "./job-processors.js";
import { migrateLegacyRaindropRoots } from "./migrate-roots.js";
import { completePairMigration } from "./pair-migration.js";
import { gateDrainForBulkPrompt, noteQueueDepthForBulkPrompt } from "./queue-bulk-prompt.js";
import { createWakeBudget, finalizeWakeBudget } from "./wake-budget.js";

let draining = false; // best-effort in-memory reentrancy guard (idempotent anyway)

/** Job kinds that remove something on one side. */
const DELETE_KINDS = new Set([JOB.DELETE_EDGE, JOB.DELETE_RAINDROP]);

/**
 * Delete circuit breaker gate. True when delete jobs must stay queued this
 * wake. Trips (and logs once) when the rolling-window count has reached the
 * limit; stays tripped until Options → Allow / Discard.
 * @returns {Promise<boolean>}
 */
async function deletesHeld() {
  const breaker = await getDeleteBreaker();
  if (breaker.tripped) return true;
  const pairs = await getPairs();
  const limit = deleteBreakerLimit(Object.keys(pairs.byBookmark || {}).length);
  if (breaker.count < limit) return false;
  const newlyTripped = await tripDeleteBreaker(limit);
  if (newlyTripped) {
    await appendLog(
      "error",
      `Delete circuit breaker tripped: ${breaker.count} deletes in the last 24h ` +
        `(limit ${limit}). Further deletes are held — review in Options → Status.`
    );
  }
  return true;
}
/** @type {Promise<unknown>|null} */
let rootsMigration = null;

async function ensureRootsMigrated(client) {
  if (!rootsMigration) {
    rootsMigration = migrateLegacyRaindropRoots(client).catch(async (err) => {
      rootsMigration = null;
      await appendLog("error", `Roots migration failed: ${err.message}`);
      throw err;
    });
  }
  await rootsMigration;
}

/**
 * @param {{ budget?: import("./wake-budget.js").WakeBudget }} [opts]
 *   Omit budget for short/opportunistic drain (live handlers). Pass a shared
 *   full wake budget from heartbeat / Pull now / Drain now.
 */
export async function drain(opts = {}) {
  if (draining) return;
  draining = true;
  const ownedBudget = !opts.budget;
  const budget = opts.budget ?? (await createWakeBudget({ mode: "short" }));
  try {
    await ensurePairsMigrated();
    await drainLoop(budget);
  } catch (err) {
    await appendLog("error", `Drain crashed: ${err.message}`);
  } finally {
    draining = false;
    // Opportunistic drains must persist the rate window too — otherwise live
    // storms leave heartbeat seeding from a stale Remaining.
    if (ownedBudget) {
      await finalizeWakeBudget(budget, { ranWork: budget.spent > 0 });
    }
  }
}

/** @param {import("./wake-budget.js").WakeBudget} budget */
async function drainLoop(budget) {
  if (await isRateLimited()) return;

  const pending = await queue.size();
  // Evolve arm/snooze/clear from depth before gating (natural drain can clear).
  await noteQueueDepthForBulkPrompt(pending);
  if (await gateDrainForBulkPrompt()) {
    await setStatus({ pending });
    return;
  }

  const config = await getConfig();
  if (!config.token) {
    await setStatus({ lastError: "No Raindrop token configured", pending });
    return;
  }

  const client = new RaindropClient(config.token);
  budget.bindClient(client);
  try {
    await ensureRootsMigrated(client);
  } catch {
    // Logged inside ensureRootsMigrated; continue so queue still drains.
  }
  // Fill id-only v1 pair records from the tree + export before any job reads them.
  await completePairMigration({ client, budget });

  const dueJobs = await queue.due(Date.now());
  if (dueJobs.length === 0) {
    await setStatus({ pending });
    return;
  }

  // Full wakes: soft job backstop under spendable. Short wakes: historical 25/55.
  const jobCap =
    budget.mode === "full"
      ? Math.min(SOFT_MAX_DRAIN_JOBS_PER_WAKE, dueJobs.length)
      : drainJobsCap(pending);
  const overrides = await getOverrides();
  const cache = await getCollectionCache();
  let index = null;
  const getIndex = async () => (index ??= await buildCollectionIndex(client));

  let processed = 0;
  let heldDeletes = 0;
  for (const job of dueJobs) {
    const isDelete = DELETE_KINDS.has(queue.jobKind(job));
    // Jobs released by Allow run past the gate and do not count toward the window.
    const released = isDelete && (await getDeleteBreaker()).allowedJobIds.has(String(job.id));
    if (isDelete && !released && (await deletesHeld())) {
      heldDeletes++;
      continue;
    }
    if (processed >= jobCap || !budget.canSpend(1)) {
      const reason = budget.consumeSelfCapReason();
      const why =
        reason === "bootstrap"
          ? "bootstrap budget"
          : reason === "wake_cap"
            ? "wake cap"
            : processed >= jobCap
              ? "job fairness cap"
              : "wake budget";
      await appendLog(
        "info",
        `Drain paused after ${processed} jobs (${why}; pending ${pending}); ` +
          `${dueJobs.length - processed} remain for later.`
      );
      break;
    }
    try {
      await processJob(job, {
        client,
        config,
        overrides,
        cache,
        getIndex,
        budget,
        countDelete: !released,
      });
      if (released) await consumeAllowedDeleteJob(job.id);
      processed++;
      budget.syncFromClient(client);
      client.throwIfShouldPause();
    } catch (err) {
      if (await handleClientError(err, { job })) return;
      const result = await queue.defer(job.id, Date.now(), { lastError: err.message });
      if (result.action === "dead-lettered") {
        await appendLog(
          "error",
          `Job ${job.id} dead-lettered after ${result.attempts} attempts: ${err.message}`
        );
      } else {
        await appendLog("error", `Sync failed (will retry): ${err.message}`);
      }
      // Rename must stay ahead of uploads: if it defers, stop this pass and
      // push other due work out to the same backoff window so a later tick
      // cannot path-ensure the new Edge title before the rename retries.
      if (result.action === "deferred" && queue.jobKind(job) === JOB.RENAME_COLLECTION) {
        const deferred = (await queue.list()).find((j) => j.id === job.id);
        const until = deferred?.nextAttemptAt ?? Date.now();
        await queue.deferAllDueUntil(until);
        break;
      }
    }
  }

  // A tripped breaker keeps deletionsHalted / lastError until Allow or Discard.
  const breaker = await getDeleteBreaker();
  await setStatus({
    ...(breaker.tripped ? {} : { deletionsHalted: false, lastError: null }),
    lastActivityAt: Date.now(),
    pending: await queue.size(),
    heldDeletes,
  });
}
