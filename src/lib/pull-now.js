// Shared Pull now loop for the options page and the popup.
//
// One service-worker reconcile pass lists at most a few hundred raindrops.
// Options used to loop until the cursor finished; the popup sent one message
// and told the user to open Settings (the wrong tab). Both surfaces use this.
//
// Rate-limit pauses: wait until rateLimitedUntil (or a 60s fallback), then
// continue the same click's loop. Heartbeat also resumes, but Pull now should
// finish without asking the user to click again for a normal ~1 minute pause.

import { MSG, RATE_LIMIT_FALLBACK_MS } from "./constants.js";

/** Safety cap so a stuck cursor cannot spin the UI forever. */
export const MAX_PULL_PASSES = 40;

/** Cap how many Raindrop pauses one Pull now click will wait out. */
export const MAX_PULL_RATE_WAITS = 10;

/** Small pad past rateLimitedUntil so the next pass does not re-hit the gate. */
const RATE_RESUME_PAD_MS = 250;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {(msg: { type: string }) => Promise<{ ok?: boolean, status?: { rateLimitedUntil?: number|null } }|undefined>} send
 * @param {{ rateLimitedUntil?: number|null }|undefined} resp
 * @returns {Promise<number>} epoch ms
 */
async function resolveRateLimitedUntil(send, resp) {
  if (typeof resp?.rateLimitedUntil === "number" && resp.rateLimitedUntil > 0) {
    return resp.rateLimitedUntil;
  }
  try {
    const statusResp = await send({ type: MSG.GET_STATUS });
    const until = statusResp?.status?.rateLimitedUntil;
    if (typeof until === "number" && until > 0) return until;
  } catch {
    // Fall through to default wait.
  }
  return Date.now() + RATE_LIMIT_FALLBACK_MS;
}

/**
 * @param {(msg: { type: string }) => Promise<{ ok?: boolean, error?: string, skipped?: boolean, reason?: string, done?: boolean, enqueued?: number, rateLimitedUntil?: number|null }|undefined>} send
 * @param {{ pendingMsg?: string, onProgress?: (text: string) => void | Promise<void>, sleepFn?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ text: string, totalQueued: number }>}
 */
export async function runPullNow(send, { pendingMsg, onProgress, sleepFn = sleep } = {}) {
  let totalQueued = 0;
  let passes = 0;
  let rateWaits = 0;
  let text = pendingMsg || "Pulling from Raindrop…";
  if (onProgress) await onProgress(text);

  while (passes < MAX_PULL_PASSES) {
    passes++;
    const resp = await send({ type: MSG.RECONCILE_NOW });
    if (!resp?.ok) {
      text = `Failed: ${resp?.error ?? "unknown error"}`;
      break;
    }
    if (resp.skipped) {
      // A pass may have enqueued before the rate-limit gate tripped (e.g. before drain).
      totalQueued += resp.enqueued ?? 0;
      if (resp.reason === "rate_limited") {
        if (rateWaits >= MAX_PULL_RATE_WAITS) {
          text =
            "Paused for Raindrop rate limits — still limited after several waits. " +
            "Heartbeat will continue; try Pull now again later.";
          break;
        }
        rateWaits++;
        passes--; // waiting does not consume a listing pass
        const until = await resolveRateLimitedUntil(send, resp);
        const waitMs = Math.max(0, until - Date.now()) + RATE_RESUME_PAD_MS;
        const secs = Math.max(1, Math.ceil(waitMs / 1000));
        text = `Paused for Raindrop rate limits — resuming in ~${secs}s…`;
        if (onProgress) await onProgress(text);
        await sleepFn(waitMs);
        continue;
      }
      if (resp.reason === "cooldown") {
        text = "Pull is on cooldown — wait a bit, or try again later.";
      } else {
        text = "A pull is already running — wait a moment and try again.";
      }
      break;
    }
    totalQueued += resp.enqueued ?? 0;
    if (resp.done) {
      text =
        totalQueued > 0
          ? `Pull finished: queued ${totalQueued} Raindrop change(s).`
          : "Pull finished. Nothing new to bring into the browser.";
      break;
    }
    if (passes >= MAX_PULL_PASSES) {
      text = `Pull paused after ${passes} passes (${totalQueued} queued). Open Options → Manual Sync and click Pull now again.`;
      break;
    }
    text =
      `Still scanning Raindrop (pass ${passes})… ${totalQueued} queued so far. ` +
      `Folder sync starts when the scan finishes.`;
    if (onProgress) await onProgress(text);
  }

  return { text, totalQueued };
}
