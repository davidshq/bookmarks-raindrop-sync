// Per-wake Raindrop request budget (header-driven + soft MV3 wakeCap).
//
// Heartbeat / Pull now / Drain now create a *full* budget. Live bookmark
// handlers use a *short* budget so event storms cannot burn the shared token
// bucket. Fixed historical drain caps (25/55) are fairness backstops under this.

import {
  BOOTSTRAP_REQS,
  RATE_LIMIT_RESERVE,
  SHORT_WAKE_REQS,
  SOFT_MAX_MS_PER_WAKE,
  SOFT_MAX_REQS_PER_WAKE,
} from "./constants.js";
import { getStatus, setStatus } from "./store.js";
import { numberOrNull } from "./raindrop.js";

/**
 * @typedef {"wake_cap"|"bootstrap"|null} ThrottleReason
 * @typedef {"full"|"short"} WakeBudgetMode
 */

export class WakeBudget {
  /**
   * @param {{
   *   mode: WakeBudgetMode,
   *   headerRemaining: number|null,
   *   headerResetAt: number|null,
   *   wakeCapReqs?: number,
   *   wakeDeadlineMs?: number,
   *   bootstrapReqs?: number,
   * }} opts
   */
  constructor({
    mode,
    headerRemaining,
    headerResetAt,
    wakeCapReqs = mode === "short" ? SHORT_WAKE_REQS : SOFT_MAX_REQS_PER_WAKE,
    wakeDeadlineMs = SOFT_MAX_MS_PER_WAKE,
    bootstrapReqs = mode === "short" ? SHORT_WAKE_REQS : BOOTSTRAP_REQS,
  }) {
    this.mode = mode;
    /** @type {number|null} */
    this._headerRemaining = headerRemaining;
    /** @type {number|null} */
    this._headerResetAt = headerResetAt;
    this.wakeCapReqs = wakeCapReqs;
    this.wakeDeadline = Date.now() + wakeDeadlineMs;
    this.bootstrapReqs = bootstrapReqs;
    this.seededFromBootstrap = headerRemaining == null;
    this.spent = 0;
    /** @type {ThrottleReason} */
    this.selfCapReason = null;
  }

  /** @returns {number} how many more Raindrop requests this wake may issue */
  allowance() {
    if (Date.now() >= this.wakeDeadline) return 0;
    const byCap = this.wakeCapReqs - this.spent;
    if (byCap <= 0) return 0;
    if (this._headerRemaining != null) {
      return Math.max(0, Math.min(byCap, this._headerRemaining - RATE_LIMIT_RESERVE));
    }
    return Math.max(0, Math.min(byCap, this.bootstrapReqs - this.spent));
  }

  /** @param {number} [n] */
  canSpend(n = 1) {
    return this.allowance() >= n;
  }

  shouldStop() {
    return !this.canSpend(1);
  }

  /**
   * Record one (or more) Raindrop HTTP calls and refresh from client headers.
   * @param {import("./raindrop.js").RaindropClient|null|undefined} client
   * @param {number} [n]
   */
  noteRequest(client, n = 1) {
    this.spent += n;
    if (!this.syncFromClient(client) && this._headerRemaining != null) {
      this._headerRemaining = Math.max(0, this._headerRemaining - n);
    }
    if (!this.canSpend(1) && this.selfCapReason == null) {
      this.selfCapReason = this.#inferSelfCap();
    }
  }

  /**
   * @param {import("./raindrop.js").RaindropClient} client
   */
  bindClient(client) {
    client.bindBudget(this);
    if (this._headerRemaining != null) {
      client.hydrateRateWindow({
        remaining: this._headerRemaining,
        resetAt: this._headerResetAt,
      });
    }
  }

  /**
   * Sync headers without incrementing spent (e.g. after a call already counted).
   * @returns {boolean} true when the client had a header reading
   */
  syncFromClient(client) {
    if (!client || typeof client.remaining !== "number") return false;
    this._headerRemaining = client.remaining;
    if (typeof client.resetAt === "number") this._headerResetAt = client.resetAt;
    this.seededFromBootstrap = false;
    return true;
  }

  #inferSelfCap() {
    if (Date.now() >= this.wakeDeadline || this.spent >= this.wakeCapReqs) {
      return "wake_cap";
    }
    if (this.seededFromBootstrap || this._headerRemaining == null) {
      return "bootstrap";
    }
    // Remaining above reserve but allowance 0 → wakeCap path; at/below reserve
    // is handled by RateLimitError, not self-cap.
    if (this._headerRemaining > RATE_LIMIT_RESERVE) return "wake_cap";
    return null;
  }

  /** @returns {ThrottleReason} */
  consumeSelfCapReason() {
    if (this.selfCapReason) return this.selfCapReason;
    if (this.shouldStop()) {
      this.selfCapReason = this.#inferSelfCap();
      return this.selfCapReason;
    }
    return null;
  }

  /** Snapshot for durable persistence. */
  rateWindow() {
    return {
      rateRemaining: this._headerRemaining,
      rateResetAt: this._headerResetAt,
      rateObservedAt: this._headerRemaining != null ? Date.now() : null,
    };
  }
}

/**
 * Load persisted rate window; stale reset → treat as unknown (bootstrap).
 * @returns {Promise<{ remaining: number|null, resetAt: number|null }>}
 */
export async function loadPersistedRateWindow(now = Date.now()) {
  const status = await getStatus();
  const remaining = numberOrNull(status.rateRemaining);
  const resetAt = numberOrNull(status.rateResetAt);
  if (remaining == null || resetAt == null || resetAt <= now) {
    return { remaining: null, resetAt: null };
  }
  return { remaining, resetAt };
}

/**
 * @param {{ mode?: WakeBudgetMode }} [opts]
 * @returns {Promise<WakeBudget>}
 */
export async function createWakeBudget({ mode = "full" } = {}) {
  const { remaining, resetAt } = await loadPersistedRateWindow();
  return new WakeBudget({
    mode,
    headerRemaining: remaining,
    headerResetAt: resetAt,
  });
}

/**
 * Run `fn` with a wake budget. A caller-supplied `budget` is used as-is (its
 * owner finalizes it); otherwise a fresh one is created and finalized after.
 * @template T
 * @param {(budget: WakeBudget) => Promise<T>} fn
 * @param {{ mode?: "full"|"short", budget?: WakeBudget|null }} [opts]
 * @returns {Promise<T>}
 */
export async function withWakeBudget(fn, { mode = "full", budget = null } = {}) {
  if (budget) return fn(budget);
  const owned = await createWakeBudget({ mode });
  try {
    return await fn(owned);
  } finally {
    await finalizeWakeBudget(owned, { ranWork: owned.spent > 0 });
  }
}

/**
 * Persist rate window and optional self-cap note after a budgeted wake.
 * Does not set rateLimitedUntil (that stays on real RateLimitError).
 * @param {WakeBudget} budget
 * @param {{ ranWork?: boolean }} [opts]
 */
export async function finalizeWakeBudget(budget, { ranWork = false } = {}) {
  const window = budget.rateWindow();
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (window.rateRemaining != null) {
    patch.rateRemaining = window.rateRemaining;
    patch.rateResetAt = window.rateResetAt;
    patch.rateObservedAt = window.rateObservedAt;
  }
  const selfCap = budget.consumeSelfCapReason();
  if (selfCap) {
    patch.lastThrottle = selfCap;
  } else if (ranWork && budget.spent > 0) {
    patch.lastThrottle = null;
  }
  if (Object.keys(patch).length) await setStatus(patch);
}

/**
 * Status copy for self-cap (wakeCap / bootstrap) when no Raindrop pause is active.
 * @param {{ lastThrottle?: string|null, rateLimitedUntil?: number|null }|null|undefined} status
 * @returns {string|null}
 */
export function formatLastThrottleNotice(status) {
  const until = status?.rateLimitedUntil;
  if (until != null && until > Date.now()) return null;
  const t = status?.lastThrottle;
  if (t === "wake_cap") {
    return "Last sync wake stopped at the soft per-wake request/time cap (not a Raindrop rate-limit pause).";
  }
  if (t === "bootstrap") {
    return "Last sync wake used a small bootstrap budget before rate-limit headers were known (not a Raindrop rate-limit pause).";
  }
  return null;
}
