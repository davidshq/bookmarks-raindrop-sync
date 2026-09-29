// Small DOM helpers shared by the Options page and the popup.
// Loaded as an ES module from both pages; no chrome.* here.

import { formatPendingByDirection } from "../lib/queue.js";

export { fmtTime, fmtDateTime } from "../lib/status-format.js";

/**
 * Set a status/notice line and hide it when there is nothing to say.
 * @param {HTMLElement|null} el
 * @param {string|null|undefined} text
 */
export function setLine(el, text) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
}

/**
 * Run one service-worker action with status text and a double-click guard.
 * `ok(resp)` formats success; `fail(resp)` optionally formats a non-ok reply.
 * @param {{
 *   statusEl: HTMLElement,
 *   button?: HTMLButtonElement|null,
 *   pending: string,
 *   send: () => Promise<any>,
 *   ok: (resp: any) => string,
 *   fail?: (resp: any) => string,
 * }} opts
 * @returns {Promise<any>} the response, or undefined if `send` threw
 */
export async function runAction({ statusEl, button, pending, send, ok, fail }) {
  statusEl.textContent = pending;
  if (button) button.disabled = true;
  let resp;
  try {
    resp = await send();
    if (resp?.ok) statusEl.textContent = ok(resp);
    else statusEl.textContent = fail ? fail(resp) : `Failed: ${resp?.error || "unknown"}`;
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
  } finally {
    if (button) button.disabled = false;
  }
  return resp;
}

/**
 * Pending count plus the per-direction breakdown (hidden when the queue is empty).
 * @param {{ pending?: number, pendingByDirection?: object }} resp
 * @param {HTMLElement} pendingEl
 * @param {HTMLElement} dirEl
 */
export function renderPendingCounts(resp, pendingEl, dirEl) {
  const pending = resp.pending ?? 0;
  pendingEl.textContent = pending;
  const dirs = resp.pendingByDirection;
  dirEl.textContent = dirs && pending > 0 ? ` (${formatPendingByDirection(dirs)})` : "";
}
