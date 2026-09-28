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
import { createWakeBudget, finalizeWakeBudget } from "./wake-budget.js";
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

/** Skip payload for Pull now / UI wait-and-resume. */
async function rateLimitedSkipResult() {
  await noteReconcileSkip("rate_limited", { pending: await queue.size() });
  const { rateLimitedUntil } = await getStatus();
  return {
    enqueued: 0,
    pages: 0,
    done: false,
    skipped: true,
    reason: "rate_limited",
    rateLimitedUntil: rateLimitedUntil ?? null,
  };
}

/**
 * Options/popup "Pull now": force past idle cooldown, then drain.
 * Rate-limit / auth errors use the same global gate as the heartbeat so a
 * manual 429 cannot leave rateLimitedUntil unset while the alarm keeps firing.
 * Returns `rateLimitedUntil` on rate_limited skips so the UI can wait and resume.
 */
export async function reconcileNow() {
  const budget = await createWakeBudget({ mode: "full" });
  try {
    if (await isRateLimited()) {
      return await rateLimitedSkipResult();
    }
    const result = await reconcile({ force: true, budget });
    if (result?.skipped && result.reason) {
      await noteReconcileSkip(result.reason, { pending: await queue.size() });
      if (result.reason === "rate_limited") {
        const { rateLimitedUntil } = await getStatus();
        return { ...result, rateLimitedUntil: rateLimitedUntil ?? null };
      }
    } else if (!result?.skipped) {
      await clearReconcileSkip();
    }
    if (await isRateLimited()) {
      // Skip drain under the pause. If listing already finished, keep done so
      // Pull now can end this click instead of waiting and calling again.
      if (result?.done) return result;
      const { rateLimitedUntil } = await getStatus();
      return {
        ...(result ?? { enqueued: 0, pages: 0, done: false }),
        skipped: true,
        reason: "rate_limited",
        rateLimitedUntil: rateLimitedUntil ?? null,
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
  } finally {
    await finalizeWakeBudget(budget, { ranWork: budget.spent > 0 });
  }
}

/** Full-wake drain (Options Drain now / message API). */
export async function drainNow() {
  const budget = await createWakeBudget({ mode: "full" });
  try {
    if (await isRateLimited()) return;
    await drain({ budget });
  } finally {
    await finalizeWakeBudget(budget, { ranWork: budget.spent > 0 });
  }
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
  const budget = await createWakeBudget({ mode: "full" });
  try {
    if (await isRateLimited()) {
      const { rateLimitedUntil } = await getStatus();
      return {
        ok: false,
        reason: "rate_limited",
        rateLimitedUntil: rateLimitedUntil ?? null,
        trashSafe: buildTrashSafePayload(await getReconcileState()),
      };
    }
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
      if (err instanceof RateLimitError) {
        const { rateLimitedUntil } = await getStatus();
        return {
          ok: false,
          reason: "rate_limited",
          rateLimitedUntil: rateLimitedUntil ?? null,
          trashSafe: buildTrashSafePayload(await getReconcileState()),
        };
      }
      throw err;
    }
    await appendLog("error", `Check Trash failed: ${err.message}`);
    throw err;
  } finally {
    await finalizeWakeBudget(budget, { ranWork: budget.spent > 0 });
  }
}

/** Heartbeat entry: drain queue, then reconcile when bidirectional. */
export async function tick() {
  const budget = await createWakeBudget({ mode: "full" });
  try {
    if (await isRateLimited()) {
      // rateLimitedUntil banner is primary; still stamp skip for Status copy.
      await noteReconcileSkip("rate_limited", { pending: await queue.size() });
      return;
    }
    await drain({ budget });
    if (await isRateLimited()) {
      await noteReconcileSkip("rate_limited", { pending: await queue.size() });
      return;
    }
    // Queue bulk prompt: skip Raindrop-heavy reconcile so we do not dig deeper
    // while Status awaits Match / Continue drip. Live enqueue still works.
    if (await isBulkDrainPausedNow()) {
      await noteReconcileSkip("bulk_pause", { pending: await queue.size() });
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
      const result = await reconcile({ force: false, budget });
      if (result?.skipped && result.reason) {
        await noteReconcileSkip(result.reason, { pending: await queue.size() });
      } else if (!result?.skipped) {
        await clearReconcileSkip();
      }
      if (await isRateLimited()) return;
      await drain({ budget }); // process any jobs reconcile just enqueued
      if (!(await isRateLimited())) await clearRateLimit();
    } catch (err) {
      if (await handleClientError(err)) return;
      await appendLog("error", `Pull failed: ${err.message}`);
    }
  } finally {
    await finalizeWakeBudget(budget, { ranWork: budget.spent > 0 });
  }
}
