// Pair records (design D1/D2): record writes, derived indexes, and the
// one-shot v1 → v2 migration (memo invariant 6: migration drops ghosts).

import assert from "node:assert/strict";
import { test } from "vitest";
import { setupEngine, edgeBookmark, edgeFolder, jobsOfKind, storage } from "./helpers/engine.mjs";

test("record written on sync carries url, placement and timestamps", async () => {
  const { eng, root } = await setupEngine();
  const folder = await edgeFolder("1", "Dev");
  const bm = await edgeBookmark(folder.id, "Docs", "https://docs.example/a");
  await eng.queue.enqueue(bm.id);
  await eng.sync.drain();

  const rid = await eng.store.getRaindropId(bm.id);
  assert.ok(rid);
  const rec = await eng.store.getPairRecord(rid);
  assert.equal(rec.bookmarkId, bm.id);
  assert.equal(rec.url, "https://docs.example/a");
  assert.equal(rec.urlKey, "https://docs.example/a");
  assert.equal(rec.title, "Docs");
  assert.equal(rec.edgeParentId, folder.id);
  assert.deepEqual(rec.edgePathAtSync, ["Favorites bar", "Dev"]);
  assert.ok(rec.collectionId, "Raindrop collection recorded");
  assert.notEqual(rec.collectionId, String(root._id), "nested collection, not the root");
  assert.ok(rec.lastSeenEdgeAt > 0 && rec.lastSeenRaindropAt > 0);

  const stored = storage.get("pairs");
  assert.equal(stored.v, 2);
  assert.ok(stored.records[rid], "records keyed by raindrop id");
  assert.equal(stored.byBookmark, undefined, "indexes are not persisted");
});

test("indexes rebuild after add, rebind and remove without a separate index write", async () => {
  const { eng } = await setupEngine();
  await eng.store.recordSynced("b1", "r1", { url: "https://x.example/" });
  await eng.store.recordSynced("b2", "r2", { url: "https://y.example/" });
  let pairs = await eng.store.getPairs();
  assert.deepEqual(pairs.byBookmark, { b1: "r1", b2: "r2" });
  assert.deepEqual(pairs.byUrlKey["https://x.example/"], ["r1"]);

  // Re-pairing b1 drops its old forward link.
  await eng.store.recordSynced("b1", "r9", { url: "https://x.example/" });
  pairs = await eng.store.getPairs();
  assert.equal(pairs.records.r1, undefined);
  assert.equal(await eng.store.getRaindropId("b1"), "r9");
  assert.equal(await eng.store.getBookmarkIdForRaindrop("r9"), "b1");

  // Rebind (Edge side) is visible on the next read.
  const rec = pairs.records.r2;
  const applied = await eng.store.applyPairChanges([
    { type: "edge", raindropId: "r2", fromBookmarkId: "b2", record: { ...rec, bookmarkId: "b7" } },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(await eng.store.getRaindropId("b7"), "r2");
  assert.equal(await eng.store.hasSynced("b2"), false);

  // A change computed against stale state does not apply.
  const stale = await eng.store.applyPairChanges([
    { type: "edge", raindropId: "r2", fromBookmarkId: "b2", record: { ...rec, bookmarkId: "b8" } },
  ]);
  assert.equal(stale.length, 0, "concurrent change wins");

  await eng.store.forgetPairByRaindrop("r2");
  await eng.store.forgetSynced("b1");
  assert.deepEqual((await eng.store.getPairs()).byBookmark, {});
});

/** Seed a legacy v1 map as older versions stored it. */
async function seedV1(byBookmark) {
  const byRaindrop = {};
  for (const [b, r] of Object.entries(byBookmark)) byRaindrop[r] = b;
  storage.set("pairs", { byBookmark, byRaindrop });
  storage.set("reconcile", {
    cursorPage: 0,
    seenAcc: ["1"],
    parkedAliveIds: ["2"],
    aliveConfirmOffset: 3,
  });
}

test("migration keeps live pairs, rebinds by URL, drops ghosts (invariant 6)", async () => {
  const { eng, mock, root } = await setupEngine();
  const live = mock._seedRich(root._id, { link: "https://m.example/live", title: "live" });
  const survivor = mock._seedRich(root._id, { link: "https://m.example/forked", title: "orig" });
  const renamedTarget = mock._seedRich(root._id, {
    link: "https://m.example/renum",
    title: "renum",
  });

  const liveBm = await edgeBookmark("1", "live", "https://m.example/live");
  const forkBm = await edgeBookmark("1", "forked", "https://m.example/forked");
  const renumBm = await edgeBookmark("1", "renum", "https://m.example/renum");

  await seedV1({
    [liveBm.id]: String(live._id), // both alive
    [forkBm.id]: "88888", // raindrop trashed fork; URL alive as `survivor`
    old_renum_id: String(renamedTarget._id), // Edge id renumbered; URL alive in tree
    dead_dead: "99999", // both gone, no URL anywhere
  });
  // Legacy reconcile keys go on first load.
  const view = await eng.store.ensurePairsMigrated();
  assert.equal(view.migrationPartial, true, "id-only records until URLs are filled");
  const rs = storage.get("reconcile");
  assert.equal("seenAcc" in rs || "parkedAliveIds" in rs || "aliveConfirmOffset" in rs, false);
  assert.ok(storage.get("pairsV1Backup"), "v1 map backed up");

  await eng.sync.drain(); // drain completes the migration with a client
  const pairs = await eng.store.getPairs();
  assert.equal(pairs.migrationPartial, false);
  assert.equal(pairs.byBookmark[liveBm.id], String(live._id), "kept");
  assert.equal(pairs.byBookmark[forkBm.id], String(survivor._id), "Raindrop id rebound");
  assert.equal(pairs.byBookmark[renumBm.id], String(renamedTarget._id), "Edge id rebound");
  assert.equal(pairs.records["99999"], undefined, "unresolvable ghost dropped");
  assert.equal(Object.keys(pairs.records).length, 3);
  assert.equal(pairs.records[String(live._id)].url, "https://m.example/live", "url filled");

  const log = (await eng.store.getLog()).map((l) => l.message);
  const summary = log.filter((m) => m.startsWith("Pair migration:"));
  assert.equal(summary.length, 1, "one summary line");
  assert.match(summary[0], /kept 3, rebound 2 \(1 Edge id, 1 Raindrop id\), dropped 1/);
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0, "migration never deletes");
  assert.equal((await jobsOfKind(eng, "delete-raindrop")).length, 0);
});

test("export unavailable at migration: partial, absence deletes blocked, retried later", async () => {
  const { eng, mock, root } = await setupEngine();
  const alive = mock._seedRich(root._id, { link: "https://p.example/a", title: "a" });
  const bmA = await edgeBookmark("1", "a", "https://p.example/a");
  const bmGone = await edgeBookmark("1", "gone", "https://p.example/gone");
  await seedV1({ [bmA.id]: String(alive._id), [bmGone.id]: "4242" });
  await eng.store.ensurePairsMigrated();

  const realExport = mock.exportRaindropsCsv;
  mock.exportRaindropsCsv = async () => {
    throw new Error("export 502");
  };
  await eng.sync.drain();
  let pairs = await eng.store.getPairs();
  assert.equal(pairs.migrationPartial, true, "partial without an export");
  assert.equal(pairs.records[String(alive._id)].url, "https://p.example/a", "tree side filled");
  assert.ok(
    (await eng.store.getLog()).some((l) => /Raindrop export unavailable/.test(l.message)),
    "partial migration logged"
  );

  // Next wake with a working export completes migration first, then deletes
  // run on a complete snapshot (4242 has no survivor → candidate).
  mock.exportRaindropsCsv = realExport;
  await eng.reconcile.reconcile({ force: true });
  pairs = await eng.store.getPairs();
  assert.equal(pairs.migrationPartial, false, "completed on a later wake");
  assert.ok(
    (await jobsOfKind(eng, "delete-edge")).some((j) => j.raindropId === "4242"),
    "absence deletes resume once migration is complete"
  );
});

test("absence deletes stay off while migrationPartial is set", async () => {
  const { eng, mock, root } = await setupEngine();
  mock._seedRich(root._id, { link: "https://q.example/keep", title: "keep" });
  const bm = await edgeBookmark("1", "gone", "https://q.example/gone");
  await eng.store.recordSynced(bm.id, "5151", { url: "https://q.example/gone" });
  await eng.store.rewritePairRecords((stored) => ({
    records: stored.records,
    migrationPartial: true,
    result: null,
  }));
  // Export fails so migration cannot complete during this reconcile.
  mock.exportRaindropsCsv = async () => {
    throw new Error("export 503");
  };
  await eng.reconcile.reconcile({ force: true });
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0);
});

test("v1 backup dropped after the next completed finish", async () => {
  const { eng, mock, root } = await setupEngine();
  const item = mock._seedRich(root._id, { link: "https://v.example/", title: "v" });
  const bm = await edgeBookmark("1", "v", "https://v.example/");
  await seedV1({ [bm.id]: String(item._id) });
  await eng.store.ensurePairsMigrated();
  assert.ok(storage.get("pairsV1Backup"));
  await eng.reconcile.reconcile({ force: true });
  assert.equal(storage.has("pairsV1Backup"), false, "backup gone after a completed finish");
  assert.equal((await eng.store.getPairs()).byBookmark[bm.id], String(item._id));
});

test("Match existing skips bookmarks in excluded folders", async () => {
  const { eng, mock, root } = await setupEngine();
  const { POLICY } = eng.constants;
  const priv = await edgeFolder("2", "Private");
  await eng.store.setOverride(priv.id, POLICY.EXCLUDE, "Other favorites/Private");
  const hidden = await edgeBookmark(priv.id, "hidden", "https://e.example/hidden");
  const shown = await edgeBookmark("1", "shown", "https://e.example/shown");
  mock._seedRich(root._id, { link: "https://e.example/hidden", title: "hidden" });
  mock._seedRich(root._id, { link: "https://e.example/shown", title: "shown" });

  const plan = await eng.matchExisting.planMatchExisting();
  const matchedIds = plan.matched.map((m) => m.bookmarkId);
  assert.ok(matchedIds.includes(shown.id), "in-scope bookmark matched");
  assert.ok(!matchedIds.includes(hidden.id), "excluded-folder bookmark not matched");
});

test("Match existing treats a pair held by an excluded-folder bookmark as a conflict", async () => {
  const { eng, mock, root } = await setupEngine();
  const { POLICY } = eng.constants;
  const priv = await edgeFolder("2", "Private");
  await eng.store.setOverride(priv.id, POLICY.EXCLUDE, "Other favorites/Private");
  const url = "https://e.example/shared";
  const held = await edgeBookmark(priv.id, "held", url);
  const other = await edgeBookmark("1", "other", url);
  const item = mock._seedRich(root._id, { link: url, title: "shared" });
  await eng.store.recordSynced(held.id, String(item._id), { url });

  const plan = await eng.matchExisting.planMatchExisting();
  assert.ok(
    !plan.matched.some((m) => m.bookmarkId === other.id),
    "live out-of-scope holder blocks the claim"
  );
  assert.equal(plan.conflicts, 1);
});
