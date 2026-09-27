#!/usr/bin/env node
/**
 * Headed/headless Chrome smoke for Options bulk-lane UI (Status banner + Match).
 *
 * SAFETY:
 * - Fresh --user-data-dir (empty Favorites) — does not touch your normal profile.
 * - Raindrop: read-only export.csv for Match plan; Apply is cancelled via stubbed confirm.
 * - Queue phantoms are in extension storage only; Continue drip clears the pause.
 *
 * Usage:
 *   node scripts/smoke-bulk-options.mjs
 *   RAINDROP_TOKEN=… node scripts/smoke-bulk-options.mjs
 *   SMOKE_HEADED=1 node scripts/smoke-bulk-options.mjs   # visible window
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { loadToken, scriptsRoot } from "./lib/test-harness.mjs";

const EXT_PATH = path.join(scriptsRoot, "src");
const HEADED = process.env.SMOKE_HEADED === "1" || process.env.SMOKE_HEADED === "true";

async function loadPuppeteer() {
  const require = createRequire(import.meta.url);
  try {
    return require("puppeteer-core");
  } catch {
    /* not in project deps */
  }
  const { execSync } = await import("node:child_process");
  const npmPrefix = path.join(scriptsRoot, ".tmp", "smoke-npm");
  if (!fs.existsSync(path.join(npmPrefix, "node_modules", "puppeteer-core"))) {
    console.log("Installing puppeteer-core into .tmp/smoke-npm…");
    // ≥25: Chrome 137+ removed --load-extension; use browser.installExtension.
    execSync(`npm install --prefix "${npmPrefix}" puppeteer-core@25`, {
      stdio: "inherit",
    });
  }
  return createRequire(path.join(npmPrefix, "package.json"))("puppeteer-core");
}

function chromePath() {
  for (const p of [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ]) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error("No Chrome/Edge binary found");
}

async function main() {
  const token = loadToken();
  if (!token) {
    console.error("RAINDROP_TOKEN or .tmp/raindrop_token required for Match plan smoke.");
    process.exit(1);
  }

  const puppeteer = await loadPuppeteer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ers-bulk-smoke-"));
  console.log(`Profile: ${userDataDir}`);
  console.log(`Extension: ${EXT_PATH}`);
  // Extension install via BiDi needs a non-headless Chrome in practice.
  console.log(HEADED ? "Mode: headed" : "Mode: headed (required for installExtension)");

  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: false,
    userDataDir,
    enableExtensions: true,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-default-apps"],
  });

  const results = [];
  const pass = (name) => {
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  };
  const fail = (name, err) => {
    results.push({ name, ok: false, err: String(err) });
    console.error(`  ✖ ${name}: ${err}`);
  };

  try {
    const extId = await browser.installExtension(EXT_PATH);
    console.log(`Extension id: ${extId}`);
    // Wait for service worker
    await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().includes(extId),
      { timeout: 15000 }
    );
    const optionsUrl = `chrome-extension://${extId}/options/options.html`;

    const page = await browser.newPage();
    // Stub confirms so automation is not blocked; default Cancel Apply / cancel Import match.
    await page.evaluateOnNewDocument(() => {
      window.__confirmLog = [];
      window.confirm = (msg) => {
        window.__confirmLog.push(String(msg));
        // Cancel Apply / dry-run Apply; for bulk gate first confirm "Match first?" → false → second "continue?" → false (cancel)
        if (/record \d+ pair/i.test(msg) || /Show dry-run/i.test(msg)) return false;
        if (/Match from export first/i.test(msg) || /without matching/i.test(msg)) return false;
        if (/Continue .* without matching/i.test(msg)) return false;
        return false;
      };
    });

    await page.goto(optionsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#matchExisting", { timeout: 10000 });

    // --- Controls present ---
    try {
      const ids = await page.evaluate(() => ({
        match: !!document.getElementById("matchExisting"),
        banner: !!document.getElementById("bulkQueueBanner"),
        bannerMatch: !!document.getElementById("bulkQueueMatch"),
        bannerContinue: !!document.getElementById("bulkQueueContinue"),
        backfill: !!document.getElementById("backfill"),
      }));
      assert.ok(ids.match && ids.banner && ids.bannerMatch && ids.bannerContinue && ids.backfill);
      const repairish = await page.evaluate(() =>
        [...document.querySelectorAll("button")].some((b) => /repair/i.test(b.id + b.textContent))
      );
      assert.equal(repairish, false);
      pass("Options shows Match + bulk banner controls; no repair");
    } catch (e) {
      fail("Options controls", e.message || e);
    }

    // Banner hidden when idle
    try {
      const hidden = await page.evaluate(() =>
        document.getElementById("bulkQueueBanner").classList.contains("hidden")
      );
      assert.equal(hidden, true);
      pass("Bulk banner hidden when idle");
    } catch (e) {
      fail("Banner hidden idle", e.message || e);
    }

    // Seed config + deep queue so GET_STATUS keeps needs_choice
    await page.evaluate(
      async ({ token }) => {
        const phantom = Array.from({ length: 150 }, (_, i) => ({
          id: `smoke-phantom-${i}`,
          kind: "upload",
          attempts: 0,
          nextAttemptAt: 0,
        }));
        await chrome.storage.local.set({
          config: {
            token,
            rootName: "test-edge-raindrop-sync",
            syncMode: "bidirectional",
            defaultPolicy: "sync-and-keep",
            raindropFolderMode: "create-as-needed",
            pruneEmptyFolders: false,
            keepLongTermLog: false,
            reconcileIntervalMinutes: 15,
          },
          queue: phantom,
          bulkPrompt: { status: "needs_choice", snoozedBelow: null },
        });
      },
      { token }
    );

    // Trigger status refresh
    await page.evaluate(() => {
      if (typeof refreshStatus === "function") return refreshStatus();
    });
    // refreshStatus may not be global — click Status tab / wait for interval
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#bulkQueueBanner", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1500));

    try {
      const banner = await page.evaluate(() => {
        const el = document.getElementById("bulkQueueBanner");
        const text = document.getElementById("bulkQueueBannerText")?.textContent || "";
        return {
          hidden: el.classList.contains("hidden"),
          text,
        };
      });
      assert.equal(banner.hidden, false, "banner should be visible");
      assert.ok(/Match/i.test(banner.text) || /queue/i.test(banner.text), banner.text);
      pass("Bulk banner visible with deep queue / needs_choice");
    } catch (e) {
      fail("Banner visible", e.message || e);
    }

    // Continue drip
    try {
      await page.click("#bulkQueueContinue");
      await new Promise((r) => setTimeout(r, 1500));
      const after = await page.evaluate(async () => {
        const el = document.getElementById("bulkQueueBanner");
        const st = document.getElementById("bulkQueueStatus")?.textContent || "";
        const stored = await chrome.storage.local.get(["bulkPrompt", "queue"]);
        return {
          hidden: el.classList.contains("hidden"),
          statusText: st,
          bulkPrompt: stored.bulkPrompt,
          pending: (stored.queue || []).length,
        };
      });
      assert.equal(after.bulkPrompt?.status, "idle", JSON.stringify(after.bulkPrompt));
      assert.ok(after.bulkPrompt?.snoozedBelow != null, "snoozed after continue");
      // Banner should hide after refresh (pending still high but snoozed)
      assert.equal(after.hidden, true, "banner hidden after continue drip");
      pass("Continue drip snoozes prompt and hides banner");
    } catch (e) {
      fail("Continue drip", e.message || e);
    }

    // Re-arm for Match-from-banner path: clear snooze, set needs_choice again
    await page.evaluate(async () => {
      const q = await chrome.storage.local.get("queue");
      const queue = q.queue || [];
      await chrome.storage.local.set({
        queue,
        bulkPrompt: { status: "needs_choice", snoozedBelow: null },
      });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1500));

    try {
      const visible = await page.evaluate(
        () => !document.getElementById("bulkQueueBanner").classList.contains("hidden")
      );
      assert.ok(visible);
      // Match from banner: plan hits live export; confirms stubbed to cancel Apply
      await page.click("#bulkQueueMatch");
      // Export can take a while
      await page.waitForFunction(
        () => {
          const t = document.getElementById("bulkQueueStatus")?.textContent || "";
          return (
            /Would pair|already paired|Match failed|rate limit|nothing|Drain resumed|pair/i.test(t) &&
            !/Downloading Raindrop export/i.test(t)
          );
        },
        { timeout: 120000 }
      );
      const matchStatus = await page.evaluate(
        () => document.getElementById("bulkQueueStatus")?.textContent || ""
      );
      assert.ok(
        /Would pair|already paired|Raindrop-only|Edge-only|failed|rate limit/i.test(matchStatus),
        matchStatus
      );
      // Fresh profile: expect 0 pairs → nothing path may resume drain
      pass(`Match from banner ran (status: ${matchStatus.slice(0, 120)}…)`);
    } catch (e) {
      fail("Match from banner", e.message || e);
    }

    // Power-user Match on Manual Sync tab
    try {
      await page.click('a[href="#sync"], [data-tab="sync"], #tab-sync, button[data-tab="sync"]');
    } catch {
      /* try hash */
      await page.goto(`chrome-extension://${extId}/options/options.html#sync`, {
        waitUntil: "domcontentloaded",
      });
    }
    await new Promise((r) => setTimeout(r, 500));

    try {
      await page.waitForSelector("#matchExisting", { timeout: 5000 });
      // Ensure visible
      await page.evaluate(() => {
        const btn = document.getElementById("matchExisting");
        btn?.scrollIntoView();
      });
      await page.click("#matchExisting");
      await page.waitForFunction(
        () => {
          const t = document.getElementById("matchExistingStatus")?.textContent || "";
          return t && !/Downloading/i.test(t);
        },
        { timeout: 120000 }
      );
      const st = await page.evaluate(
        () => document.getElementById("matchExistingStatus")?.textContent || ""
      );
      assert.ok(/Would pair|already paired|failed|rate limit|pair/i.test(st), st);
      pass(`Manual Sync Match existing ran (status: ${st.slice(0, 120)}…)`);
    } catch (e) {
      fail("Manual Match existing", e.message || e);
    }

    // Import cancel path: seed enough unpaired bookmarks to trigger bulk gate
    try {
      await page.evaluate(async () => {
        // Create 210 bookmarks under Favorites bar so unpaired ≥ 200
        const bar = (await chrome.bookmarks.getTree())[0].children.find(
          (c) => c.title === "Bookmarks bar" || c.title === "Favorites bar"
        );
        const parentId = bar?.id || "1";
        const folder = await chrome.bookmarks.create({
          parentId,
          title: "ERS-Smoke-Bulk-Import",
        });
        for (let i = 0; i < 210; i++) {
          await chrome.bookmarks.create({
            parentId: folder.id,
            title: `smoke-${i}`,
            url: `https://example.com/ers-smoke-${i}`,
          });
        }
      });
      // Navigate to sync tab and click Import
      await page.goto(`chrome-extension://${extId}/options/options.html#sync`, {
        waitUntil: "domcontentloaded",
      });
      await new Promise((r) => setTimeout(r, 800));
      await page.waitForSelector("#backfill", { timeout: 5000 });
      // Live onCreated may already have queued the seeded bookmarks — that is not Import.
      const pendingBefore = await page.evaluate(async () => {
        const { queue } = await chrome.storage.local.get("queue");
        return (queue || []).length;
      });
      await page.evaluate(() => {
        window.__confirmLog = [];
      });
      // confirm stubs return false → cancel chain
      await page.click("#backfill");
      await page.waitForFunction(
        () => {
          const t = document.getElementById("importStatus")?.textContent || "";
          const confirms = window.__confirmLog || [];
          return /cancelled/i.test(t) || confirms.some((m) => /Import to Raindrop/i.test(m));
        },
        { timeout: 60000 }
      );
      const importStatus = await page.evaluate(
        () => document.getElementById("importStatus")?.textContent || ""
      );
      const confirms = await page.evaluate(() => window.__confirmLog || []);
      assert.ok(
        confirms.some((m) => /Import to Raindrop/i.test(m) || /Match from Raindrop export/i.test(m)),
        `expected bulk gate confirm, got: ${JSON.stringify(confirms).slice(0, 300)}`
      );
      assert.ok(/cancelled/i.test(importStatus), `importStatus=${importStatus}`);
      const pendingAfter = await page.evaluate(async () => {
        const { queue } = await chrome.storage.local.get("queue");
        return (queue || []).length;
      });
      assert.equal(
        pendingAfter,
        pendingBefore,
        `Import cancel must not grow the queue (${pendingBefore} → ${pendingAfter})`
      );
      pass("Import bulk gate prompted and cancel did not enqueue mass Import");
    } catch (e) {
      fail("Import bulk gate cancel", e.message || e);
    }
  } finally {
    await browser.close().catch(() => {});
    // Leave profile for debugging if SMOKE_KEEP=1
    if (process.env.SMOKE_KEEP !== "1") {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } else {
      console.log(`Kept profile: ${userDataDir}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSmoke: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
