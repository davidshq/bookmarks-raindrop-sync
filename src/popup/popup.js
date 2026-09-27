// Popup: compact status and quick actions. Delegates to the service worker.

import { MSG, SYNC_MODE } from "../lib/constants.js";
import { runPullNow } from "../lib/pull-now.js";
import { formatPendingByDirection } from "../lib/queue.js";

const $ = (id) => document.getElementById(id);

async function refresh() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
  } catch {
    return;
  }
  if (!resp?.ok) return;

  $("pending").textContent = resp.pending ?? 0;
  const dirs = resp.pendingByDirection;
  const dirEl = $("pendingByDirection");
  if (dirs && (resp.pending ?? 0) > 0) {
    dirEl.textContent = ` (${formatPendingByDirection(dirs)})`;
  } else {
    dirEl.textContent = "";
  }
  const last = resp.status?.lastActivityAt;
  $("lastActivity").textContent = last
    ? `Last sync ${new Date(last).toLocaleTimeString()}`
    : "No syncs yet";

  const bi = resp.syncMode === SYNC_MODE.BIDIRECTIONAL;
  $("title").textContent = bi ? "Bookmarks ↔ Raindrop" : "Bookmarks → Raindrop";
  $("modeLine").textContent = bi ? "Mode: bidirectional" : "Mode: one-way";
  $("pullAction").classList.toggle("hidden", !bi);

  const halt = $("halt");
  const rateUntil = resp.status?.rateLimitedUntil;
  if (rateUntil && rateUntil > Date.now()) {
    halt.classList.remove("hidden");
    halt.textContent = `Rate limited until ${new Date(rateUntil).toLocaleTimeString()}`;
  } else if (resp.status?.deletionsHalted && resp.status?.lastError) {
    halt.classList.remove("hidden");
    halt.textContent = resp.status.lastError;
  } else {
    halt.textContent = "";
    halt.classList.add("hidden");
  }
}

$("backfill").addEventListener("click", async () => {
  const out = $("importStatus");
  out.textContent = "Queuing browser bookmarks…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.RUN_BACKFILL });
    out.textContent = resp?.ok
      ? `Queued ${resp.queued} bookmark(s).`
      : `Failed: ${resp?.error}`;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
  refresh();
});

$("reconcile").addEventListener("click", async () => {
  const out = $("pullStatus");
  out.textContent = "Pulling from Raindrop…";
  try {
    const { text } = await runPullNow((msg) => chrome.runtime.sendMessage(msg), {
      pendingMsg: "Pulling from Raindrop…",
      onProgress: (text) => {
        out.textContent = text;
      },
    });
    out.textContent = text;
  } catch (err) {
    out.textContent = `Failed: ${err.message}`;
  }
  refresh();
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 2000);
