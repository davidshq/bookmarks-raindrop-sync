// Pure status/summary strings shared by the Options page and the popup.
// No DOM and no chrome.* calls, so Vitest can cover the wording and precedence.

import { formatLastThrottleNotice } from "./wake-budget.js";

/**
 * Local time of day for a timestamp, or `fallback` when there is none.
 * @param {number|null|undefined} ms
 * @param {string} [fallback]
 */
export function fmtTime(ms, fallback = "—") {
  return ms ? new Date(ms).toLocaleTimeString() : fallback;
}

/**
 * Local date + time for a timestamp, or `fallback` when there is none.
 * @param {number|null|undefined} ms
 * @param {string} [fallback]
 */
export function fmtDateTime(ms, fallback = "—") {
  return ms ? new Date(ms).toLocaleString() : fallback;
}

/**
 * "Paused for Raindrop rate limits…" line for action status text.
 * With a resume time it names it; otherwise it ends with `hint`.
 * @param {number|null} [untilMs]
 * @param {string} [hint]
 */
export function rateLimitedMessage(untilMs, hint = "wait a minute, then try again.") {
  return untilMs
    ? `Paused for Raindrop rate limits until ${fmtTime(untilMs)}.`
    : `Paused for Raindrop rate limits — ${hint}`;
}

/**
 * Halt banner text, one precedence for both pages:
 * rate-limit pause > storage write failure > deletions halted > (compact
 * only) self-imposed wake cap. Options shows the wake cap on its own line.
 * @param {{
 *   rateLimitedUntil?: number|null,
 *   lastError?: string|null,
 *   deletionsHalted?: boolean,
 *   lastThrottle?: string|null,
 * }|null|undefined} status
 * @param {{ compact?: boolean, now?: number }} [opts]
 * @returns {string|null}
 */
export function formatHaltBanner(status, { compact = false, now = Date.now() } = {}) {
  const rateUntil = status?.rateLimitedUntil;
  if (rateUntil && rateUntil > now) {
    return compact
      ? `Raindrop rate-limit pause until ${fmtTime(rateUntil)}`
      : `Paused for Raindrop API rate limits until ${fmtTime(rateUntil)}. Sync resumes automatically.`;
  }
  const lastError = status?.lastError;
  if (lastError?.startsWith("Storage write failed")) return lastError;
  if (status?.deletionsHalted && lastError) {
    return compact
      ? lastError
      : `Deletions halted: ${lastError}. Jobs are kept and will retry once resolved.`;
  }
  return compact ? formatLastThrottleNotice(status) : null;
}

/**
 * Match existing dry-run counts.
 * @param {{
 *   matched?: unknown[], alreadyPaired: number, ambiguous: number, conflicts: number,
 *   edgeOnly: number, raindropOnly: number, raindropCount: number, edgeScanned: number,
 * }} plan
 */
export function formatMatchPlanSummary(plan) {
  const would = plan.matched?.length ?? 0;
  return (
    `Would pair ${would}; already paired ${plan.alreadyPaired}; ` +
    `ambiguous ${plan.ambiguous}; conflicts ${plan.conflicts}; ` +
    `Edge-only ${plan.edgeOnly}; Raindrop-only ${plan.raindropOnly} ` +
    `(export ${plan.raindropCount}, Edge ${plan.edgeScanned}).`
  );
}

function repairPruneCount(plan) {
  return plan.pruneBothDead + plan.pruneEdgeDead + plan.pruneRaindropDead;
}

function repairRebindCount(plan) {
  return (plan.edgeRebinds || 0) + (plan.raindropRebinds || 0);
}

/**
 * Repair pairs dry-run counts.
 * @param {Record<string, any>} plan Result of MSG.REPAIR_PAIRS_PLAN
 */
export function formatRepairPlanSummary(plan) {
  const pruned = repairPruneCount(plan);
  return (
    `Pairs now ${plan.pairsBefore}: keep ${plan.keptLive} live, ` +
    `rebind ${plan.edgeRebinds || 0} Edge id(s) and ${plan.raindropRebinds || 0} Raindrop id(s), ` +
    `match ${plan.matched.length} by URL, ` +
    `prune ${pruned} dead (${plan.pruneEdgeDead} Edge id gone, ${plan.pruneRaindropDead} raindrop gone, ` +
    `${plan.pruneBothDead} both). Ambiguous ${plan.ambiguous}, conflicts ${plan.conflicts}, ` +
    `Edge-only ${plan.edgeOnly}, Raindrop-only ${plan.raindropOnly}. ` +
    `Clear ${plan.tombstonesAlive.length} of ${plan.tombstonesTotal} tombstone(s) (raindrop alive), ` +
    `drop ${plan.queuedDeletes} queued delete(s).` +
    (plan.presenceShrink
      ? ` The export has ${plan.presenceShrink.count} raindrop(s), under half of the last ` +
        `${plan.presenceShrink.lastCompleteCount}; applying accepts ${plan.presenceShrink.count} ` +
        "as the new count."
      : "")
  );
}

/**
 * True when applying the repair plan would change nothing in the pair map.
 * Queued deletes alone do not count (matches the Options flow).
 * @param {Record<string, any>} plan
 */
export function repairPlanIsNoop(plan) {
  return (
    plan.matched.length === 0 &&
    repairRebindCount(plan) === 0 &&
    repairPruneCount(plan) === 0 &&
    plan.tombstonesAlive.length === 0 &&
    !plan.presenceShrink
  );
}
