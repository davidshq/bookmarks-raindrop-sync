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
  appendLog,
  isRateLimited,
  clearRateLimit,
  noteReconcileSkip,
  clearReconcileSkip,
} from "./store.js";
import { RateLimitError } from "./raindrop.js";
import { reconcile, hasRaindropBoundQueueWork } from "./reconcile.js";
import { handleClientError } from "./client-errors.js";
import { drain } from "./drain.js";
import { isBulkDrainPausedNow } from "./queue-bulk-prompt.js";
import { createWakeBudget, finalizeWakeBudget } from "./wake-budget.js";
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
 * skip line. If the queue still has Raindrop work, stamp busy immediately so
 * Status stays honest without waiting for the next heartbeat.
 */
export async function refreshReconcileSkipAfterBulkResume() {
  if (await hasRaindropBoundQueueWork()) {
    await noteReconcileSkip("busy", { pending: await queue.size() });
    return;
  }
  await clearReconcileSkip();
}

/**
 * Options/popup "Pull now": force past idle cooldown, then drain.
 * Rate-limit / auth errors use the same global gate as the heartbeat so a
 * manual 429 cannot leave rateLimitedUntil unset while the alarm keeps firing.
 */
export async function reconcileNow() {
  const budget = await createWakeBudget({ mode: "full" });
  try {
    if (await isRateLimited()) {
      await noteReconcileSkip("rate_limited", { pending: await queue.size() });
      return { enqueued: 0, pages: 0, done: false, skipped: true, reason: "rate_limited" };
    }
    const result = await reconcile({ force: true, budget });
    if (result?.skipped && result.reason) {
      await noteReconcileSkip(result.reason, { pending: await queue.size() });
    } else if (!result?.skipped) {
      await clearReconcileSkip();
    }
    if (await isRateLimited()) return result;
    await drain({ budget });
    return result;
  } catch (err) {
    if (await handleClientError(err)) {
      if (err instanceof RateLimitError) {
        await noteReconcileSkip("rate_limited", { pending: await queue.size() });
        return { enqueued: 0, pages: 0, done: false, skipped: true, reason: "rate_limited" };
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
