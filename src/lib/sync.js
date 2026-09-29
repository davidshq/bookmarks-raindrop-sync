// Sync engine facade: drain, live handlers, heartbeat, and manual reconcile.
//
// Implementation lives in focused modules:
//   drain.js, job-processors.js, live-handlers.js, client-errors.js, reconcile.js
//
// Invariant (confirm-before-act): a Raindrop write (create or delete) is
// confirmed and pair/tombstone state persisted BEFORE any matching local
// deletion. Policy-driven Edge cleanup never cascades into a Raindrop delete.

import { SYNC_MODE } from "./constants.js";
import {
  getConfig,
  getStatus,
  appendLog,
  isRateLimited,
  clearRateLimit,
  noteReconcileSkip,
  clearReconcileSkip,
  getReconcileState,
} from "./store.js";
import { RaindropClient, RateLimitError } from "./raindrop.js";
import { reconcile } from "./reconcile.js";
import { runTrashHygienePeek } from "./reconcile-finish.js";
import { handleClientError } from "./client-errors.js";
import { drain } from "./drain.js";
import { isBulkDrainPausedNow } from "./queue-bulk-prompt.js";
import { withWakeBudget } from "./wake-budget.js";
import { buildTrashSafePayload } from "./trash-hygiene.js";
import * as queue from "./queue.js";

export { drain } from "./drain.js";
export {
  collectRemovedUrlNodes,
  handleBookmarkRemoved,
  handleBookmarkCreated,
  handleBookmarkMoved,
  handleBookmarkChanged,
} from "./live-handlers.js";

/**
 * After Match / Continue drip clears needs_choice, drop a stale bulk_pause
 * skip line. Remaining Raindrop-bound jobs are not a listing deferral — tick
 * prefer-drains then uses leftover spendable for Trash/list.
 */
export async function refreshReconcileSkipAfterBulkResume() {
  await clearReconcileSkip();
}

async function rateLimitedUntilNow() {
  return (await getStatus()).rateLimitedUntil ?? null;
}

/** Stamp a reconcile skip line for Status, with current queue depth. */
async function noteSkip(reason) {
  await noteReconcileSkip(reason, { pending: await queue.size() });
}

/** Record a reconcile result's skip reason, or clear a stale one on a real run. */
async function noteReconcileOutcome(result) {
  if (result?.skipped && result.reason) await noteSkip(result.reason);
  else if (!result?.skipped) await clearReconcileSkip();
}

/** Skip payload for Pull now / UI wait-and-resume. */
async function rateLimitedSkipResult() {
  await noteSkip("rate_limited");
  return {
    enqueued: 0,
    pages: 0,
    done: false,
    skipped: true,
    reason: "rate_limited",
    rateLimitedUntil: await rateLimitedUntilNow(),
  };
}

/** Check Trash answer while Raindrop is rate-limited: last known hygiene. */
async function rateLimitedTrashResult() {
  return {
    ok: false,
    reason: "rate_limited",
    rateLimitedUntil: await rateLimitedUntilNow(),
    trashSafe: buildTrashSafePayload(await getReconcileState()),
  };
}

/**
 * Options/popup "Pull now": force past idle cooldown, then drain.
 * Rate-limit / auth errors use the same global gate as the heartbeat so a
 * manual 429 cannot leave rateLimitedUntil unset while the alarm keeps firing.
 * Returns `rateLimitedUntil` on rate_limited skips so the UI can wait and resume.
 */
export async function reconcileNow() {
  return withWakeBudget(async (budget) => {
    try {
      if (await isRateLimited()) {
        return await rateLimitedSkipResult();
      }
      const result = await reconcile({ force: true, budget });
      await noteReconcileOutcome(result);
      if (result?.skipped && result.reason === "rate_limited") {
        return { ...result, rateLimitedUntil: await rateLimitedUntilNow() };
      }
      if (await isRateLimited()) {
        // Skip drain under the pause. If listing already finished, keep done so
        // Pull now can end this click instead of waiting and calling again.
        if (result?.done) return result;
        return {
          ...(result ?? { enqueued: 0, pages: 0, done: false }),
          skipped: true,
          reason: "rate_limited",
          rateLimitedUntil: await rateLimitedUntilNow(),
        };
      }
      await drain({ budget });
      return result;
    } catch (err) {
      if (await handleClientError(err)) {
        if (err instanceof RateLimitError) {
          return await rateLimitedSkipResult();
        }
        throw err;
      }
      await appendLog("error", `Pull failed: ${err.message}`);
      throw err;
    }
  });
}

/** Full-wake drain (Options Drain now / message API). */
export async function drainNow() {
  return withWakeBudget(async (budget) => {
    if (await isRateLimited()) return;
    await drain({ budget });
  });
}

/**
 * Options Status "Check Trash": Trash-only peek + hygiene snapshot (no full pull).
 * Safe-to-empty is discovery debt only — may drain leftover budget for enqueued deletes.
 */
export async function checkTrashNow() {
  const config = await getConfig();
  if (config.syncMode !== SYNC_MODE.BIDIRECTIONAL) {
    return {
      ok: false,
      reason: "one_way",
      trashSafe: buildTrashSafePayload(null),
    };
  }
  return withWakeBudget(async (budget) => {
    try {
      if (await isRateLimited()) return await rateLimitedTrashResult();
      if (!config.token) {
        return {
          ok: false,
          reason: "no_token",
          trashSafe: buildTrashSafePayload(null),
        };
      }
      const client = new RaindropClient(config.token);
      budget.bindClient(client);
      const peek = await runTrashHygienePeek({ client, budget });
      if (!(await isRateLimited())) {
        await drain({ budget });
      }
      const reconcile = await getReconcileState();
      return {
        ok: true,
        scanComplete: peek.scanComplete,
        pairedPending: peek.pairedPending,
        trashSafe: buildTrashSafePayload(reconcile),
        reconcile,
      };
    } catch (err) {
      if (await handleClientError(err)) {
        if (err instanceof RateLimitError) return await rateLimitedTrashResult();
        throw err;
      }
      await appendLog("error", `Check Trash failed: ${err.message}`);
      throw err;
    }
  });
}

/** Heartbeat entry: drain queue, then reconcile when bidirectional. */
export async function tick() {
  return withWakeBudget(async (budget) => {
    if (await isRateLimited()) {
      // rateLimitedUntil banner is primary; still stamp skip for Status copy.
      await noteSkip("rate_limited");
      return;
    }
    await drain({ budget });
    if (await isRateLimited()) {
      await noteSkip("rate_limited");
      return;
    }
    // Queue bulk prompt: skip Raindrop-heavy reconcile so we do not dig deeper
    // while Status awaits Match / Continue drip. Live enqueue still works.
    if (await isBulkDrainPausedNow()) {
      await noteSkip("bulk_pause");
      return;
    }
    const config = await getConfig();
    if (config.syncMode !== SYNC_MODE.BIDIRECTIONAL) {
      await clearRateLimit();
      await clearReconcileSkip();
      return;
    }
    try {
      // Heartbeat uses cooldown; Options/popup use reconcileNow() (force: true).
      await noteReconcileOutcome(await reconcile({ force: false, budget }));
      if (await isRateLimited()) return;
      await drain({ budget }); // process any jobs reconcile just enqueued
      if (!(await isRateLimited())) await clearRateLimit();
    } catch (err) {
      if (await handleClientError(err)) return;
      await appendLog("error", `Pull failed: ${err.message}`);
    }
  });
}
