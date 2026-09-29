// Presence snapshot (design D4): build, completeness, durable restore, and
// refresh cadence per reason.

import assert from "node:assert/strict";
import { test, beforeEach } from "vitest";
import { storage } from "../scripts/lib/test-harness.mjs";
import {
  buildSnapshot,
  ensurePresence,
  loadPresence,
  resetPresenceMemory,
  presenceRefreshDue,
  isUsableForAbsence,
  isUsableForUrls,
  idsForUrl,
  adoptExportCsv,
} from "../src/lib/presence.js";
import {
  PRESENCE_STALE_MS,
  PRESENCE_MAX_AGE_MS,
  PRESENCE_SHRINK_MIN_ROWS,
} from "../src/lib/constants.js";
import { WakeBudget } from "../src/lib/wake-budget.js";

const CSV = [
  "id,title,url",
  "10,A,https://a.example/page?utm=1",
  '11,"B, with comma",https://www.b.example/x/',
  "12,B copy,https://b.example/x",
].join("\n");

/** Fake client: counts exports, optionally charges a bound budget. */
function fakeClient(csv = CSV) {
  return {
    exports: 0,
    _budget: null,
    bindBudget(b) {
      this._budget = b;
    },
    async exportRaindropsCsv() {
      this.exports++;
      this._budget?.noteRequest(this);
      if (csv instanceof Error) throw csv;
      return csv;
    },
  };
}

beforeEach(() => {
  storage.clear();
  resetPresenceMemory();
});

test("snapshot built from export: ids, url index, complete", () => {
  const snap = buildSnapshot(CSV, { at: 1000 });
  assert.equal(snap.complete, true);
  assert.equal(snap.urlIndexed, true);
  assert.deepEqual([...snap.ids].sort(), ["10", "11", "12"]);
  assert.equal(snap.at, 1000);
  // www / trailing slash match by exact key; query noise matches as a lone loose hit.
  assert.deepEqual(idsForUrl(snap, "https://b.example/x").sort(), ["11", "12"]);
  assert.deepEqual(idsForUrl(snap, "https://a.example/page"), ["10"]);
  // Distinct query variants never merge.
  const watch = buildSnapshot(
    "id,url\n1,https://example.com/watch?v=A\n2,https://example.com/watch?v=B\n",
    { at: 1000 }
  );
  assert.deepEqual(idsForUrl(watch, "https://example.com/watch?v=A"), ["1"]);
  assert.deepEqual(idsForUrl(watch, "https://example.com/watch?v=B"), ["2"]);
  assert.equal(snap.urlById.get("11"), "https://www.b.example/x/");
});

test("malformed export is not complete", () => {
  const noHeader = buildSnapshot("foo,bar\n1,2\n");
  assert.equal(noHeader.complete, false);
  assert.equal(noHeader.urlIndexed, false);
  assert.match(noHeader.error, /id\/url/);

  const truncated = buildSnapshot('id,url\n1,"https://a.example/');
  assert.equal(truncated.complete, false, "body ending inside a quote is a truncated response");
});

test("export shrinking below half is not complete until a second export agrees", () => {
  const prev = PRESENCE_SHRINK_MIN_ROWS * 2;
  const rows = ["id,url", ...Array.from({ length: 10 }, (_, i) => `${i},https://s.example/${i}`)];
  const shrunk = buildSnapshot(rows.join("\n"), { previousCompleteCount: prev });
  assert.equal(shrunk.complete, false, "10 rows after 100 is suspicious");
  assert.equal(shrunk.lastCompleteCount, prev, "last complete count kept");
  assert.equal(shrunk.suspectCount, 10);

  const confirmed = buildSnapshot(rows.join("\n"), {
    previousCompleteCount: prev,
    previousSuspectCount: shrunk.suspectCount,
  });
  assert.equal(confirmed.complete, true, "a second export at the same count confirms the cleanup");
  assert.equal(confirmed.lastCompleteCount, 10);

  // Tiny libraries swing by half on ordinary edits: no shrink rule.
  const small = buildSnapshot("id,url\n1,https://s.example/1\n", { previousCompleteCount: 3 });
  assert.equal(small.complete, true);

  // Empty export while pairs exist is suspicious.
  assert.equal(buildSnapshot("id,url\n", { expectNonEmpty: true }).complete, false);
  assert.equal(buildSnapshot("id,url\n", { expectNonEmpty: false }).complete, true);
});

test("worker restart restores ids without a new export", async () => {
  const client = fakeClient();
  const first = await ensurePresence({ client, reason: "pull-now" });
  assert.equal(first.refreshed, true);
  assert.equal(client.exports, 1);

  resetPresenceMemory(); // service worker restart
  const restored = await loadPresence();
  assert.deepEqual([...restored.ids].sort(), ["10", "11", "12"], "durable ids restored");
  assert.equal(restored.urlIndexed, false, "URLs are not persisted");
  assert.equal(restored.seq, first.snapshot.seq);
  assert.equal(isUsableForAbsence(restored), true, "ids alone serve absence checks");
  assert.equal(isUsableForUrls(restored), false, "survival checks need the URL index");

  // Heartbeat inside the interval: the restored snapshot answers.
  const hb = await ensurePresence({ client, reason: "heartbeat", intervalMs: 60_000 });
  assert.equal(hb.refreshed, false);
  assert.equal(client.exports, 1, "no export on restart within the interval");

  // A URL consumer re-exports once to rebuild the index.
  const od = await ensurePresence({ client, reason: "on-demand" });
  assert.equal(od.refreshed, true);
  assert.equal(od.snapshot.urlIndexed, true);
  assert.equal(client.exports, 2);
});

test("refresh cadence per reason", () => {
  const now = 10_000_000;
  const fresh = { at: now - 1000, urlIndexed: true, seq: 5 };
  const stale = { at: now - PRESENCE_STALE_MS, urlIndexed: true, seq: 5 };
  const interval = 60_000;

  assert.equal(presenceRefreshDue(null, "heartbeat", { now, intervalMs: interval }), true);
  assert.equal(presenceRefreshDue(fresh, "heartbeat", { now, intervalMs: interval }), false);
  assert.equal(
    presenceRefreshDue({ ...fresh, at: now - interval }, "heartbeat", {
      now,
      intervalMs: interval,
    }),
    true,
    "heartbeat refreshes at the reconcile interval"
  );

  assert.equal(presenceRefreshDue(fresh, "on-demand", { now }), false, "fresh snapshot reused");
  assert.equal(presenceRefreshDue(stale, "on-demand", { now }), true, "10-minute staleness");
  assert.equal(presenceRefreshDue({ ...fresh, urlIndexed: false }, "on-demand", { now }), true);
  assert.equal(
    presenceRefreshDue(fresh, "on-demand", { now, afterSeq: 5 }),
    true,
    "needs a later export"
  );
  assert.equal(presenceRefreshDue(fresh, "on-demand", { now, afterSeq: 4 }), false);

  assert.equal(presenceRefreshDue(fresh, "pull-now", { now }), true, "Pull now always refreshes");

  const aged = { at: now - PRESENCE_MAX_AGE_MS - 1, complete: true, urlIndexed: true };
  assert.equal(isUsableForAbsence(aged, now), false, "aged-out snapshot never drives deletes");
  assert.equal(isUsableForAbsence({ ...aged, at: now - 1000 }, now), true);
});

test("export counts against the wake budget; no budget, no export", async () => {
  const client = fakeClient();
  const budget = new WakeBudget({ mode: "full", headerRemaining: 100, headerResetAt: null });
  client.bindBudget(budget);
  await ensurePresence({ client, budget, reason: "pull-now" });
  assert.equal(budget.spent, 1, "one export = one request charged");

  const empty = new WakeBudget({
    mode: "full",
    headerRemaining: 100,
    headerResetAt: null,
    wakeCapReqs: 0,
  });
  const got = await ensurePresence({ client, budget: empty, reason: "pull-now" });
  assert.equal(got.refreshed, false);
  assert.equal(got.unavailable, true);
  assert.equal(client.exports, 1, "no export without spendable");
});

test("export failure keeps the previous snapshot; seq increases per export", async () => {
  const ok = await ensurePresence({ client: fakeClient(), reason: "pull-now" });
  const failed = await ensurePresence({ client: fakeClient(new Error("502")), reason: "pull-now" });
  assert.equal(failed.refreshed, false);
  assert.equal(failed.unavailable, true);
  assert.equal(failed.snapshot, ok.snapshot, "old snapshot still answers");

  const adopted = await adoptExportCsv(CSV, Date.now());
  assert.equal(adopted.seq, ok.snapshot.seq + 1, "Match/Repair exports advance seq too");
});
