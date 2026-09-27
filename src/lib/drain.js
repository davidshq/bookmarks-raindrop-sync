// Queue drain loop: processes due jobs with rate-limit / auth gates.
// Job kind handlers live in job-processors.js; Auth/429 handling in client-errors.js.

import { JOB, drainJobsCap } from "./constants.js";
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

export async function drain() {
  if (draining) return;
  draining = true;
  try {
    await ensurePairsMigrated();
    await drainLoop();
  } catch (err) {
    await appendLog("error", `Drain crashed: ${err.message}`);
  } finally {
    draining = false;
  }
}

async function drainLoop() {
  if (await isRateLimited()) return;

  const config = await getConfig();
  if (!config.token) {
    await setStatus({ lastError: "No Raindrop token configured", pending: await queue.size() });
    return;
  }

  const client = new RaindropClient(config.token);
  try {
    await ensureRootsMigrated(client);
  } catch {
    // Logged inside ensureRootsMigrated; continue so queue still drains.
  }

  const pending = await queue.size();
  const dueJobs = await queue.due(Date.now());
  if (dueJobs.length === 0) {
    await setStatus({ pending });
    return;
  }

  const jobCap = drainJobsCap(pending);
  const overrides = await getOverrides();
  const cache = await getCollectionCache();
  let index = null;
  const getIndex = async () => (index ??= await buildCollectionIndex(client));

  let processed = 0;
  for (const job of dueJobs) {
    if (processed >= jobCap) {
      await appendLog(
        "info",
        `Drain paused after ${jobCap} jobs (pending ${pending}); ` +
          `${dueJobs.length - processed} remain for later.`
      );
      break;
    }
    try {
      await processJob(job, { client, config, overrides, cache, getIndex });
      processed++;
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
