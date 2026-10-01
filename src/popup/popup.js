// Popup: compact status and Pull now. Import lives in Options only, behind the
// bulk Match gate (a thinly paired library must not be re-uploaded wholesale).

import { MSG, SYNC_MODE } from "../lib/constants.js";
import { runPullNow } from "../lib/pull-now.js";
import { formatHaltBanner } from "../lib/status-format.js";
import { fmtTime, renderPendingCounts, setLine } from "../ui/actions.js";

const $ = (id) => document.getElementById(id);

async function refresh() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
  } catch {
    return;
  }
  if (!resp?.ok) return;

  renderPendingCounts(resp, $("pending"), $("pendingByDirection"));
  const last = resp.status?.lastActivityAt;
  $("lastActivity").textContent = last ? `Last sync ${fmtTime(last)}` : "No syncs yet";

  const bi = resp.syncMode === SYNC_MODE.BIDIRECTIONAL;
  $("title").textContent = bi ? "Bookmarks ↔ Raindrop" : "Bookmarks → Raindrop";
  $("modeLine").textContent = bi ? "Mode: bidirectional" : "Mode: one-way";
  $("pullAction").classList.toggle("hidden", !bi);

  setLine($("halt"), formatHaltBanner(resp.status, { compact: true }));
}

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
