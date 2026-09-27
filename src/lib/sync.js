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
import { reconcile } from "./reconcile.js";
import { handleClientError } from "./client-errors.js";
import { drain } from "./drain.js";
import { isBulkDrainPausedNow } from "./queue-bulk-prompt.js";
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
 * Options/popup "Pull now": force past idle cooldown, then drain.
 * Rate-limit / auth errors use the same global gate as the heartbeat so a
 * manual 429 cannot leave rateLimitedUntil unset while the alarm keeps firing.
 */
export async function reconcileNow() {
  try {
    if (await isRateLimited()) {
      await noteReconcileSkip("rate_limited", { pending: await queue.size() });
      return { enqueued: 0, pages: 0, done: false, skipped: true, reason: "rate_limited" };
    }
    const result = await reconcile({ force: true });
    if (result?.skipped && result.reason) {
      await noteReconcileSkip(result.reason, { pending: await queue.size() });
    } else if (!result?.skipped) {
      await clearReconcileSkip();
    }
    if (await isRateLimited()) return result;
    await drain();
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
  }
}

/** Heartbeat entry: drain queue, then reconcile when bidirectional. */
export async function tick() {
  if (await isRateLimited()) {
    // rateLimitedUntil banner is primary; still stamp skip for Status copy.
    await noteReconcileSkip("rate_limited", { pending: await queue.size() });
    return;
  }
  await drain();
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
    const result = await reconcile({ force: false });
    if (result?.skipped && result.reason) {
      await noteReconcileSkip(result.reason, { pending: await queue.size() });
    } else if (!result?.skipped) {
      await clearReconcileSkip();
    }
    if (await isRateLimited()) return;
    await drain(); // process any jobs reconcile just enqueued
    if (!(await isRateLimited())) await clearRateLimit();
  } catch (err) {
    if (await handleClientError(err)) return;
    await appendLog("error", `Pull failed: ${err.message}`);
  }
}
