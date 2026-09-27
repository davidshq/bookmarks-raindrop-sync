// Shared Pull now loop for the options page and the popup.
//
// One service-worker reconcile pass lists at most a few hundred raindrops.
// Options used to loop until the cursor finished; the popup sent one message
// and told the user to open Settings (the wrong tab). Both surfaces use this.

import { MSG } from "./constants.js";

/** Safety cap so a stuck cursor cannot spin the UI forever. */
export const MAX_PULL_PASSES = 40;

/**
 * @param {(msg: { type: string }) => Promise<{ ok?: boolean, error?: string, skipped?: boolean, reason?: string, done?: boolean, enqueued?: number }|undefined>} send
 * @param {{ pendingMsg?: string, onProgress?: (text: string) => void | Promise<void> }} [opts]
 * @returns {Promise<{ text: string, totalQueued: number }>}
 */
export async function runPullNow(send, { pendingMsg, onProgress } = {}) {
  let totalQueued = 0;
  let passes = 0;
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
      if (resp.reason === "rate_limited") {
        text = "Paused for Raindrop rate limits — wait a minute, then try Pull now again.";
      } else if (resp.reason === "cooldown") {
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
