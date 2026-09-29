// Shared status strings for Options + popup: halt-banner precedence, rate-limit
// wording, and the Match / Repair dry-run summaries.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  fmtDateTime,
  fmtTime,
  formatHaltBanner,
  formatMatchPlanSummary,
  formatRepairPlanSummary,
  rateLimitedMessage,
  repairPlanIsNoop,
} from "../src/lib/status-format.js";

const NOW = Date.now();
const LATER = NOW + 60_000;
const at = (ms) => new Date(ms).toLocaleTimeString();

test("fmtTime / fmtDateTime fall back when there is no timestamp", () => {
  assert.equal(fmtTime(null), "—");
  assert.equal(fmtTime(0, "later"), "later");
  assert.equal(fmtTime(LATER), at(LATER));
  assert.equal(fmtDateTime(undefined), "—");
  assert.equal(fmtDateTime(LATER), new Date(LATER).toLocaleString());
});

test("rateLimitedMessage names the resume time or ends with the hint", () => {
  assert.equal(rateLimitedMessage(LATER), `Paused for Raindrop rate limits until ${at(LATER)}.`);
  assert.equal(
    rateLimitedMessage(),
    "Paused for Raindrop rate limits — wait a minute, then try again."
  );
  assert.equal(
    rateLimitedMessage(null, "try Refresh shortly."),
    "Paused for Raindrop rate limits — try Refresh shortly."
  );
});

test("halt banner: nothing to show", () => {
  assert.equal(formatHaltBanner(null), null);
  assert.equal(formatHaltBanner({}, { compact: true }), null);
  // lastError alone (no halt, not storage) is not a banner.
  assert.equal(formatHaltBanner({ lastError: "boom" }), null);
  // Expired rate-limit window is ignored.
  assert.equal(formatHaltBanner({ rateLimitedUntil: NOW - 1 }, { now: NOW }), null);
});

test("halt banner: rate-limit pause wins over everything", () => {
  const status = {
    rateLimitedUntil: LATER,
    lastError: "Storage write failed: quota",
    deletionsHalted: true,
    lastThrottle: "wake_cap",
  };
  assert.equal(
    formatHaltBanner(status, { now: NOW }),
    `Paused for Raindrop API rate limits until ${at(LATER)}. Sync resumes automatically.`
  );
  assert.equal(
    formatHaltBanner(status, { compact: true, now: NOW }),
    `Raindrop rate-limit pause until ${at(LATER)}`
  );
});

test("halt banner: storage write failure beats deletions halted, on both pages", () => {
  const status = { lastError: "Storage write failed: quota", deletionsHalted: true };
  assert.equal(formatHaltBanner(status), "Storage write failed: quota");
  assert.equal(formatHaltBanner(status, { compact: true }), "Storage write failed: quota");
  // Popup used to drop this when deletions were not halted.
  assert.equal(
    formatHaltBanner({ lastError: "Storage write failed: x" }, { compact: true }),
    "Storage write failed: x"
  );
});

test("halt banner: deletions halted wording per page, beats self-cap", () => {
  const status = { deletionsHalted: true, lastError: "too many", lastThrottle: "wake_cap" };
  assert.equal(
    formatHaltBanner(status),
    "Deletions halted: too many. Jobs are kept and will retry once resolved."
  );
  assert.equal(formatHaltBanner(status, { compact: true }), "too many");
  // Halted without an error message is not a banner.
  assert.equal(formatHaltBanner({ deletionsHalted: true }), null);
});

test("halt banner: self-cap notice only in compact mode", () => {
  const status = { lastThrottle: "wake_cap" };
  assert.equal(formatHaltBanner(status), null);
  assert.match(formatHaltBanner(status, { compact: true }), /soft per-wake request\/time cap/);
});

test("formatMatchPlanSummary", () => {
  const plan = {
    matched: [{}, {}],
    alreadyPaired: 5,
    ambiguous: 1,
    conflicts: 0,
    edgeOnly: 3,
    raindropOnly: 4,
    raindropCount: 11,
    edgeScanned: 10,
  };
  assert.equal(
    formatMatchPlanSummary(plan),
    "Would pair 2; already paired 5; ambiguous 1; conflicts 0; " +
      "Edge-only 3; Raindrop-only 4 (export 11, Edge 10)."
  );
  assert.match(formatMatchPlanSummary({ ...plan, matched: undefined }), /^Would pair 0;/);
});

const repairPlan = (over = {}) => ({
  pairsBefore: 10,
  keptLive: 8,
  edgeRebinds: 0,
  raindropRebinds: 0,
  matched: [],
  pruneBothDead: 0,
  pruneEdgeDead: 0,
  pruneRaindropDead: 0,
  ambiguous: 0,
  conflicts: 0,
  edgeOnly: 1,
  raindropOnly: 2,
  tombstonesAlive: [],
  tombstonesTotal: 3,
  queuedDeletes: 4,
  ...over,
});

test("formatRepairPlanSummary", () => {
  const plan = repairPlan({
    edgeRebinds: 2,
    raindropRebinds: undefined,
    matched: [{}],
    pruneEdgeDead: 1,
    pruneBothDead: 2,
    tombstonesAlive: ["x"],
  });
  assert.equal(
    formatRepairPlanSummary(plan),
    "Pairs now 10: keep 8 live, rebind 2 Edge id(s) and 0 Raindrop id(s), match 1 by URL, " +
      "prune 3 dead (1 Edge id gone, 0 raindrop gone, 2 both). Ambiguous 0, conflicts 0, " +
      "Edge-only 1, Raindrop-only 2. Clear 1 of 3 tombstone(s) (raindrop alive), " +
      "drop 4 queued delete(s)."
  );
});

test("repairPlanIsNoop: any match, rebind, prune or live tombstone is work", () => {
  // Queued deletes alone do not make a repair worth applying.
  assert.equal(repairPlanIsNoop(repairPlan()), true);
  assert.equal(repairPlanIsNoop(repairPlan({ matched: [{}] })), false);
  assert.equal(repairPlanIsNoop(repairPlan({ raindropRebinds: 1 })), false);
  assert.equal(repairPlanIsNoop(repairPlan({ pruneRaindropDead: 1 })), false);
  assert.equal(repairPlanIsNoop(repairPlan({ tombstonesAlive: ["x"] })), false);
  const shrink = repairPlan({ presenceShrink: { count: 10, lastCompleteCount: 100 } });
  assert.equal(repairPlanIsNoop(shrink), false, "accepting a shrunk export is work");
  assert.match(formatRepairPlanSummary(shrink), /accepts 10 as the new count/);
});
