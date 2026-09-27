// Queue-depth bulk prompt: arm when pending ≥ threshold, pause drain until
// Match or Continue drip. Complements Import/Pull click heuristics in
// bulk-candidate.js (those do not see an already-swollen live queue).

import {
  KEY,
  QUEUE_BULK_PENDING_THRESHOLD,
  HEARTBEAT_MINUTES,
  BULK_DRAIN_PAUSED_LOG,
  drainJobsCap,
} from "./constants.js";
import { _read, _write, appendLog } from "./store.js";
import { withLock } from "./mutex.js";

// Intentionally no import from queue.js — callers pass pending depth so this
// module stays below queue in the graph. MV3 service workers disallow
// import(), so queue cannot break a cycle with a dynamic import either.

export const BULK_PROMPT_IDLE = "idle";
export const BULK_PROMPT_NEEDS_CHOICE = "needs_choice";

/**
 * @typedef {{ status: 'idle'|'needs_choice', snoozedBelow: number|null }} BulkPromptState
 */

/** @returns {BulkPromptState} */
export function defaultBulkPrompt() {
  return { status: BULK_PROMPT_IDLE, snoozedBelow: null };
}

/**
 * Pending must fall below this before a snooze ends (and before needs_choice
 * auto-clears after a natural drain). Default: half of QUEUE_BULK_PENDING_THRESHOLD.
 * @param {number} [threshold]
 */
export function queueBulkClearWatermark(threshold = QUEUE_BULK_PENDING_THRESHOLD) {
  return threshold / 2;
}

/**
 * @param {unknown} raw
 * @returns {BulkPromptState}
 */
export function normalizeBulkPrompt(raw) {
  const status =
    raw && typeof raw === "object" && raw.status === BULK_PROMPT_NEEDS_CHOICE
      ? BULK_PROMPT_NEEDS_CHOICE
      : BULK_PROMPT_IDLE;
  const snoozedBelow =
    raw && typeof raw === "object" && typeof raw.snoozedBelow === "number" && Number.isFinite(raw.snoozedBelow)
      ? raw.snoozedBelow
      : null;
  return { status, snoozedBelow };
}

/**
 * Pure state transition from current durable prompt + queue depth.
 * @param {unknown} state
 * @param {number} pending
 * @param {number} [threshold]
 * @returns {BulkPromptState}
 */
export function evolveBulkPrompt(state, pending, threshold = QUEUE_BULK_PENDING_THRESHOLD) {
  const prev = normalizeBulkPrompt(state);
  const n = Number(pending) || 0;
  const clearBelow = queueBulkClearWatermark(threshold);
  const { status } = prev;
  let { snoozedBelow } = prev;

  if (snoozedBelow != null && n < snoozedBelow) {
    snoozedBelow = null;
  }

  // Natural drain while awaiting choice: drop the pause once backlog is small.
  if (status === BULK_PROMPT_NEEDS_CHOICE && n < clearBelow) {
    return { status: BULK_PROMPT_IDLE, snoozedBelow: null };
  }

  if (status === BULK_PROMPT_NEEDS_CHOICE) {
    return { status, snoozedBelow };
  }

  if (snoozedBelow != null) {
    return { status: BULK_PROMPT_IDLE, snoozedBelow };
  }

  if (n >= threshold) {
    return { status: BULK_PROMPT_NEEDS_CHOICE, snoozedBelow: null };
  }

  return { status: BULK_PROMPT_IDLE, snoozedBelow: null };
}

/**
 * Continue drip / post-Match: clear needs_choice and snooze until pending
 * drops below half threshold so we do not re-prompt every minute.
 * @param {number} [threshold]
 * @returns {BulkPromptState}
 */
export function snoozeBulkPromptState(threshold = QUEUE_BULK_PENDING_THRESHOLD) {
  return { status: BULK_PROMPT_IDLE, snoozedBelow: queueBulkClearWatermark(threshold) };
}

/** @param {unknown} state */
export function isBulkDrainPaused(state) {
  return normalizeBulkPrompt(state).status === BULK_PROMPT_NEEDS_CHOICE;
}

/**
 * Rough lower-bound minutes at current per-heartbeat drain cap (ignores 429).
 * @param {number} pending
 */
export function estimateDrainEtaMinutes(pending) {
  const n = Number(pending) || 0;
  if (n <= 0) return 0;
  const cap = drainJobsCap(n);
  if (cap <= 0) return 0;
  return Math.ceil(n / cap) * HEARTBEAT_MINUTES;
}

/**
 * Status banner copy.
 * @param {number} pending
 */
export function formatBulkQueueNotice(pending) {
  const n = Number(pending) || 0;
  const eta = estimateDrainEtaMinutes(n);
  const etaText = eta <= 1 ? "about a minute" : `~${eta} min at current drip rate`;
  return (
    `Sync queue has ${n} job(s) (${etaText}). An Edge or Raindrop import may take a long time ` +
    `if left to drip. Match from Raindrop export first (pairs overlapping URLs), or continue dripping?`
  );
}

function statesEqual(a, b) {
  return a.status === b.status && a.snoozedBelow === b.snoozedBelow;
}

async function readBulkPromptUnlocked() {
  return normalizeBulkPrompt(await _read(KEY.BULK_PROMPT, defaultBulkPrompt()));
}

async function writeBulkPromptUnlocked(state) {
  const next = normalizeBulkPrompt(state);
  await _write(KEY.BULK_PROMPT, next);
  return next;
}

/** @returns {Promise<BulkPromptState>} */
export async function getBulkPrompt() {
  return readBulkPromptUnlocked();
}

/**
 * Arm / evolve durable prompt from current queue depth.
 * Callers must pass depth (queue.size / list length); this module does not
 * import queue.js so enqueue can statically call here under a service worker.
 * Omitting pending used to mean "read size()" — that created a cycle and is
 * no longer supported (a missing arg would otherwise arm as depth 0).
 * @param {number} pending
 * @returns {Promise<BulkPromptState>}
 */
export async function armBulkPromptIfNeeded(pending) {
  if (pending == null) {
    throw new Error("[ers] armBulkPromptIfNeeded requires pending queue depth");
  }
  const n = Number(pending) || 0;
  return withLock(async () => {
    const prev = await readBulkPromptUnlocked();
    const next = evolveBulkPrompt(prev, n);
    if (!statesEqual(prev, next)) await writeBulkPromptUnlocked(next);
    return next;
  });
}

/** Alias used by drain / status refresh paths. */
export const noteQueueDepthForBulkPrompt = armBulkPromptIfNeeded;

/**
 * Continue drip: clear needs_choice and snooze until below half threshold.
 * @returns {Promise<BulkPromptState>}
 */
export async function snoozeBulkPrompt() {
  return withLock(async () => writeBulkPromptUnlocked(snoozeBulkPromptState()));
}

/**
 * After Match apply (or zero pairs): same as continue — resume drain without
 * immediately re-arming while the backlog is still large.
 * @returns {Promise<BulkPromptState>}
 */
export async function resolveBulkPromptAfterMatch() {
  return snoozeBulkPrompt();
}

/** @returns {Promise<boolean>} */
export async function isBulkDrainPausedNow() {
  return isBulkDrainPaused(await getBulkPrompt());
}

/**
 * Gate for drainLoop: when needs_choice, log (coalesced) and skip Raindrop work.
 * @returns {Promise<boolean>} true if drain must return early
 */
export async function gateDrainForBulkPrompt() {
  if (!(await isBulkDrainPausedNow())) return false;
  await appendLog("info", BULK_DRAIN_PAUSED_LOG);
  return true;
}
