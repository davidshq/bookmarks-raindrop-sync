// Delete evidence (design D5; memo invariant 1): no delete in either
// direction without a positive signal and a failed survival check.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  setupEngine,
  edgeBookmark,
  edgeFolder,
  jobsOfKind,
  bookmarks,
  warmPresence,
} from "./helpers/engine.mjs";

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

test("delete-edge never removes an unrelated bookmark that now holds the pair's id", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm, rid } = await pairedBookmark(eng, mock, root, "1", "https://e.example/reused");
  // Renumber: the pair's id now belongs to a different bookmark.
  bookmarks.get(String(bm.id)).url = "https://unrelated.example/";
  mock._raindrops.delete(item._id);
  await eng.reconcile.reconcile({ force: true });
  await eng.sync.drain();
  assert.ok(bookmarks.has(String(bm.id)), "unrelated bookmark kept");
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0);
  assert.equal(await eng.store.getRaindropId(bm.id), null, "stale pair cleared");
  assert.equal(await eng.store.hasTombstone(rid), true);
});

test("upload claims a raindrop whose pair id was reused by another bookmark (no duplicate)", async () => {
  const { eng, mock, root } = await setupEngine();
  const url = "https://e.example/claim";
  const item = mock._seedRich(root._id, { link: url, title: "claim" });
  // Old pair points at id `other`, which now holds an unrelated bookmark.
  const other = await edgeBookmark("1", "unrelated", "https://unrelated.example/");
  await eng.store.recordSynced(other.id, String(item._id), { url, title: "claim" });
  await warmPresence(eng);

  const bm = await edgeBookmark("1", "claim", url);
  await eng.sync.handleBookmarkCreated(bm.id, bookmarks.get(String(bm.id)));
  await eng.sync.drain();
  assert.equal(await eng.store.getRaindropId(bm.id), String(item._id), "claimed, not duplicated");
  assert.equal(
    [...mock._raindrops.values()].filter((r) => r.link === url).length,
    1,
    "one raindrop for the URL"
  );
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

test("a tombstone newer than the snapshot is not pruned (offload after the export)", async () => {
  // Heartbeat reuses the snapshot until the interval passes.
  const { eng, mock, root } = await setupEngine({ config: { reconcileIntervalMinutes: 60 } });
  await warmPresence(eng);
  await new Promise((r) => setTimeout(r, 5));
  // Offloaded after the export began: absent from that snapshot, alive in Raindrop.
  const url = "https://e.example/offloaded";
  const item = mock._seedRich(root._id, { link: url, title: "offloaded" });
  await eng.store.addTombstone(String(item._id), "edge-offload");

  await eng.reconcile.reconcile({ force: false }); // heartbeat
  assert.equal((await eng.presence.loadPresence()).seq, 1, "heartbeat reused the snapshot");
  assert.equal(await eng.store.hasTombstone(String(item._id)), true, "tombstone kept");
  await eng.sync.drain();
  assert.equal(
    [...bookmarks.values()].some((b) => b.url === url),
    false,
    "offloaded raindrop not pulled back into Edge"
  );
});

test("persistent export failure: heartbeat lists again after capped presence-only wakes", async () => {
  const { eng, mock, root } = await setupEngine();
  const { PRESENCE_ONLY_MAX_TRIES } = eng.constants;
  mock.exportRaindropsCsv = async () => {
    throw new Error("export down");
  };
  const heartbeat = async () => {
    await eng.store.setReconcileState({ lastRunAt: 0 }); // interval elapsed
    return eng.reconcile.reconcile({ force: false });
  };
  await heartbeat();
  assert.equal((await eng.store.getReconcileState()).presencePending, true);

  mock._seedRich(root._id, { link: "https://e.example/new-while-down", title: "new" });
  const kinds = [];
  for (let i = 0; i <= PRESENCE_ONLY_MAX_TRIES; i++) {
    kinds.push((await heartbeat()).presenceOnly ? "presence" : "list");
  }
  assert.deepEqual(kinds, [...Array(PRESENCE_ONLY_MAX_TRIES).fill("presence"), "list"]);
  assert.ok(
    (await eng.queue.list()).some((j) => j.kind === "pull-create"),
    "new raindrop reaches the queue while exports fail"
  );
});

test("circuit breaker holds evidence-based Edge deletes past the limit", async () => {
  const { eng, mock, root } = await setupEngine();
  const { DELETE_BREAKER_MIN } = eng.constants;
  const HELD = 5;
  const paired = [];
  for (let i = 0; i < DELETE_BREAKER_MIN + HELD; i++) {
    paired.push(await pairedBookmark(eng, mock, root, "1", `https://e.example/breaker-${i}`));
  }
  for (const { item } of paired) mock._raindrops.delete(item._id); // gone from Raindrop
  await eng.reconcile.reconcile({ force: true });
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, DELETE_BREAKER_MIN + HELD);

  // Several wakes: the per-wake job cap must not be what stops the deletes.
  for (let n = 0; n < 6; n++) await eng.sync.drain();
  const removed = paired.filter(({ bm }) => !bookmarks.has(String(bm.id))).length;
  assert.equal(removed, DELETE_BREAKER_MIN, "stops at the limit");
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, HELD, "the rest stay queued");
  assert.equal((await eng.store.getDeleteBreaker()).tripped, true);
});

test("pull-update never rewrites an unrelated bookmark that now holds the pair's id", async () => {
  const { eng, mock, root } = await setupEngine();
  const { item, bm, rid } = await pairedBookmark(eng, mock, root, "1", "https://e.example/pu");
  // Renumber: the pair's id now belongs to a different bookmark.
  const node = bookmarks.get(String(bm.id));
  node.url = "https://unrelated.example/";
  node.title = "unrelated";
  await eng.queue.enqueueJob({
    id: `pu-${rid}`,
    kind: "pull-update",
    raindropId: rid,
    bookmarkId: String(bm.id),
    link: "https://e.example/pu-edited",
    title: "edited in Raindrop",
    relativeSegments: [],
    collectionId: String(item.collection?.$id ?? root._id),
  });
  await eng.sync.drain();
  assert.equal(bookmarks.get(String(bm.id)).url, "https://unrelated.example/", "URL untouched");
  assert.equal(bookmarks.get(String(bm.id)).title, "unrelated", "title untouched");
  assert.equal((await jobsOfKind(eng, "pull-update")).length, 0, "job dropped");
});
