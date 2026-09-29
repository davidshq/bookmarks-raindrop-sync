// Delete evidence (design D5; memo invariant 1): no delete in either
// direction without a positive signal and a failed survival check.

import assert from "node:assert/strict";
import { test } from "vitest";
import { setupEngine, edgeBookmark, edgeFolder, jobsOfKind, bookmarks } from "./helpers/engine.mjs";

/** Pair a fresh Edge bookmark to a fresh raindrop with the same URL. */
async function pairedBookmark(eng, mock, root, parentId, url, title = url) {
  const item = mock._seedRich(root._id, { link: url, title });
  const bm = await edgeBookmark(parentId, title, url);
  await eng.store.recordSynced(bm.id, String(item._id), { url, title });
  return { item, bm, rid: String(item._id) };
}

/** onRemoved as Chromium fires it for a single bookmark (with payload). */
async function removeWithPayload(eng, bm) {
  bookmarks.delete(String(bm.id));
  await eng.sync.handleBookmarkRemoved(bm.id, {
    parentId: bm.parentId,
    node: { id: bm.id, title: bm.title, url: bm.url, parentId: bm.parentId },
  });
}

/* ---- Raindrop → Edge ---- */

test("invariant 1: missing raindrop with an incomplete snapshot is not evidence", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm } = await pairedBookmark(eng, mock, root, "1", "https://e.example/a");
  mock._raindrops.delete(item._id); // gone (a GET would 404)
  mock.exportRaindropsCsv = async () => 'id,url\n1,"https://truncated'; // malformed body
  await eng.reconcile.reconcile({ force: true });
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0, "no delete-edge");
  assert.equal(mock._calls.getRaindrop, 0, "404-by-GET is never consulted");
  assert.ok(bookmarks.has(bm.id));
});

test("absent from a complete snapshot with no survivor → delete-edge → Edge removed", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm, rid } = await pairedBookmark(eng, mock, root, "1", "https://e.example/b");
  mock._raindrops.delete(item._id);
  await eng.reconcile.reconcile({ force: true });
  const jobs = await jobsOfKind(eng, "delete-edge");
  assert.deepEqual(
    jobs.map((j) => [j.raindropId, j.signal]),
    [[rid, "absent"]]
  );
  await eng.sync.drain();
  assert.equal(bookmarks.has(bm.id), false, "Edge bookmark removed");
  assert.equal(await eng.store.hasTombstone(rid), true);
  assert.equal(await eng.store.getPairRecord(rid), null);
});

test("absent but URL survives under another id → rebind, no delete", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm } = await pairedBookmark(eng, mock, root, "1", "https://e.example/c");
  const copy = mock._seedRich(root._id, { link: "https://e.example/c", title: "copy" });
  await mock.deleteRaindrop(item._id); // trashed duplicate (Sep 2026 shape)
  await eng.reconcile.reconcile({ force: true });
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0);
  assert.equal(await eng.store.getRaindropId(bm.id), String(copy._id), "rebound to survivor");
  assert.ok(
    (await eng.store.getLog()).some(
      (l) => l.message === "Rebound: https://e.example/c (Raindrop id changed)"
    )
  );
  assert.ok(bookmarks.has(bm.id));
});

test("presenceDeletesEnabled=false: absence never deletes, Trash still does", async () => {
  const { eng, mock, root } = await setupEngine({ config: { presenceDeletesEnabled: false } });
  const gone = await pairedBookmark(eng, mock, root, "1", "https://e.example/gone");
  const trashed = await pairedBookmark(eng, mock, root, "1", "https://e.example/trashed");
  mock._raindrops.delete(gone.item._id);
  await mock.deleteRaindrop(trashed.item._id);
  await eng.reconcile.reconcile({ force: true });
  const ids = (await jobsOfKind(eng, "delete-edge")).map((j) => j.raindropId);
  assert.deepEqual(ids, [trashed.rid]);
});

test("aged-out snapshot blocks absence deletes but not Trash deletes", async () => {
  const { eng, mock, root, presence } = await setupEngine();
  const gone = await pairedBookmark(eng, mock, root, "1", "https://e.example/aged-gone");
  const trashed = await pairedBookmark(eng, mock, root, "1", "https://e.example/aged-trash");
  mock._raindrops.delete(gone.item._id);
  await mock.deleteRaindrop(trashed.item._id);
  // A day-old snapshot that cannot be refreshed this wake.
  const snap = presence.buildSnapshot("id,url\n", { at: Date.now() - 25 * 3600_000 });
  await presence.savePresence({ ...snap, complete: true });
  mock.exportRaindropsCsv = async () => {
    throw new Error("export 503");
  };
  await eng.reconcile.reconcile({ force: true });
  const ids = (await jobsOfKind(eng, "delete-edge")).map((j) => j.raindropId);
  assert.deepEqual(ids, [trashed.rid], "only the Trash-listed pair is enqueued");
});

test("execution-time survival check: URL reappears under another id → rebind, bookmark kept", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm } = await pairedBookmark(eng, mock, root, "1", "https://e.example/late");
  mock._raindrops.delete(item._id);
  await eng.reconcile.reconcile({ force: true });
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 1);

  const reappeared = mock._seedRich(root._id, { link: "https://e.example/late", title: "late" });
  const exports = mock._calls.exportRaindropsCsv;
  await eng.sync.drain();
  assert.equal(mock._calls.exportRaindropsCsv - exports, 1, "drain re-checks on a later export");
  assert.ok(bookmarks.has(bm.id), "Edge bookmark kept");
  assert.equal(await eng.store.getRaindropId(bm.id), String(reappeared._id));
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0, "job dropped");
});

test("execution-time survival check: survivor paired to a dead bookmark → rebind, bookmark kept", async () => {
  const { eng, mock, root } = await setupEngine();
  const url = "https://e.example/occupied";
  const { item, bm } = await pairedBookmark(eng, mock, root, "1", url);
  mock._raindrops.delete(item._id);
  await eng.reconcile.reconcile({ force: true });
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 1);

  // The URL is live under another id whose pair points at a renumbered-away bookmark.
  const survivor = mock._seedRich(root._id, { link: url, title: "occupied" });
  await eng.store.recordSynced("999999", String(survivor._id), { url, title: "occupied" });
  await eng.sync.drain();
  assert.ok(bookmarks.has(bm.id), "Edge bookmark kept");
  assert.equal(await eng.store.getRaindropId(bm.id), String(survivor._id));
  assert.equal(await eng.store.getRaindropId("999999"), null, "dead occupant replaced");
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0, "job dropped");
});

test("execution-time check: raindrop restored from Trash → delete dropped", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm, rid } = await pairedBookmark(eng, mock, root, "1", "https://e.example/undo");
  await mock.deleteRaindrop(item._id);
  await eng.reconcile.reconcile({ force: true });
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 1);
  mock._raindrops.set(item._id, mock._trash.get(item._id)); // user restored it
  mock._trash.delete(item._id);
  await eng.sync.drain();
  assert.ok(bookmarks.has(bm.id));
  assert.equal(await eng.store.getBookmarkIdForRaindrop(rid), bm.id);
});

test("absence job is dropped at execution when the flag was turned off meanwhile", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm } = await pairedBookmark(eng, mock, root, "1", "https://e.example/flag");
  mock._raindrops.delete(item._id);
  await eng.reconcile.reconcile({ force: true });
  await eng.store.setConfig({ presenceDeletesEnabled: false });
  await eng.sync.drain();
  assert.ok(bookmarks.has(bm.id));
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0);
});

/* ---- Edge → Raindrop ---- */

test("removed with payload and no surviving copy → raindrop deleted, ledger cleared", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm, rid } = await pairedBookmark(eng, mock, root, "1", "https://e.example/del");
  await removeWithPayload(eng, bm);
  assert.equal(mock._raindrops.has(item._id), false, "raindrop soft-deleted");
  assert.equal(await eng.store.hasTombstone(rid), true);
  assert.deepEqual(await eng.store.getEdgeRemoved(), {}, "ledger entry removed");
});

test("removed without payload → no job, no ledger, pair kept", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm, rid } = await pairedBookmark(
    eng,
    mock,
    root,
    "1",
    "https://e.example/nopayload"
  );
  bookmarks.delete(String(bm.id));
  await eng.sync.handleBookmarkRemoved(bm.id, { parentId: bm.parentId });
  assert.equal((await jobsOfKind(eng, "delete-raindrop")).length, 0);
  assert.deepEqual(await eng.store.getEdgeRemoved(), {});
  assert.ok(mock._raindrops.has(item._id));
  assert.equal(await eng.store.getBookmarkIdForRaindrop(rid), bm.id, "left for stale-id rebind");
});

test("duplicate copy removed → pair rebinds to the remaining copy, no Raindrop delete", async () => {
  const { eng, mock, root } = await setupEngine();
  const folder = await edgeFolder("2", "Keep");
  const { item, bm, rid } = await pairedBookmark(eng, mock, root, "1", "https://e.example/dupe");
  const other = await edgeBookmark(folder.id, "dupe", "https://e.example/dupe");
  await removeWithPayload(eng, bm);
  assert.ok(mock._raindrops.has(item._id), "raindrop kept");
  assert.equal(await eng.store.getBookmarkIdForRaindrop(rid), other.id, "rebound to survivor");
  assert.equal(await eng.store.hasTombstone(rid), false);
  assert.deepEqual(await eng.store.getEdgeRemoved(), {});
});

test("copy in an excluded (unsynced) folder is not a survivor", async () => {
  const { eng, mock, root } = await setupEngine();
  const priv = await edgeFolder("2", "Private");
  const { POLICY } = eng.constants;
  await eng.store.setOverride(priv.id, POLICY.EXCLUDE, "Other favorites/Private");
  const { item, bm, rid } = await pairedBookmark(eng, mock, root, "1", "https://e.example/priv");
  await edgeBookmark(priv.id, "priv copy", "https://e.example/priv");
  await removeWithPayload(eng, bm);
  assert.equal(mock._raindrops.has(item._id), false, "raindrop deleted");
  assert.equal(await eng.store.hasTombstone(rid), true);
});

test("copy in the outside-root landing zone survives only while an allowlist is active", async () => {
  for (const allowlistActive of [true, false]) {
    const { eng, mock, root } = await setupEngine({
      config: { raindropFolderAllowlist: allowlistActive ? { 777: { path: "Elsewhere" } } : {} },
    });
    const landing = await edgeFolder("2", "Raindrop");
    const sub = await edgeFolder(landing.id, "Elsewhere");
    const { item, bm } = await pairedBookmark(eng, mock, root, "1", "https://e.example/landing");
    const copy = await edgeBookmark(sub.id, "landing copy", "https://e.example/landing");
    await removeWithPayload(eng, bm);
    if (allowlistActive) {
      assert.ok(mock._raindrops.has(item._id), "landing copy is a survivor");
      assert.equal(await eng.store.getBookmarkIdForRaindrop(String(item._id)), copy.id);
    } else {
      assert.equal(mock._raindrops.has(item._id), false, "no allowlist: not synced scope");
    }
  }
});

test("folder delete ledgers every paired child from the payload", async () => {
  const { eng, mock, root } = await setupEngine();
  const folder = await edgeFolder("1", "Batch");
  const a = await pairedBookmark(eng, mock, root, folder.id, "https://e.example/fa");
  const b = await pairedBookmark(eng, mock, root, folder.id, "https://e.example/fb");
  bookmarks.delete(a.bm.id);
  bookmarks.delete(b.bm.id);
  bookmarks.delete(folder.id);
  await eng.sync.handleBookmarkRemoved(folder.id, {
    parentId: "1",
    node: {
      id: folder.id,
      title: "Batch",
      children: [
        { id: a.bm.id, title: a.bm.title, url: a.bm.url, parentId: folder.id },
        { id: b.bm.id, title: b.bm.title, url: b.bm.url, parentId: folder.id },
      ],
    },
  });
  assert.equal(mock._raindrops.has(a.item._id), false);
  assert.equal(mock._raindrops.has(b.item._id), false);
});

test("completed reconcile stores pair health; Status exposes it", async () => {
  const { eng, mock, root } = await setupEngine();
  await pairedBookmark(eng, mock, root, "1", "https://e.example/h1");
  await eng.store.recordSynced("dead-bm", "31337", { url: "https://e.example/h2" });
  await eng.reconcile.reconcile({ force: true });
  const health = await eng.store.getPairHealth();
  assert.equal(health.pairs, 2);
  assert.equal(health.liveLive, 1);
  assert.equal(health.staleEdgeId, 1);
  assert.equal(health.complete, true);
});
