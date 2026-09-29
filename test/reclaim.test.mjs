// Reclaim on every create (design D6; memo invariant 2): an unpaired upload
// binds to an existing raindrop with its URL instead of forking a copy.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setupEngine, edgeBookmark, edgeFolder } from "./helpers/engine.mjs";
import { PRESENCE_STALE_MS } from "../src/lib/constants.js";

test("invariant 2: plain create with an existing URL binds instead of forking", async () => {
  const { eng, mock, root, presence } = await setupEngine();
  const existing = mock._seedRich(root._id, {
    link: "https://r.example/page",
    title: "old title",
    tags: ["keep"],
  });
  await presence.ensurePresence({
    client: new eng.raindropMod.RaindropClient("mock"),
    reason: "pull-now",
  });

  const folder = await edgeFolder("1", "Reading");
  const bm = await edgeBookmark(folder.id, "new title", "https://r.example/page/");
  const creates = mock._calls.createRaindrop;
  const searches = mock._calls.searchRaindrops;
  await eng.sync.handleBookmarkCreated(bm.id, bm); // live onCreated → enqueue + drain

  assert.equal(mock._calls.createRaindrop, creates, "no Raindrop create");
  assert.equal(mock._calls.searchRaindrops, searches, "fresh snapshot answers; no search");
  assert.equal(await eng.store.getRaindropId(bm.id), String(existing._id), "paired to existing");
  const item = mock._raindrops.get(existing._id);
  assert.notEqual(item.collection.$id, root._id, "placement updated to the bookmark's folder");
  assert.equal(item.title, "new title", "Edge-owned title pushed");
  assert.deepEqual(item.tags, ["keep"], "Raindrop-owned fields untouched");
});

test("a raindrop this engine paired after the snapshot still reclaims (Import twice)", async () => {
  const { eng, mock, presence } = await setupEngine();
  await presence.ensurePresence({
    client: new eng.raindropMod.RaindropClient("mock"),
    reason: "pull-now",
  });
  const a = await edgeBookmark("1", "a", "https://twice.example/");
  await eng.queue.enqueue(a.id);
  await eng.sync.drain();
  const rid = await eng.store.getRaindropId(a.id);
  assert.ok(rid);

  // Same URL moved in from elsewhere while the first copy is live: conflict
  // for a move (dropped), not a second raindrop.
  const b = await edgeBookmark("1", "b", "https://twice.example/");
  const creates = mock._calls.createRaindrop;
  await eng.queue.enqueue(b.id, { reason: "move" });
  await eng.sync.drain();
  assert.equal(mock._calls.createRaindrop, creates, "move in conflict does not create");
  assert.equal(await eng.store.getRaindropId(b.id), null, "conflict mover stays unpaired");
});

test("plain create in conflict creates: two bookmarks, two raindrops", async () => {
  const { eng, mock } = await setupEngine();
  const a = await edgeBookmark("1", "a", "https://dup.example/");
  await eng.queue.enqueue(a.id);
  await eng.sync.drain();
  const b = await edgeBookmark("2", "b", "https://dup.example/");
  const creates = mock._calls.createRaindrop;
  await eng.queue.enqueue(b.id);
  await eng.sync.drain();
  assert.equal(mock._calls.createRaindrop, creates + 1);
  assert.notEqual(await eng.store.getRaindropId(a.id), await eng.store.getRaindropId(b.id));
});

test("crash retry after createAttemptedAt still reclaims (search, since the snapshot predates it)", async () => {
  const { eng, mock, root, presence } = await setupEngine();
  await presence.ensurePresence({
    client: new eng.raindropMod.RaindropClient("mock"),
    reason: "pull-now",
  });
  const bm = await edgeBookmark("1", "crash", "https://crash.example/");
  await eng.queue.enqueue(bm.id);
  // Previous drain POSTed, then the worker died before recordSynced.
  await eng.queue.patchJob(bm.id, { createAttemptedAt: Date.now() });
  const orphan = mock._seedRich(root._id, { link: "https://crash.example/", title: "crash" });
  const creates = mock._calls.createRaindrop;
  const searches = mock._calls.searchRaindrops;
  await eng.sync.drain();
  assert.equal(mock._calls.createRaindrop, creates, "no second create");
  assert.equal(mock._calls.searchRaindrops, searches + 1, "one search");
  assert.equal(await eng.store.getRaindropId(bm.id), String(orphan._id));
});

test("stale snapshot that cannot be refreshed falls back to exactly one search", async () => {
  const { eng, mock, root, presence } = await setupEngine();
  const existing = mock._seedRich(root._id, { link: "https://stale.example/", title: "s" });
  await presence.ensurePresence({
    client: new eng.raindropMod.RaindropClient("mock"),
    reason: "pull-now",
  });
  // Age the snapshot past PRESENCE_STALE_MS, then make the export unavailable.
  const snap = await presence.loadPresence();
  snap.at = Date.now() - PRESENCE_STALE_MS - 1000;
  mock.exportRaindropsCsv = async () => {
    throw new Error("export 503");
  };
  const bm = await edgeBookmark("1", "s", "https://stale.example/");
  const searches = mock._calls.searchRaindrops;
  const creates = mock._calls.createRaindrop;
  await eng.queue.enqueue(bm.id);
  await eng.sync.drain();
  assert.equal(mock._calls.searchRaindrops, searches + 1, "one searchRaindrops");
  assert.equal(mock._calls.createRaindrop, creates, "search found it; no create");
  assert.equal(await eng.store.getRaindropId(bm.id), String(existing._id));
});

test("Import refreshes the snapshot once and every upload reclaims from it", async () => {
  const { eng, mock, root } = await setupEngine();
  const urls = Array.from({ length: 6 }, (_, i) => `https://imp.example/${i}`);
  for (const url of urls) mock._seedRich(root._id, { link: url, title: url });
  for (const url of urls) await edgeBookmark("2", url, url);

  const exports = mock._calls.exportRaindropsCsv;
  const creates = mock._calls.createRaindrop;
  const searches = mock._calls.searchRaindrops;
  const result = await eng.backfill.startBackfill();
  assert.equal(result.queued, urls.length);
  await eng.sync.drainNow();
  assert.equal(mock._calls.exportRaindropsCsv - exports, 1, "one export for the whole batch");
  assert.equal(mock._calls.createRaindrop, creates, "no forks");
  assert.equal(mock._calls.searchRaindrops, searches, "no per-URL searches");
  const pairs = await eng.store.getPairs();
  assert.equal(Object.keys(pairs.records).length, urls.length);
});
