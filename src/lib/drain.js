// Queue drain loop: processes due jobs with rate-limit / auth gates.
// Job kind handlers live in job-processors.js; Auth/429 handling in client-errors.js.
// Full wakes share a WakeBudget with reconcile; opportunistic drains use a short budget.

import {
  JOB,
  SOFT_MAX_DRAIN_JOBS_PER_WAKE,
  drainJobsCap,
} from "./constants.js";
import {
  getConfig,
  getOverrides,
  getCollectionCache,
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
import {
  gateDrainForBulkPrompt,
  noteQueueDepthForBulkPrompt,
} from "./queue-bulk-prompt.js";
import { createWakeBudget, finalizeWakeBudget } from "./wake-budget.js";

let draining = false; // best-effort in-memory reentrancy guard (idempotent anyway)
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
  for (const job of dueJobs) {
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
      await processJob(job, { client, config, overrides, cache, getIndex });
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

  await setStatus({
    deletionsHalted: false,
    lastError: null,
    lastActivityAt: Date.now(),
    pending: await queue.size(),
  });
}
