#!/usr/bin/env node
/**
 * Isolated checklist verification for bidirectional sync, folder policies,
 * rate-limit / shared wake spendable / dead-letter paths, and export/queue
 * bulk-lane engine wiring (scenarios 6.2–7.7). Scenario 6.8 covers ordered
 * prefer-drain + leftover listing (including tick) and reentrancy `busy`.
 * Scenario 6.8d covers Pull now wait-and-resume through real reconcileNow.
 * Pure bulk heuristics / Match planner live in verify-bidirectional-logic.mjs.
 *
 * SAFETY:
 * - Edge bookmarks are 100% in-memory mocks — never touches the real Edge tree.
 * - Raindrop calls (if RAINDROP_TOKEN / .tmp/raindrop_token is set) only create and
 *   delete items under a disposable root collection named ERS-Verify-<timestamp>.
 * - Without a token, Raindrop is also mocked in-memory (still validates engine logic).
 * - Scenarios only create/assert ERS-Verify-* collections and example.com/ers-* URLs.
 *
 * Usage:
 *   node scripts/verify-checklist.mjs
 *   RAINDROP_TOKEN=… node scripts/verify-checklist.mjs --live
 */

import assert from "node:assert/strict";
import { RAINDROP_API } from "../src/lib/constants.js";
import { runPullNow } from "../src/lib/pull-now.js";
import {
  loadToken,
  importEngine,
  resetAll,
  patchClient,
  edgeUrls,
  findEdgeByUrl,
  bookmarks,
  storage,
} from "./lib/test-harness.mjs";

const LIVE = process.argv.includes("--live");
const TOKEN = loadToken();
const USE_LIVE = LIVE && !!TOKEN;

/* -------------------------------------------------------------------------- */
/* Optional live Raindrop client scoped to ERS-Verify-* only                  */
/* -------------------------------------------------------------------------- */

const API = RAINDROP_API;
const createdLive = { collections: [], raindrops: [] };
let verifyRootTitle = "";

async function liveCall(method, pathName, body) {
  const res = await fetch(`${API}${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${pathName} -> ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

async function liveCleanup() {
  for (const id of [...createdLive.raindrops].reverse()) {
    try {
      await liveCall("DELETE", `/raindrop/${id}`);
      await liveCall("DELETE", `/raindrop/${id}`); // permanent from trash
    } catch {
      /* ignore */
    }
  }
  for (const id of [...createdLive.collections].reverse()) {
    try {
      await liveCall("DELETE", `/collection/${id}`);
    } catch {
      /* ignore */
    }
  }
  createdLive.raindrops = [];
  createdLive.collections = [];
}

/* -------------------------------------------------------------------------- */
/* In-memory Raindrop mock (used when not --live)                             */
/* -------------------------------------------------------------------------- */

function makeMockRaindrop() {
  let seq = 1;
  const collections = new Map(); // id -> { _id, title, parent }
  const raindrops = new Map(); // id -> item
  const trash = new Map();
  /** @type {{ listRaindrops: number, createRaindrop: number, deleteRaindrop: number, exportRaindropsCsv: number, getRaindrop: number, updateRaindrop: number, searchRaindrops: number }} */
  const calls = {
    listRaindrops: 0,
    createRaindrop: 0,
    deleteRaindrop: 0,
    exportRaindropsCsv: 0,
    getRaindrop: 0,
    updateRaindrop: 0,
    searchRaindrops: 0,
  };

  return {
    async getUser() {
      return { _id: 1, fullName: "mock" };
    },
    async getRootCollections() {
      return [...collections.values()].filter((c) => !c.parent?.$id);
    },
    async getChildCollections() {
      return [...collections.values()].filter((c) => c.parent?.$id);
    },
    async createCollection(title, parentId) {
      const _id = seq++;
      const item = {
        _id,
        title,
        parent: parentId != null ? { $id: parentId } : null,
      };
      collections.set(_id, item);
      return item;
    },
    async createRaindrop({ link, title, collectionId }) {
      calls.createRaindrop++;
      const _id = seq++;
      const item = {
        _id,
        link,
        title: title || link,
        collection: { $id: collectionId },
        tags: [],
        note: "",
      };
      raindrops.set(_id, item);
      return item;
    },
    async listRaindrops(
      collectionId,
      { nested = false, page = 0, perPage = 50, search = undefined } = {}
    ) {
      calls.listRaindrops++;
      // Trash is a system collection — items live in `_trash`, not under a real parent.
      if (Number(collectionId) === -99) {
        const all = [...trash.values()];
        const start = page * perPage;
        const items = all.slice(start, start + perPage);
        return { items, count: all.length };
      }
      if (search != null && String(search).trim() !== "") {
        const q = String(search).toLowerCase();
        const all = [...raindrops.values()].filter(
          (r) =>
            String(r.link || "")
              .toLowerCase()
              .includes(q) ||
            String(r.title || "")
              .toLowerCase()
              .includes(q)
        );
        const start = page * perPage;
        return { items: all.slice(start, start + perPage), count: all.length };
      }
      const under = new Set();
      const walk = (id) => {
        under.add(Number(id));
        for (const c of collections.values()) {
          if (c.parent?.$id === Number(id) || String(c.parent?.$id) === String(id)) walk(c._id);
        }
      };
      if (nested) walk(collectionId);
      else under.add(Number(collectionId));
      const all = [...raindrops.values()].filter((r) => under.has(Number(r.collection?.$id)));
      const start = page * perPage;
      const items = all.slice(start, start + perPage);
      return { items, count: all.length };
    },
    async searchRaindrops(query, { perPage = 50 } = {}) {
      calls.searchRaindrops++;
      return this.listRaindrops(0, { page: 0, perPage, search: query });
    },
    async getRaindrop(id) {
      calls.getRaindrop++;
      // Live items only — trashed ids are "gone" for delete-detection confirms.
      return raindrops.get(Number(id)) || null;
    },
    async updateRaindrop(id, patch) {
      calls.updateRaindrop++;
      const item = raindrops.get(Number(id));
      if (!item) throw new Error(`Raindrop PUT /raindrop/${id} failed: 404`);
      if (patch.link != null) item.link = patch.link;
      if (patch.title != null) item.title = patch.title;
      if (patch.collectionId != null) item.collection = { $id: patch.collectionId };
      // intentionally never clear tags/note unless provided — engine won't send them
      return item;
    },
    async updateCollection(id, { title } = {}) {
      const item = collections.get(Number(id));
      if (!item) throw new Error(`Raindrop PUT /collection/${id} failed: 404`);
      if (title != null) item.title = title;
      return item;
    },
    async deleteRaindrop(id) {
      calls.deleteRaindrop++;
      const item = raindrops.get(Number(id));
      if (item) {
        raindrops.delete(Number(id));
        trash.set(Number(id), { ...item, collection: { $id: -99 } });
      }
    },
    async exportRaindropsCsv(collectionId = 0) {
      calls.exportRaindropsCsv++;
      void collectionId;
      return "id,url\n";
    },
    // test helpers
    _collections: collections,
    _raindrops: raindrops,
    _trash: trash,
    _calls: calls,
    _seedRich(collectionId, { link, title, tags, note }) {
      const _id = seq++;
      const item = {
        _id,
        link,
        title,
        collection: { $id: collectionId },
        tags: tags || [],
        note: note || "",
      };
      raindrops.set(_id, item);
      return item;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                  */
/* -------------------------------------------------------------------------- */

async function scenario62_oneWay() {
  console.log("\n== 6.2 One-way mode unchanged ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  await resetAll(eng.store);

  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-OneWay",
    syncMode: SYNC_MODE.ONE_WAY,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  // Create disposable Edge bookmark under Favorites bar
  const folder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Verify-Folder",
  });
  const bm = await chrome.bookmarks.create({
    parentId: folder.id,
    title: "ERS one-way",
    url: "https://example.com/ers-verify-oneway",
  });

  await eng.queue.enqueue(bm.id);
  await eng.sync.drain();

  assert.equal(mock._raindrops.size, 1, "uploaded to Raindrop");
  assert.ok(await eng.store.hasSynced(bm.id), "paired");
  assert.ok(findEdgeByUrl("https://example.com/ers-verify-oneway"), "edge kept (sync-and-keep)");

  // Bidirectional jobs must no-op / be dropped in one-way
  await eng.queue.enqueueJob({
    id: "pull-999",
    kind: JOB.PULL_CREATE,
    raindropId: "999",
    link: "https://example.com/should-not-pull",
    title: "nope",
    relativeSegments: ["Bookmarks bar", "ERS-Verify-Folder"],
  });
  await eng.sync.drain();
  assert.equal(
    edgeUrls().includes("https://example.com/should-not-pull"),
    false,
    "one-way does not pull"
  );

  const before = mock._raindrops.size;
  await eng.sync.handleBookmarkRemoved(bm.id, { parentId: folder.id });
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, before, "one-way does not propagate Edge delete");

  // Reconcile should be a no-op
  const r = await eng.reconcile.reconcile();
  assert.equal(r.enqueued, 0);
  console.log("  ✔ one-way upload works; no pull; no delete propagation");
}

async function scenario63_bidirectional() {
  console.log("\n== 6.3 Bidirectional pull + deletes + tombstone ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-Bi";
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const root = await mock.createCollection(rootName, null);
  const bar = await mock.createCollection("Bookmarks bar", root._id);
  const folder = await mock.createCollection("ERS-Verify-Folder", bar._id);

  // Raindrop-origin item → should pull into Edge
  const remote = mock._seedRich(folder._id, {
    link: "https://example.com/ers-verify-pull",
    title: "ERS pull me",
    tags: ["keep-me"],
    note: "rich-note",
  });

  await eng.reconcile.reconcile();
  await eng.sync.drain();
  const pulled = findEdgeByUrl("https://example.com/ers-verify-pull");
  assert.ok(pulled, "pulled into Edge");
  assert.equal(await eng.store.getBookmarkIdForRaindrop(String(remote._id)), pulled.id);

  // Edge user delete → Raindrop delete + tombstone
  await chrome.bookmarks.remove(pulled.id);
  await eng.sync.handleBookmarkRemoved(pulled.id, { parentId: pulled.parentId });
  await eng.sync.drain();
  assert.equal(mock._raindrops.has(remote._id), false, "raindrop deleted");
  assert.equal(mock._trash.has(remote._id), true, "moved to trash mock");
  assert.equal(await eng.store.hasTombstone(String(remote._id)), true, "tombstone set");

  // Resurrect attempt: put raindrop back in library; reconcile must NOT recreate
  mock._raindrops.set(remote._id, remote);
  mock._trash.delete(remote._id);
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-pull"),
    false,
    "tombstone blocks recreate"
  );

  // Stale pull-create already on the queue must also honor the tombstone
  const { JOB } = eng.constants;
  await eng.queue.enqueueJob({
    id: `pull-${remote._id}-stale`,
    kind: JOB.PULL_CREATE,
    raindropId: String(remote._id),
    link: "https://example.com/ers-verify-pull",
    title: "ERS pull me",
    relativeSegments: ["Bookmarks bar", "ERS-Verify-Folder"],
  });
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-pull"),
    false,
    "stale pull-create honors tombstone"
  );

  // Pending delete-raindrop cancels a competing pull-create
  const pendingRid = "pending-del-1";
  await eng.queue.enqueueJob({
    id: `pull-${pendingRid}`,
    kind: JOB.PULL_CREATE,
    raindropId: pendingRid,
    link: "https://example.com/ers-verify-pending-del",
    title: "should not pull",
    relativeSegments: ["Bookmarks bar", "ERS-Verify-Folder"],
  });
  await eng.queue.enqueueJob({
    id: `dr-${pendingRid}`,
    kind: JOB.DELETE_RAINDROP,
    raindropId: pendingRid,
    bookmarkId: "gone",
  });
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-pending-del"),
    false,
    "pending delete blocks pull-create"
  );
  assert.equal(await eng.store.hasTombstone(pendingRid), true, "delete job still ran");

  // Fresh pair for remote-delete → Edge delete
  await eng.store.clearTombstone(String(remote._id));
  const remote2 = mock._seedRich(folder._id, {
    link: "https://example.com/ers-verify-remote-del",
    title: "ERS remote del",
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  const edge2 = findEdgeByUrl("https://example.com/ers-verify-remote-del");
  assert.ok(edge2, "second pull");

  await mock.deleteRaindrop(remote2._id);
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.equal(!!findEdgeByUrl("https://example.com/ers-verify-remote-del"), false, "Edge deleted");
  assert.equal(await eng.store.hasTombstone(String(remote2._id)), true);

  // Folder delete: Chromium fires once for the folder with node tree — children
  // must still propagate Raindrop deletes (no per-child onRemoved).
  const edgeFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Verify-Folder-Del",
  });
  const edgeSub = await chrome.bookmarks.create({
    parentId: edgeFolder.id,
    title: "Nested",
  });
  const childA = await chrome.bookmarks.create({
    parentId: edgeSub.id,
    title: "folder-del-a",
    url: "https://example.com/ers-verify-folder-del-a",
  });
  const childB = await chrome.bookmarks.create({
    parentId: edgeFolder.id,
    title: "folder-del-b",
    url: "https://example.com/ers-verify-folder-del-b",
  });
  await eng.queue.enqueueMany([childA.id, childB.id]);
  await eng.sync.drain();
  const ridA = await eng.store.getRaindropId(childA.id);
  const ridB = await eng.store.getRaindropId(childB.id);
  assert.ok(ridA && ridB, "both children paired before folder delete");

  const folderNode = {
    id: edgeFolder.id,
    title: edgeFolder.title,
    children: [
      {
        id: edgeSub.id,
        title: "Nested",
        children: [
          {
            id: childA.id,
            title: childA.title,
            url: childA.url,
            parentId: edgeSub.id,
          },
        ],
      },
      {
        id: childB.id,
        title: childB.title,
        url: childB.url,
        parentId: edgeFolder.id,
      },
    ],
  };
  await eng.sync.handleBookmarkRemoved(edgeFolder.id, {
    parentId: "1",
    node: folderNode,
  });
  await eng.sync.drain();
  assert.equal(mock._raindrops.has(Number(ridA)), false, "child A raindrop deleted");
  assert.equal(mock._raindrops.has(Number(ridB)), false, "child B raindrop deleted");
  assert.equal(await eng.store.hasTombstone(String(ridA)), true, "child A tombstoned");
  assert.equal(await eng.store.hasTombstone(String(ridB)), true, "child B tombstoned");

  console.log("  ✔ pull, deletes, tombstone, stale/pending pull guards, folder delete");
}

async function scenario64_syncAndDelete() {
  console.log("\n== 6.4 sync-and-delete in bidirectional leaves Raindrop + tags ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-SAD";
  // Global default must stay keep-both in bidirectional; offload via folder override.
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_DELETE, // coerced to SYNC_KEEP on write
  });
  const cfg = await eng.store.getConfig();
  assert.equal(cfg.defaultPolicy, POLICY.SYNC_KEEP, "bidirectional coerces global keep-both");

  // Pre-create root so upload path works
  await mock.createCollection(rootName, null);

  const folder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Verify-SAD-Folder",
  });
  await eng.store.setOverride(
    folder.id,
    POLICY.SYNC_DELETE,
    "Favorites bar / ERS-Verify-SAD-Folder"
  );
  const bm = await chrome.bookmarks.create({
    parentId: folder.id,
    title: "ERS sad",
    url: "https://example.com/ers-verify-sad",
  });

  await eng.queue.enqueue(bm.id);
  await eng.sync.drain();

  assert.equal(mock._raindrops.size, 1, "raindrop exists");
  const only = [...mock._raindrops.values()][0];
  // Simulate user enriching in Raindrop after create
  only.tags = ["user-tag"];
  only.note = "user-note";

  assert.equal(!!findEdgeByUrl("https://example.com/ers-verify-sad"), false, "Edge removed");
  assert.equal(await eng.store.getRaindropId(bm.id), null, "pair cleared after offload");
  assert.equal(
    await eng.store.getBookmarkIdForRaindrop(String(only._id)),
    null,
    "reverse pair cleared after offload"
  );
  assert.equal(
    await eng.store.hasTombstone(String(only._id)),
    true,
    "offload tombstone blocks re-pull"
  );
  // Policy remove must not delete Raindrop
  assert.equal(only.tags[0], "user-tag");
  assert.equal(only.note, "user-note");
  assert.equal(mock._trash.size, 0, "not trashed by policy delete");

  // Bidirectional reconcile must not bring the offloaded item back
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-sad"),
    false,
    "tombstone blocks re-pull after offload"
  );

  // Stale storage: raw sync-and-delete under bidirectional is normalized in
  // memory on read, and persisted only by healStoredConfig (worker startup).
  await chrome.storage.local.set({
    config: {
      token: "mock",
      rootName,
      syncMode: SYNC_MODE.BIDIRECTIONAL,
      defaultPolicy: POLICY.SYNC_DELETE,
      pruneEmpty: false,
    },
  });
  const viewed = await eng.store.getConfig();
  assert.equal(
    viewed.defaultPolicy,
    POLICY.SYNC_KEEP,
    "getConfig normalizes stale offload in memory"
  );
  const raw = await chrome.storage.local.get("config");
  assert.equal(raw.config.defaultPolicy, POLICY.SYNC_DELETE, "getConfig does not write");
  await eng.store.healStoredConfig();
  const healed = await chrome.storage.local.get("config");
  assert.equal(healed.config.defaultPolicy, POLICY.SYNC_KEEP, "startup heal persists keep-both");

  console.log("  ✔ Edge gone via folder offload; Raindrop kept; pair cleared + tombstone");
}

async function scenario65_exclude() {
  console.log("\n== 6.5 exclude blocks upload, ingest, delete propagation ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-Ex";
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const excl = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Verify-Exclude",
  });
  await eng.store.setOverride(excl.id, POLICY.EXCLUDE, "Favorites bar / ERS-Verify-Exclude");

  const bm = await chrome.bookmarks.create({
    parentId: excl.id,
    title: "secret",
    url: "https://example.com/ers-verify-exclude",
  });
  await eng.queue.enqueue(bm.id);
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, 0, "exclude not uploaded");

  const root = await mock.createCollection(rootName, null);
  const bar = await mock.createCollection("Bookmarks bar", root._id);
  const remoteFolder = await mock.createCollection("ERS-Verify-Exclude", bar._id);
  mock._seedRich(remoteFolder._id, {
    link: "https://example.com/ers-verify-exclude-remote",
    title: "should not ingest",
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-exclude-remote"),
    false,
    "exclude path not ingested"
  );

  // Even if somehow paired, delete under exclude shouldn't be the normal path;
  // engine relies on exclude never uploading — verify remove of unpaired does nothing.
  const before = mock._raindrops.size;
  await chrome.bookmarks.remove(bm.id);
  await eng.sync.handleBookmarkRemoved(bm.id, { parentId: excl.id });
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, before, "no raindrop delete for unpaired exclude bookmark");

  // Synced first, then folder marked exclude — delete must not propagate.
  const keepFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Verify-WasKeep",
  });
  const laterExcl = await chrome.bookmarks.create({
    parentId: keepFolder.id,
    title: "ERS-Verify-LaterExclude",
    url: "https://example.com/ers-verify-later-exclude",
  });
  await eng.queue.enqueue(laterExcl.id);
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, before + 1, "uploaded before exclude");
  await eng.store.setOverride(keepFolder.id, POLICY.EXCLUDE, "Favorites bar / ERS-Verify-WasKeep");
  const rid = await eng.store.getRaindropId(laterExcl.id);
  assert.ok(rid);
  await chrome.bookmarks.remove(laterExcl.id);
  await eng.sync.handleBookmarkRemoved(laterExcl.id, { parentId: keepFolder.id });
  await eng.sync.drain();
  assert.equal(
    mock._raindrops.has(Number(rid)),
    true,
    "mapped exclude delete does not hit Raindrop"
  );

  // Synced, then exclude — remote Raindrop delete must not remove Edge.
  const keepRemote = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Verify-WasKeep-Remote",
  });
  const laterExclRemote = await chrome.bookmarks.create({
    parentId: keepRemote.id,
    title: "ERS-Verify-LaterExclude-Remote",
    url: "https://example.com/ers-verify-later-exclude-remote",
  });
  await eng.queue.enqueue(laterExclRemote.id);
  await eng.sync.drain();
  const ridRemote = await eng.store.getRaindropId(laterExclRemote.id);
  assert.ok(ridRemote, "paired before exclude");
  await eng.store.setOverride(
    keepRemote.id,
    POLICY.EXCLUDE,
    "Favorites bar / ERS-Verify-WasKeep-Remote"
  );
  await mock.deleteRaindrop(Number(ridRemote));
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-later-exclude-remote"),
    "excluded Edge bookmark kept after remote Raindrop delete"
  );
  assert.equal(
    await eng.store.getRaindropId(laterExclRemote.id),
    null,
    "pair cleared so DELETE_EDGE does not thrash"
  );
  assert.equal(
    await eng.store.hasTombstone(String(ridRemote)),
    true,
    "tombstone recorded for absent raindrop"
  );

  console.log(
    "  ✔ exclude blocks upload + ingest; Edge↔Raindrop deletes do not propagate either way"
  );
}

async function scenario66_raindropFolderModes() {
  console.log("\n== 6.6 Raindrop → Edge folder modes ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, RAINDROP_FOLDER_MODE, JOB } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-Folders";
  const root = await mock.createCollection(rootName, null);
  const research = await mock.createCollection("Research", root._id);
  const papers = await mock.createCollection("Papers", research._id);
  // Empty sibling collection — only mirror-all should create it in Edge.
  await mock.createCollection("Inbox", research._id);

  mock._seedRich(papers._id, {
    link: "https://example.com/ers-verify-papers",
    title: "ERS papers",
  });

  // --- existing-only: missing path → skip (no catch-all, no folders) ---
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-papers"),
    false,
    "existing-only skips missing path"
  );
  assert.equal(
    [...bookmarks.values()].some((n) => !n.url && n.title === "Research"),
    false,
    "existing-only creates no Research folder"
  );
  assert.equal(
    [...bookmarks.values()].some((n) => !n.url && n.title === "_Unfiled"),
    false,
    "no catch-all / _Unfiled"
  );

  // Stale pull job still dropped at drain without creating folders
  await eng.queue.enqueueJob({
    id: "pull-stale-existing",
    kind: JOB.PULL_CREATE,
    raindropId: "stale-ex",
    link: "https://example.com/ers-verify-stale-existing",
    title: "stale",
    relativeSegments: ["Research", "Papers"],
  });
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-stale-existing"),
    false,
    "drain existing-only drops incomplete path"
  );

  // --- create-as-needed: folders + bookmark; empty Inbox still absent ---
  await resetAll(eng.store);
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
  });
  // Mock Raindrop tree from earlier in this scenario is reused.
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  const pulled = findEdgeByUrl("https://example.com/ers-verify-papers");
  assert.ok(pulled, "create-as-needed pulled bookmark");
  assert.ok(
    [...bookmarks.values()].some((n) => !n.url && n.title === "Research"),
    "create-as-needed created Research"
  );
  assert.ok(
    [...bookmarks.values()].some((n) => !n.url && n.title === "Papers"),
    "create-as-needed created Papers"
  );
  assert.equal(
    [...bookmarks.values()].some((n) => !n.url && n.title === "Inbox"),
    false,
    "create-as-needed does not mirror empty Inbox"
  );

  // --- mirror-all: empty Inbox folder appears ---
  await resetAll(eng.store);
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.MIRROR_ALL,
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.ok(findEdgeByUrl("https://example.com/ers-verify-papers"), "mirror-all still pulls");
  assert.ok(
    [...bookmarks.values()].some((n) => !n.url && n.title === "Inbox"),
    "mirror-all ensures empty Inbox folder"
  );

  console.log("  ✔ existing-only skip; create-as-needed; mirror-all empty folders");
}

async function scenario67_raindropFolderAllowlist() {
  console.log("\n== 6.7 Raindrop folder allowlist ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, RAINDROP_FOLDER_MODE } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-Allowlist";
  const root = await mock.createCollection(rootName, null);
  const research = await mock.createCollection("Research", root._id);
  const papers = await mock.createCollection("Papers", research._id);
  await mock.createCollection("Inbox", research._id);
  const other = await mock.createCollection("Other", root._id);

  mock._seedRich(papers._id, {
    link: "https://example.com/ers-verify-allow-papers",
    title: "ERS allow papers",
  });
  mock._seedRich(other._id, {
    link: "https://example.com/ers-verify-allow-other",
    title: "ERS allow other",
  });

  // Non-empty allowlist: only Research (covers Papers); Other skipped; Inbox ensured.
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    raindropFolderAllowlist: {
      [String(research._id)]: { path: "Research" },
    },
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();

  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-allow-papers"),
    "allowlisted subtree pulls"
  );
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-allow-other"),
    false,
    "unchecked Raindrop-only skipped"
  );
  assert.ok(
    [...bookmarks.values()].some((n) => !n.url && n.title === "Inbox"),
    "allowlist ensures empty Inbox under Research"
  );
  assert.equal(
    [...bookmarks.values()].some((n) => !n.url && n.title === "Other"),
    false,
    "unchecked empty Other not created"
  );

  // Edge-existing bypass: put Other on Edge, keep allowlist without Other.
  await resetAll(eng.store);
  const otherRoot = await chrome.bookmarks.create({
    parentId: "2",
    title: rootName,
  });
  await chrome.bookmarks.create({
    parentId: otherRoot.id,
    title: "Other",
  });

  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
    raindropFolderAllowlist: {
      [String(research._id)]: { path: "Research" },
    },
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-allow-other"),
    "Edge-existing bypasses allowlist"
  );
  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-allow-papers"),
    "allowlisted still pulls under existing-only"
  );

  // Empty allowlist preserves create-as-needed (Other path missing → still creates).
  await resetAll(eng.store);
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    raindropFolderAllowlist: {},
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-allow-other"),
    "empty allowlist leaves create-as-needed unchanged"
  );

  // Prune: missing Raindrop ids drop; fully mirrored allowlist ids stay
  // (Clear selection exits selective mode — reconcile must not undo opt-in).
  await resetAll(eng.store);
  const folderRoot = await chrome.bookmarks.create({
    parentId: "2",
    title: rootName,
  });
  const researchEdge = await chrome.bookmarks.create({
    parentId: folderRoot.id,
    title: "Research",
  });
  await chrome.bookmarks.create({ parentId: researchEdge.id, title: "Papers" });
  await chrome.bookmarks.create({ parentId: researchEdge.id, title: "Inbox" });
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    raindropFolderAllowlist: {
      [String(research._id)]: { path: "Research" },
      99999: { path: "Deleted" },
    },
  });
  await eng.reconcile.reconcile();
  const afterPrune = await eng.store.getConfig();
  assert.deepEqual(
    afterPrune.raindropFolderAllowlist,
    { [String(research._id)]: { path: "Research" } },
    "reconcile keeps live allowlist ids; drops missing only"
  );
  // Selective mode still active: Other (unchecked) must not pull.
  await eng.sync.drain();
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-allow-other"),
    false,
    "after prune of missing ids, selective mode still skips unchecked"
  );

  // Legacy pull job without collectionId still resolves under allowlist.
  await resetAll(eng.store);
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
    raindropFolderAllowlist: {
      [String(research._id)]: { path: "Research" },
    },
  });
  const { JOB } = eng.constants;
  await eng.queue.enqueueJob({
    id: "pull-legacy-no-col",
    kind: JOB.PULL_CREATE,
    raindropId: "legacy-col",
    link: "https://example.com/ers-verify-legacy-col",
    title: "legacy",
    relativeSegments: ["Research", "Papers"],
    // intentionally no collectionId
  });
  await eng.sync.drain();
  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-legacy-col"),
    "legacy pull resolves collectionId from path"
  );

  // Outside-root allowlist: pull once, second reconcile must not DELETE_EDGE.
  await resetAll(eng.store);
  const indie = await mock.createCollection("IndieOutside", null);
  const indieItem = mock._seedRich(indie._id, {
    link: "https://example.com/ers-verify-indie-outside",
    title: "ERS indie outside",
  });
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
    raindropFolderAllowlist: {
      [String(indie._id)]: { path: "IndieOutside" },
    },
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  const pulledIndie = findEdgeByUrl("https://example.com/ers-verify-indie-outside");
  assert.ok(pulledIndie, "outside-root allowlisted pulls");
  const indieFolder = [...bookmarks.values()].find((n) => !n.url && n.title === "IndieOutside");
  assert.ok(indieFolder, "outside-root IndieOutside folder created");
  const raindropContainer = bookmarks.get(String(indieFolder.parentId));
  assert.equal(
    raindropContainer?.title,
    "Raindrop",
    "outside-root folder under Other favorites / Raindrop"
  );
  assert.equal(raindropContainer?.parentId, "2", "Raindrop container lives under Other favorites");
  // Second reconcile: still present in Raindrop, must not queue Edge delete.
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-indie-outside"),
    "outside-root pair survives second reconcile (no false delete)"
  );
  const pairs = await eng.store.getPairs();
  assert.ok(pairs.byRaindrop[String(indieItem._id)], "pair still mapped after second reconcile");

  // Drop into Other favorites / Raindrop / IndieOutside → original outside-root collection.
  const dropped = await chrome.bookmarks.create({
    parentId: indieFolder.id,
    title: "ERS drop into outside-root",
    url: "https://example.com/ers-verify-indie-drop",
  });
  await eng.queue.enqueue(dropped.id);
  await eng.sync.drain();
  const droppedRain = [...mock._raindrops.values()].find(
    (r) => r.link === "https://example.com/ers-verify-indie-drop"
  );
  assert.ok(droppedRain, "drop under Raindrop/ uploads to Raindrop");
  assert.equal(
    Number(droppedRain.collection?.$id),
    Number(indie._id),
    "drop lands in original outside-root collection (not Edge/Other favorites/Raindrop/…)"
  );

  // Clear allowlist: outside-root pair must still survive; confirm parks it.
  await eng.store.setConfig({
    raindropFolderAllowlist: {},
  });
  await eng.reconcile.reconcile();
  await eng.sync.drain();
  assert.ok(
    findEdgeByUrl("https://example.com/ers-verify-indie-outside"),
    "outside-root pair survives Clear selection / empty allowlist"
  );
  assert.ok(
    (await eng.store.getPairs()).byRaindrop[String(indieItem._id)],
    "pair still mapped after clearing allowlist"
  );
  const parkedAfterClear = await eng.store.getParkedAliveIds();
  assert.ok(
    parkedAfterClear.has(String(indieItem._id)),
    "cleared-allowlist outside-root alive is parked"
  );

  console.log(
    "  ✔ allowlist skip/allow/empty-folder/Edge-bypass/empty-preserves-mode/prune/legacy/outside-root/upload-roundtrip/clear/park"
  );
}

async function scenario68_rateLimitBudget() {
  console.log("\n== 6.8 Rate-limit gate + spendable delete-confirm GETs ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB, MAX_ALIVE_CHECKS_PER_TICK } = eng.constants;
  await resetAll(eng.store);

  const mock = makeMockRaindrop();
  let getRaindropCalls = 0;
  const origGet = mock.getRaindrop.bind(mock);
  mock.getRaindrop = async (id) => {
    getRaindropCalls++;
    return origGet(id);
  };
  patchClient(eng.raindropMod, mock);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-Rate",
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  // Global pause must skip reconcile/drain API work.
  await eng.store.noteRateLimitedUntil(Date.now() + 60_000);
  const skipped = await eng.reconcile.reconcile();
  assert.equal(skipped.skipped, true, "reconcile skips while rate-limited");
  assert.equal(skipped.reason, "rate_limited", "skip reason is rate_limited");
  assert.equal(mock._collections.size, 0, "no collection fetch while gated");
  await eng.store.clearRateLimit();

  // Create root + many pairs that are NOT in the Raindrop listing → delete confirms.
  const root = await mock.createCollection("ERS-Verify-Rate", null);
  const orphans = MAX_ALIVE_CHECKS_PER_TICK + 5;
  for (let i = 0; i < orphans; i++) {
    const rid = 9000 + i;
    mock._raindrops.set(rid, {
      _id: rid,
      link: `https://example.com/ers-orphan-${i}`,
      title: `orphan-${i}`,
      collection: { $id: root._id },
    });
    // Pair exists, then remove from Raindrop so confirm path runs.
    await eng.store.recordSynced(`bm-orphan-${i}`, String(rid));
    mock._raindrops.delete(rid);
  }

  getRaindropCalls = 0;
  await eng.reconcile.reconcile();
  assert.equal(
    getRaindropCalls,
    MAX_ALIVE_CHECKS_PER_TICK,
    `alive checks exactly capped (got ${getRaindropCalls})`
  );
  let deleteJobs = (await eng.queue.list()).filter((j) => j.kind === JOB.DELETE_EDGE);
  assert.equal(
    deleteJobs.length,
    MAX_ALIVE_CHECKS_PER_TICK,
    "only confirmed-gone pairs enqueue deletes this tick"
  );
  const pairs = await eng.store.getPairs();
  assert.equal(
    Object.keys(pairs.byRaindrop).length,
    orphans,
    "pairs uncleared until DELETE_EDGE drains (no stampede side effects)"
  );
  const offsetAfter = (await eng.store.getReconcileState()).aliveConfirmOffset;
  assert.equal(
    offsetAfter,
    MAX_ALIVE_CHECKS_PER_TICK % orphans,
    "aliveConfirmOffset advances past the first window"
  );

  // Second cycle rotates — remaining orphans get delete jobs (cap may wrap).
  getRaindropCalls = 0;
  await eng.reconcile.reconcile();
  assert.ok(
    getRaindropCalls > 0 && getRaindropCalls <= MAX_ALIVE_CHECKS_PER_TICK,
    `second cycle still capped (got ${getRaindropCalls})`
  );
  deleteJobs = (await eng.queue.list()).filter((j) => j.kind === JOB.DELETE_EDGE);
  assert.equal(deleteJobs.length, orphans, "all orphans eventually queued across cycles");

  // 429 during drain sets global pause + defers due jobs.
  await eng.store.clearRateLimit();
  await eng.queue.clear(); // drop confirm delete-edge backlog so the upload is reached
  const folder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Rate-Folder",
  });
  const bm = await chrome.bookmarks.create({
    parentId: folder.id,
    title: "rate-limit-me",
    url: "https://example.com/ers-rate-limit-upload",
  });
  await eng.queue.enqueue(bm.id);
  const Proto = eng.raindropMod.RaindropClient.prototype;
  const prevCreate = Proto.createRaindrop;
  Proto.createRaindrop = async () => {
    throw new eng.raindropMod.RateLimitError(Date.now() + 30_000);
  };
  await eng.sync.drain();
  Proto.createRaindrop = prevCreate;
  assert.equal(await eng.store.isRateLimited(), true, "429 sets global rate-limit pause");
  const due = await eng.queue.due(Date.now());
  assert.equal(due.length, 0, "due jobs deferred past the pause");

  // Heartbeat cooldown: after a *settled* finish, force:false skips re-listing.
  await eng.store.clearRateLimit();
  await eng.queue.clear(); // leftover deferred upload must not look like traffic-busy
  await eng.store.setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: null,
    running: false,
    lastRunAt: Date.now(),
    lastSettledAt: Date.now(),
    unsettledConfirmCatchUp: false,
    lastError: null,
  });
  const cooled = await eng.reconcile.reconcile({ force: false });
  assert.equal(cooled.skipped, true, "heartbeat cooldown skips idle re-scan");
  assert.equal(cooled.reason, "cooldown", "skip reason is cooldown");
  const forced = await eng.reconcile.reconcile({ force: true });
  assert.notEqual(forced.skipped, true, "manual reconcile bypasses cooldown");

  // Unsettled confirm catch-up: no cooldown; with seenAcc → confirm-only (no re-list).
  await eng.queue.clear(); // forced reconcile may have re-queued delete-edge work
  await eng.store.setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: ["keep-presence"],
    running: false,
    lastRunAt: Date.now(),
    lastSettledAt: Date.now(),
    unsettledConfirmCatchUp: true,
    lastError: null,
  });
  let listCalls = 0;
  const prevList = Proto.listRaindrops;
  Proto.listRaindrops = async function (collectionId, ...args) {
    // Trash peek (-99) is allowed on confirm-only; nested root list is not.
    if (collectionId !== -99) listCalls++;
    return prevList.apply(this, [collectionId, ...args]);
  };
  const catchUp = await eng.reconcile.reconcile({ force: false });
  Proto.listRaindrops = prevList;
  assert.notEqual(catchUp.reason, "cooldown", "unsettled catch-up skips cooldown");
  assert.notEqual(catchUp.skipped, true, "unsettled catch-up runs");
  assert.equal(catchUp.confirmCatchUp, true, "unsettled + seenAcc is confirm-only");
  assert.equal(listCalls, 0, "confirm-only does not nested-list the sync root");

  // Unsettled without a presence snapshot still starts a listing rebuild.
  await eng.queue.clear();
  await eng.store.setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: null,
    running: false,
    lastRunAt: Date.now(),
    lastSettledAt: Date.now(),
    unsettledConfirmCatchUp: true,
    lastError: null,
  });
  const catchUpList = await eng.reconcile.reconcile({ force: false });
  assert.notEqual(catchUpList.reason, "cooldown", "unsettled without seenAcc skips cooldown");
  assert.notEqual(catchUpList.skipped, true, "unsettled without seenAcc starts listing");
  assert.notEqual(catchUpList.confirmCatchUp, true, "missing snapshot is not confirm-only");

  // Adaptive: quiet install honors a short configured interval.
  await eng.queue.clear();
  await eng.store.setConfig({ reconcileIntervalMinutes: 1 });
  await eng.store.setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: null,
    running: false,
    lastRunAt: Date.now() - 90_000,
    lastSettledAt: Date.now() - 90_000,
    unsettledConfirmCatchUp: false,
    lastError: null,
  });
  const quiet = await eng.reconcile.reconcile({ force: false });
  assert.notEqual(quiet.skipped, true, "quiet + short interval starts a new listing");

  // Ordered share: queued Raindrop-bound job does not hard-skip new listing.
  await eng.queue.enqueue(bm.id);
  await eng.store.setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: null,
    running: false,
    lastRunAt: Date.now() - 90_000,
    lastSettledAt: Date.now() - 90_000,
    unsettledConfirmCatchUp: false,
    lastError: null,
  });
  const queuedShare = await eng.reconcile.reconcile({ force: false });
  assert.notEqual(queuedShare.skipped, true, "queued upload does not hard-skip listing");
  assert.notEqual(queuedShare.reason, "busy", "queue contention is not busy");
  await eng.queue.clear();

  // Exhausted wake budget: new cycle must not burn collection-index GETs.
  const emptyBudget = new eng.wakeBudget.WakeBudget({
    mode: "full",
    headerRemaining: 100,
    headerResetAt: Date.now() + 60_000,
    wakeCapReqs: 1,
  });
  emptyBudget.noteRequest({ remaining: 99, resetAt: Date.now() + 60_000 });
  assert.equal(emptyBudget.allowance(), 0, "fixture budget is empty");
  await eng.store.setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: null,
    running: false,
    lastRunAt: Date.now() - 90_000,
    lastSettledAt: Date.now() - 90_000,
    unsettledConfirmCatchUp: false,
    lastError: null,
  });
  let rootFetches = 0;
  const prevRootCount = Proto.getRootCollections;
  Proto.getRootCollections = async function (...args) {
    rootFetches++;
    return prevRootCount.apply(this, args);
  };
  const noLeftover = await eng.reconcile.reconcile({ force: false, budget: emptyBudget });
  Proto.getRootCollections = prevRootCount;
  assert.equal(rootFetches, 0, "empty leftover budget skips collection index");
  assert.notEqual(noLeftover.skipped, true, "budget empty is not a Status skip reason");
  assert.equal(noLeftover.enqueued, 0, "no work enqueued without leftover budget");

  // In-progress cursor continues even with queue work present.
  await eng.queue.enqueue(bm.id);
  await eng.store.setReconcileState({
    cursorPage: 1,
    outsideCursor: null,
    seenAcc: ["1"],
    running: false,
    lastRunAt: Date.now() - 90_000,
    lastSettledAt: Date.now() - 90_000,
    unsettledConfirmCatchUp: false,
    lastError: null,
  });
  const midCycle = await eng.reconcile.reconcile({ force: false });
  assert.notEqual(midCycle.reason, "busy", "in-progress cursor is not busy-skipped");
  assert.notEqual(midCycle.skipped, true, "in-progress cursor continues listing");
  await eng.queue.clear();

  // Helper still reports Raindrop-bound queue work (no longer a reconcile busy gate).
  await eng.queue.enqueue(bm.id);
  assert.equal(
    await eng.reconcile.hasRaindropBoundQueueWork(),
    true,
    "hasRaindropBoundQueueWork sees upload jobs"
  );
  await eng.queue.clear();
  assert.equal(
    await eng.reconcile.hasRaindropBoundQueueWork(),
    false,
    "hasRaindropBoundQueueWork false when empty"
  );

  // Reentrancy: overlapping reconcile returns busy (not queue contention).
  let releaseRoots;
  const rootsGate = new Promise((resolve) => {
    releaseRoots = resolve;
  });
  let enteredRoots = false;
  Proto.getRootCollections = async function (...args) {
    enteredRoots = true;
    await rootsGate;
    return prevRootCount.apply(this, args);
  };
  const firstReconcile = eng.reconcile.reconcile({ force: true });
  for (let i = 0; i < 40 && !enteredRoots; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(enteredRoots, true, "first reconcile reached collection index");
  const overlapped = await eng.reconcile.reconcile({ force: true });
  assert.equal(overlapped.skipped, true, "overlapping reconcile is skipped");
  assert.equal(overlapped.reason, "busy", "busy means in-process reentrancy");
  releaseRoots();
  await firstReconcile;
  Proto.getRootCollections = prevRootCount;

  // Heartbeat tick: prefer-drain clears a queued upload, then leftover spendable lists.
  await eng.queue.clear();
  await eng.store.clearRateLimit();
  await eng.store.setConfig({ reconcileIntervalMinutes: 1 });
  await eng.store.setReconcileState({
    cursorPage: 0,
    outsideCursor: null,
    seenAcc: null,
    running: false,
    lastRunAt: Date.now() - 90_000,
    lastSettledAt: Date.now() - 90_000,
    unsettledConfirmCatchUp: false,
    lastError: null,
  });
  const tickBm = await chrome.bookmarks.create({
    parentId: "1",
    title: "ers-tick-prefer-drain",
    url: "https://example.com/ers-tick-prefer-drain",
  });
  await eng.queue.enqueue(tickBm.id);
  const listBeforeTick = mock._calls.listRaindrops;
  const createBeforeTick = mock._calls.createRaindrop;
  await eng.sync.tick();
  assert.ok(
    mock._calls.createRaindrop > createBeforeTick,
    "tick prefer-drain uploads the queued bookmark"
  );
  const stillQueued = (await eng.queue.list()).some(
    (j) => j.id === tickBm.id && eng.queue.jobKind(j) === JOB.UPLOAD
  );
  assert.equal(stillQueued, false, "tick prefer-drain cleared the upload job");
  assert.ok(
    mock._calls.listRaindrops > listBeforeTick,
    "tick leftover spendable still runs Trash/list after drain"
  );
  assert.notEqual(
    (await eng.store.getStatus()).reconcileSkipReason,
    "busy",
    "tick with prior queue work does not stamp queue-contention busy"
  );

  // Manual reconcileNow must set the global gate on RateLimitError (not only fail the UI).
  await eng.store.clearRateLimit();
  const prevRoot = Proto.getRootCollections;
  Proto.getRootCollections = async () => {
    throw new eng.raindropMod.RateLimitError(Date.now() + 45_000);
  };
  const manual = await eng.sync.reconcileNow();
  Proto.getRootCollections = prevRoot;
  assert.equal(manual.skipped, true, "reconcileNow returns skipped on 429");
  assert.equal(manual.reason, "rate_limited", "reconcileNow skip reason is rate_limited");
  assert.equal(await eng.store.isRateLimited(), true, "reconcileNow 429 sets global pause");
  assert.ok(
    typeof manual.rateLimitedUntil === "number" && manual.rateLimitedUntil > Date.now(),
    "reconcileNow exposes rateLimitedUntil for UI wait-and-resume"
  );

  console.log(
    "  ✔ global gate, capped confirms, round-robin, skip reasons, settled cooldown, " +
      "unsettled catch-up, ordered share, empty-budget gate, reentrancy busy, " +
      "tick prefer-drain+list, reconcileNow gate"
  );
}

async function scenario68b_trashFastPath() {
  console.log("\n== 6.8b Trash listing soft-delete fast path ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  await resetAll(eng.store);

  const mock = makeMockRaindrop();
  let getRaindropCalls = 0;
  const origGet = mock.getRaindrop.bind(mock);
  mock.getRaindrop = async (id) => {
    getRaindropCalls++;
    return origGet(id);
  };
  patchClient(eng.raindropMod, mock);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-Trash",
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  const root = await mock.createCollection("ERS-Verify-Trash", null);

  // Paired soft-delete → Trash list enqueues delete-edge without confirm GET.
  const live = mock._seedRich(root._id, {
    link: "https://example.com/ers-trash-paired",
    title: "trash-paired",
  });
  await eng.store.recordSynced("bm-trash-paired", String(live._id));
  await mock.deleteRaindrop(live._id);

  // Unpaired trash item must be ignored.
  const stray = mock._seedRich(root._id, {
    link: "https://example.com/ers-trash-unpaired",
    title: "trash-unpaired",
  });
  await mock.deleteRaindrop(stray._id);

  getRaindropCalls = 0;
  await eng.reconcile.reconcile({ force: true });
  assert.equal(
    (await eng.queue.list()).filter(
      (j) => j.kind === JOB.DELETE_EDGE && String(j.raindropId) === String(live._id)
    ).length,
    1,
    "paired trash id enqueues delete-edge"
  );
  assert.equal(
    (await eng.queue.list()).filter((j) => String(j.raindropId) === String(stray._id)).length,
    0,
    "unpaired trash id ignored"
  );
  assert.equal(getRaindropCalls, 0, "trash fast path skips confirm GET for handled ids");

  // Permanent delete (not in Trash) still uses confirm-GET fallback.
  const jobs = await eng.queue.list();
  await chrome.storage.local.set({
    queue: jobs.filter((j) => j.id !== `de-${live._id}`),
  });
  const hardRid = 91001;
  mock._raindrops.set(hardRid, {
    _id: hardRid,
    link: "https://example.com/ers-hard-gone",
    title: "hard-gone",
    collection: { $id: root._id },
  });
  await eng.store.recordSynced("bm-hard-gone", String(hardRid));
  mock._raindrops.delete(hardRid); // hard gone — not moved to trash

  getRaindropCalls = 0;
  await eng.reconcile.reconcile({ force: true });
  assert.ok(getRaindropCalls >= 1, "confirm GET still runs for non-trash absence");
  assert.ok(
    (await eng.queue.list()).some(
      (j) => j.kind === JOB.DELETE_EDGE && String(j.raindropId) === String(hardRid)
    ),
    "confirm-GET fallback enqueues delete-edge for permanent delete"
  );

  const hygiene = await eng.store.getReconcileState();
  assert.ok(hygiene.trashHygieneAt != null, "trash hygiene snapshot stamped");
  assert.equal(hygiene.trashScanComplete, true, "small Trash scan completes");
  assert.equal(hygiene.trashPairedPending, 0, "enrolled paired trash clears discovery debt");
  const { deriveTrashSafeState } = await import("../src/lib/trash-hygiene.js");
  assert.equal(deriveTrashSafeState(hygiene), "safe", "complete clear ⇒ safe to empty");

  console.log("  ✔ paired trash → delete-edge; unpaired ignored; confirm fallback for hard delete");
}

async function scenario68e_trashSafeStatus() {
  console.log("\n== 6.8e Trash-safe Status snapshot + Check Trash ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  const { deriveTrashSafeState } = await import("../src/lib/trash-hygiene.js");
  await resetAll(eng.store);

  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-TrashSafe",
    syncMode: SYNC_MODE.ONE_WAY,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  const oneWay = await eng.sync.checkTrashNow();
  assert.equal(oneWay.ok, false, "Check Trash blocked in one-way");
  assert.equal(oneWay.reason, "one_way");

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-TrashSafe",
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  const root = await mock.createCollection("ERS-Verify-TrashSafe", null);
  const live = mock._seedRich(root._id, {
    link: "https://example.com/ers-trash-safe",
    title: "trash-safe",
  });
  await eng.store.recordSynced("bm-trash-safe", String(live._id));
  await mock.deleteRaindrop(live._id);

  const before = await eng.store.getReconcileState();
  assert.equal(before.trashHygieneAt, null, "no peek yet");
  assert.equal(deriveTrashSafeState(before), "unknown");

  const peek = await eng.sync.checkTrashNow();
  assert.equal(peek.ok, true, "Check Trash ok");
  assert.equal(peek.trashSafe?.state, "safe", "Check Trash enrolls and reports safe");
  const stillPaired = (await eng.store.getPairs()).byRaindrop[String(live._id)];
  const queued = (await eng.queue.list()).some(
    (j) => j.kind === JOB.DELETE_EDGE && String(j.raindropId) === String(live._id)
  );
  assert.ok(queued || !stillPaired, "Check Trash enrolled or applied delete-edge");

  await eng.store.setReconcileState({
    trashHygieneAt: Date.now(),
    trashScanComplete: false,
    trashPairedPending: 0,
    trashHygieneSource: "check-trash",
  });
  assert.equal(
    deriveTrashSafeState(await eng.store.getReconcileState()),
    "partial",
    "incomplete peek is not safe"
  );

  await eng.store.setReconcileState({
    trashHygieneAt: Date.now(),
    trashScanComplete: true,
    trashPairedPending: 3,
    trashHygieneSource: "reconcile",
  });
  assert.equal(
    deriveTrashSafeState(await eng.store.getReconcileState()),
    "waiting",
    "paired pending ⇒ waiting"
  );

  // Exhausted wake must not stomp a prior complete snapshot with "incomplete".
  await eng.store.setReconcileState({
    trashHygieneAt: 42,
    trashScanComplete: true,
    trashPairedPending: 0,
    trashHygieneSource: "check-trash",
  });
  await eng.reconcileFinish.runTrashHygienePeek({
    client: new eng.raindropMod.RaindropClient("mock"),
    budget: { canSpend: () => false, allowance: () => 0 },
  });
  const preserved = await eng.store.getReconcileState();
  assert.equal(preserved.trashHygieneAt, 42, "zero-budget peek keeps prior at");
  assert.equal(preserved.trashScanComplete, true, "zero-budget peek keeps complete");
  assert.equal(deriveTrashSafeState(preserved), "safe");

  console.log("  ✔ unknown → Check Trash safe; partial/waiting; one-way blocked; no zero-budget stomp");
}

async function scenario68c_parkOutOfScopeAlives() {
  console.log("\n== 6.8c Park out-of-scope alive confirm candidates ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  await resetAll(eng.store);

  const mock = makeMockRaindrop();
  let getRaindropCalls = 0;
  const origGet = mock.getRaindrop.bind(mock);
  mock.getRaindrop = async (id) => {
    getRaindropCalls++;
    return origGet(id);
  };
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-Park";
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  await mock.createCollection(rootName, null);
  const outside = await mock.createCollection("ParkOutside", null);
  const item = mock._seedRich(outside._id, {
    link: "https://example.com/ers-park-outside",
    title: "park-outside",
  });
  await eng.store.recordSynced("bm-park-outside", String(item._id));

  // Absent from scoped listing (empty allowlist) + alive → park.
  getRaindropCalls = 0;
  await eng.reconcile.reconcile({ force: true });
  assert.ok(
    (await eng.store.getParkedAliveIds()).has(String(item._id)),
    "out-of-scope alive parked after confirm GET"
  );
  assert.equal(
    (await eng.queue.list()).filter((j) => j.kind === JOB.DELETE_EDGE).length,
    0,
    "park does not enqueue delete-edge"
  );
  assert.ok(getRaindropCalls >= 1, "first cycle spends a confirm GET to park");

  // Next cycle must not re-confirm the parked id.
  getRaindropCalls = 0;
  await eng.reconcile.reconcile({ force: true });
  assert.equal(getRaindropCalls, 0, "parked id skipped on subsequent confirm window");
  assert.ok(
    (await eng.store.getParkedAliveIds()).has(String(item._id)),
    "park persists across cycles"
  );

  // Soft-delete while parked → Trash fast path still deletes Edge.
  await mock.deleteRaindrop(item._id);
  assert.ok(mock._trash.has(Number(item._id)), "mock soft-delete lands in Trash");
  await eng.reconcile.reconcile({ force: true });
  assert.ok(
    (await eng.queue.list()).some(
      (j) => j.kind === JOB.DELETE_EDGE && String(j.raindropId) === String(item._id)
    ),
    "Trash fast path still deletes parked pair"
  );

  // In-scope alive under root is not parked when listed (seen → not a candidate).
  await resetAll(eng.store);
  const mock2 = makeMockRaindrop();
  patchClient(eng.raindropMod, mock2);
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  const root2 = await mock2.createCollection(rootName, null);
  const inScope = mock2._seedRich(root2._id, {
    link: "https://example.com/ers-park-inscope",
    title: "park-inscope",
  });
  await eng.store.recordSynced("bm-park-inscope", String(inScope._id));
  await eng.reconcile.reconcile({ force: true });
  assert.equal(
    (await eng.store.getParkedAliveIds()).has(String(inScope._id)),
    false,
    "in-scope listed pair is not parked"
  );

  console.log("  ✔ park out-of-scope; skip re-confirm; Trash still deletes; in-scope not parked");
}

/**
 * Engine integration for Pull now wait-and-resume.
 * Only touches disposable ERS-Verify-PullWait* Raindrop fixtures and
 * example.com/ers-pull-wait-* Edge URLs on the in-memory tree.
 */
async function scenario68d_pullNowWaitAndResume() {
  console.log("\n== 6.8d Pull now waits out rate limit and resumes ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB, MSG } = eng.constants;
  await resetAll(eng.store);

  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-PullWait";
  const resumeUrl = "https://example.com/ers-pull-wait-resume";
  const doneUrl = "https://example.com/ers-pull-wait-done";

  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const root = await mock.createCollection(rootName, null);
  const bar = await mock.createCollection("Bookmarks bar", root._id);
  const folder = await mock.createCollection("ERS-Verify-PullWait-Folder", bar._id);
  const remote = mock._seedRich(folder._id, {
    link: resumeUrl,
    title: "ERS pull wait resume",
  });

  // First Pull now pass hits the global pause; sleepFn clears only our pause.
  await eng.store.noteRateLimitedUntil(Date.now() + 5_000);
  let slept = 0;
  const pulled = await runPullNow(
    async (msg) => {
      if (msg.type === MSG.GET_STATUS) {
        return { ok: true, status: await eng.store.getStatus() };
      }
      if (msg.type === MSG.RECONCILE_NOW) {
        try {
          const result = await eng.sync.reconcileNow();
          return { ok: true, ...result };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      }
      return { ok: false, error: `unexpected message ${msg.type}` };
    },
    {
      sleepFn: async () => {
        slept++;
        await eng.store.clearRateLimit();
      },
    }
  );

  assert.equal(slept, 1, "Pull now waited out the rate-limit pause once");
  assert.match(pulled.text, /Pull finished/);
  assert.ok(pulled.totalQueued >= 1, "resumed pull enqueued at least the seeded raindrop");

  const edge = findEdgeByUrl(resumeUrl);
  assert.ok(edge, "resumed pull created Edge bookmark for the test raindrop");
  assert.equal(
    await eng.store.getBookmarkIdForRaindrop(String(remote._id)),
    edge.id,
    "pair maps only our seeded raindrop"
  );
  assert.deepEqual(
    edgeUrls().filter((u) => u.includes("ers-pull-wait")),
    [resumeUrl],
    "only the test pull-wait URL was created on Edge"
  );
  assert.equal(
    [...mock._raindrops.values()].every((r) => String(r.link).includes("ers-pull-wait")),
    true,
    "mock Raindrop library only holds this scenario's fixtures"
  );

  // Done under pause: listing finishes while rateLimitedUntil is armed — must
  // keep done (not rewrite as skipped rate_limited) and skip drain.
  await resetAll(eng.store);
  const mockDone = makeMockRaindrop();
  patchClient(eng.raindropMod, mockDone);
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  const rootDone = await mockDone.createCollection(rootName, null);
  const barDone = await mockDone.createCollection("Bookmarks bar", rootDone._id);
  const folderDone = await mockDone.createCollection("ERS-Verify-PullWait-Done", barDone._id);
  mockDone._seedRich(folderDone._id, {
    link: doneUrl,
    title: "ERS pull wait done",
  });

  const origList = mockDone.listRaindrops.bind(mockDone);
  mockDone.listRaindrops = async (...args) => {
    const page = await origList(...args);
    // Arm pause after API work so post-reconcile gate trips before drain.
    await eng.store.noteRateLimitedUntil(Date.now() + 60_000);
    return page;
  };
  const doneResult = await eng.sync.reconcileNow();
  mockDone.listRaindrops = origList;

  assert.equal(doneResult.done, true, "listing finished under pause");
  assert.notEqual(
    doneResult.skipped,
    true,
    "done under pause is not rewritten as rate_limited skip"
  );
  assert.equal(await eng.store.isRateLimited(), true, "pause remains for drain skip");
  assert.equal(
    !!findEdgeByUrl(doneUrl),
    false,
    "drain skipped — Edge bookmark not created yet"
  );
  assert.ok(
    (await eng.queue.list()).some(
      (j) => eng.queue.jobKind(j) === JOB.PULL_CREATE && j.link === doneUrl
    ),
    "pull-create for the test URL stayed queued when drain was skipped"
  );

  console.log("  ✔ Pull now wait-and-resume + done-under-pause preserves finish");
}

async function scenario69_bookmarkMoves() {
  console.log("\n== 6.9 Edge bookmark moves update Raindrop placement ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-Moves";
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const srcFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Move-Src",
  });
  const destFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Move-Dest",
  });
  const bm = await chrome.bookmarks.create({
    parentId: srcFolder.id,
    title: "ERS move me",
    url: "https://example.com/ers-verify-move",
  });

  await eng.queue.enqueue(bm.id);
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, 1, "initial upload");
  const rid = await eng.store.getRaindropId(bm.id);
  assert.ok(rid, "paired after upload");
  const beforeItem = mock._raindrops.get(Number(rid));
  beforeItem.tags = ["keep-me"];
  beforeItem.note = "rich-note";
  const oldCollectionId = beforeItem.collection.$id;

  // Same-parent reorder → no enqueue
  const qBeforeReorder = await eng.queue.size();
  await eng.sync.handleBookmarkMoved(bm.id, {
    oldParentId: srcFolder.id,
    parentId: srcFolder.id,
  });
  assert.equal(await eng.queue.size(), qBeforeReorder, "reorder does not enqueue");
  assert.equal(
    mock._raindrops.get(Number(rid)).collection.$id,
    oldCollectionId,
    "reorder does not change collection"
  );

  // Parent change → update collection, preserve rich fields, no delete job
  bookmarks.get(bm.id).parentId = destFolder.id;
  await eng.sync.handleBookmarkMoved(bm.id, {
    oldParentId: srcFolder.id,
    parentId: destFolder.id,
  });
  const afterMove = mock._raindrops.get(Number(rid));
  assert.ok(afterMove, "same raindrop id after move");
  assert.notEqual(afterMove.collection.$id, oldCollectionId, "collection updated");
  assert.deepEqual(afterMove.tags, ["keep-me"], "tags intact");
  assert.equal(afterMove.note, "rich-note", "note intact");
  assert.equal(await eng.store.getRaindropId(bm.id), String(rid), "pair retained");
  const jobsAfterMove = await eng.queue.list();
  assert.equal(
    jobsAfterMove.some((j) => eng.queue.jobKind(j) === JOB.DELETE_RAINDROP),
    false,
    "move does not enqueue delete-raindrop"
  );
  const log = await eng.store.getLog();
  assert.ok(
    log.some((e) => typeof e.message === "string" && e.message.startsWith("Moved:")),
    "activity logs Moved:"
  );

  // Folder move fans out to nested URL bookmarks
  const nest = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Move-Nest",
  });
  const nestChild = await chrome.bookmarks.create({
    parentId: nest.id,
    title: "ERS-Move-Nest-Child",
  });
  const bmA = await chrome.bookmarks.create({
    parentId: nestChild.id,
    title: "nested A",
    url: "https://example.com/ers-verify-move-a",
  });
  const bmB = await chrome.bookmarks.create({
    parentId: nest.id,
    title: "nested B",
    url: "https://example.com/ers-verify-move-b",
  });
  await eng.queue.enqueueMany([bmA.id, bmB.id]);
  await eng.sync.drain();
  const ridA = await eng.store.getRaindropId(bmA.id);
  const ridB = await eng.store.getRaindropId(bmB.id);
  const colABefore = mock._raindrops.get(Number(ridA)).collection.$id;
  const colBBefore = mock._raindrops.get(Number(ridB)).collection.$id;
  const nestDest = await chrome.bookmarks.create({
    parentId: "2",
    title: "ERS-Move-Nest-Dest",
  });
  bookmarks.get(nest.id).parentId = nestDest.id;
  await eng.sync.handleBookmarkMoved(nest.id, {
    oldParentId: "1",
    parentId: nestDest.id,
  });
  const colA = mock._raindrops.get(Number(ridA)).collection.$id;
  const colB = mock._raindrops.get(Number(ridB)).collection.$id;
  assert.notEqual(colA, colABefore, "folder move updates nested A collection");
  assert.notEqual(colB, colBBefore, "folder move updates nested B collection");

  // Move into exclude → no Raindrop write
  const excl = await chrome.bookmarks.create({ parentId: "1", title: "ERS-Move-Excl" });
  await eng.store.setOverride(excl.id, POLICY.EXCLUDE, "Favorites bar/ERS-Move-Excl");
  const exclBm = await chrome.bookmarks.create({
    parentId: destFolder.id,
    title: "ERS exclude move",
    url: "https://example.com/ers-verify-move-excl",
  });
  await eng.queue.enqueue(exclBm.id);
  await eng.sync.drain();
  const exclRid = await eng.store.getRaindropId(exclBm.id);
  const exclColBefore = mock._raindrops.get(Number(exclRid)).collection.$id;
  bookmarks.get(exclBm.id).parentId = excl.id;
  const raindropCountBeforeExcl = mock._raindrops.size;
  await eng.sync.handleBookmarkMoved(exclBm.id, {
    oldParentId: destFolder.id,
    parentId: excl.id,
  });
  assert.equal(mock._raindrops.size, raindropCountBeforeExcl, "exclude move adds no raindrop");
  assert.equal(
    mock._raindrops.get(Number(exclRid)).collection.$id,
    exclColBefore,
    "exclude move leaves collection unchanged"
  );
  assert.ok(findEdgeByUrl("https://example.com/ers-verify-move-excl"), "edge kept under exclude");

  // Move into offload → update then remove Edge; Raindrop kept; no delete-raindrop
  const offload = await chrome.bookmarks.create({ parentId: "1", title: "ERS-Move-Offload" });
  await eng.store.setOverride(offload.id, POLICY.SYNC_DELETE, "Favorites bar/ERS-Move-Offload");
  const keepBm = await chrome.bookmarks.create({
    parentId: destFolder.id,
    title: "ERS offload move",
    url: "https://example.com/ers-verify-move-offload",
  });
  await eng.queue.enqueue(keepBm.id);
  await eng.sync.drain();
  const offRid = await eng.store.getRaindropId(keepBm.id);
  assert.ok(offRid, "paired before offload move");
  bookmarks.get(keepBm.id).parentId = offload.id;
  await eng.sync.handleBookmarkMoved(keepBm.id, {
    oldParentId: destFolder.id,
    parentId: offload.id,
  });
  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-verify-move-offload"),
    false,
    "Edge removed after offload move"
  );
  assert.ok(mock._raindrops.get(Number(offRid)), "Raindrop kept after offload move");
  assert.equal(mock._trash.has(Number(offRid)), false, "not soft-deleted in Raindrop");
  assert.equal(
    await eng.store.hasTombstone(String(offRid)),
    true,
    "edge-offload tombstone recorded"
  );
  const pendingDeletes = (await eng.queue.list()).filter(
    (j) => eng.queue.jobKind(j) === JOB.DELETE_RAINDROP
  );
  assert.equal(pendingDeletes.length, 0, "offload move does not queue Raindrop delete");

  // Stale pair 404 → recreate
  const staleBm = await chrome.bookmarks.create({
    parentId: destFolder.id,
    title: "ERS stale pair",
    url: "https://example.com/ers-verify-move-stale",
  });
  await eng.queue.enqueue(staleBm.id);
  await eng.sync.drain();
  const staleRid = await eng.store.getRaindropId(staleBm.id);
  mock._raindrops.delete(Number(staleRid));
  const dest2 = await chrome.bookmarks.create({ parentId: "1", title: "ERS-Move-Stale-Dest" });
  bookmarks.get(staleBm.id).parentId = dest2.id;
  await eng.sync.handleBookmarkMoved(staleBm.id, {
    oldParentId: destFolder.id,
    parentId: dest2.id,
  });
  const newRid = await eng.store.getRaindropId(staleBm.id);
  assert.ok(newRid, "re-paired after 404");
  assert.notEqual(String(newRid), String(staleRid), "new raindrop after 404 recreate");
  assert.ok(mock._raindrops.get(Number(newRid)), "recreated raindrop exists");

  // Unpaired move: existing Raindrop URL → rebind + relocate (no second copy)
  const orphanCol = await mock.createCollection("ERS-Orphan-JSON", null);
  const orphanUrl = "https://example.com/ers-verify-move-rebind";
  const orphanItem = mock._seedRich(orphanCol._id, {
    link: orphanUrl,
    title: "orphan JSON",
    tags: ["keep-orphan"],
    note: "orphan-note",
  });
  const rebindSrc = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Rebind-Src",
  });
  const rebindDest = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Rebind-Dest",
  });
  const unpairedBm = await chrome.bookmarks.create({
    parentId: rebindSrc.id,
    title: "unpaired move me",
    url: orphanUrl,
  });
  assert.equal(await eng.store.getRaindropId(unpairedBm.id), null, "unpaired before move");
  const createsBeforeRebind = mock._calls.createRaindrop;
  const sizeBeforeRebind = mock._raindrops.size;
  bookmarks.get(unpairedBm.id).parentId = rebindDest.id;
  await eng.sync.handleBookmarkMoved(unpairedBm.id, {
    oldParentId: rebindSrc.id,
    parentId: rebindDest.id,
  });
  assert.equal(mock._calls.createRaindrop, createsBeforeRebind, "unpaired move creates no raindrop");
  assert.equal(mock._raindrops.size, sizeBeforeRebind, "unpaired move does not fork");
  assert.equal(
    await eng.store.getRaindropId(unpairedBm.id),
    String(orphanItem._id),
    "unpaired move rebinds to existing raindrop"
  );
  const rebound = mock._raindrops.get(orphanItem._id);
  assert.notEqual(rebound.collection.$id, orphanCol._id, "rebound raindrop relocated");
  assert.deepEqual(rebound.tags, ["keep-orphan"], "rebind preserves tags");
  assert.equal(rebound.note, "orphan-note", "rebind preserves note");

  // Multi-match: relocate oldest, do not create a third
  const multiUrl = "https://example.com/ers-verify-move-multi";
  const multiOld = mock._seedRich(orphanCol._id, { link: multiUrl, title: "multi-old" });
  const multiNew = mock._seedRich(orphanCol._id, { link: multiUrl, title: "multi-new" });
  const multiBm = await chrome.bookmarks.create({
    parentId: rebindSrc.id,
    title: "multi move",
    url: multiUrl,
  });
  const createsBeforeMulti = mock._calls.createRaindrop;
  const sizeBeforeMulti = mock._raindrops.size;
  bookmarks.get(multiBm.id).parentId = rebindDest.id;
  await eng.sync.handleBookmarkMoved(multiBm.id, {
    oldParentId: rebindSrc.id,
    parentId: rebindDest.id,
  });
  assert.equal(mock._calls.createRaindrop, createsBeforeMulti, "multi-match move creates none");
  assert.equal(mock._raindrops.size, sizeBeforeMulti, "multi-match does not add a copy");
  assert.equal(
    await eng.store.getRaindropId(multiBm.id),
    String(multiOld._id),
    "multi-match claims oldest id"
  );
  assert.notEqual(
    mock._raindrops.get(multiOld._id).collection.$id,
    orphanCol._id,
    "oldest relocated"
  );
  assert.equal(
    mock._raindrops.get(multiNew._id).collection.$id,
    orphanCol._id,
    "extra copy left in place"
  );

  // Conflict: URL owned by another live Edge bookmark → no create, no steal
  const conflictUrl = "https://example.com/ers-verify-move-conflict";
  const ownerBm = await chrome.bookmarks.create({
    parentId: rebindDest.id,
    title: "owner",
    url: conflictUrl,
  });
  await eng.queue.enqueue(ownerBm.id);
  await eng.sync.drain();
  const ownerRid = await eng.store.getRaindropId(ownerBm.id);
  assert.ok(ownerRid, "owner paired");
  const conflictBm = await chrome.bookmarks.create({
    parentId: rebindSrc.id,
    title: "conflict mover",
    url: conflictUrl,
  });
  const createsBeforeConflict = mock._calls.createRaindrop;
  const sizeBeforeConflict = mock._raindrops.size;
  bookmarks.get(conflictBm.id).parentId = rebindDest.id;
  await eng.sync.handleBookmarkMoved(conflictBm.id, {
    oldParentId: rebindSrc.id,
    parentId: rebindDest.id,
  });
  assert.equal(mock._calls.createRaindrop, createsBeforeConflict, "conflict move creates none");
  assert.equal(mock._raindrops.size, sizeBeforeConflict, "conflict move does not fork");
  assert.equal(await eng.store.getRaindropId(conflictBm.id), null, "conflict mover stays unpaired");
  assert.equal(
    await eng.store.getRaindropId(ownerBm.id),
    String(ownerRid),
    "owner pair retained"
  );

  console.log(
    "  ✔ move update, reorder no-op, folder fan-out, exclude, offload, 404 recreate, URL rebind"
  );
}

async function scenario70_onChangedAndFolderRename() {
  console.log("\n== 7.0 onChanged title/URL + folder rename ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  await resetAll(eng.store);

  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);
  const rootName = "ERS-Verify-Change";

  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const folder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Change-Folder",
  });
  const bm = await chrome.bookmarks.create({
    parentId: folder.id,
    title: "ERS change me",
    url: "https://example.com/ers-verify-change",
  });

  await eng.queue.enqueue(bm.id);
  await eng.sync.drain();
  const rid = await eng.store.getRaindropId(bm.id);
  assert.ok(rid, "paired after upload");
  const item = mock._raindrops.get(Number(rid));
  item.tags = ["keep-tag"];
  item.note = "keep-note";
  const folderColId = await eng.store.getFolderCollectionId(folder.id);
  assert.ok(folderColId != null, "folder→collection mapped on upload");

  // Title change
  bookmarks.get(bm.id).title = "ERS changed title";
  await eng.sync.handleBookmarkChanged(bm.id, { title: "ERS changed title" });
  const afterTitle = mock._raindrops.get(Number(rid));
  assert.equal(afterTitle.title, "ERS changed title", "title updated");
  assert.deepEqual(afterTitle.tags, ["keep-tag"], "tags intact after title change");
  assert.equal(afterTitle.note, "keep-note", "note intact after title change");
  const logAfterTitle = await eng.store.getLog();
  assert.ok(
    logAfterTitle.some((e) => typeof e.message === "string" && e.message.startsWith("Updated:")),
    "activity logs Updated:"
  );

  // URL change
  bookmarks.get(bm.id).url = "https://example.com/ers-verify-change-v2";
  await eng.sync.handleBookmarkChanged(bm.id, { url: "https://example.com/ers-verify-change-v2" });
  assert.equal(
    mock._raindrops.get(Number(rid)).link,
    "https://example.com/ers-verify-change-v2",
    "link updated"
  );

  // Exclude skips title update
  const excl = await chrome.bookmarks.create({ parentId: "1", title: "ERS-Change-Excl" });
  await eng.store.setOverride(excl.id, POLICY.EXCLUDE, "Favorites bar/ERS-Change-Excl");
  const exclBm = await chrome.bookmarks.create({
    parentId: excl.id,
    title: "ERS excl change",
    url: "https://example.com/ers-verify-change-excl",
  });
  // Manually pair as if previously synced elsewhere, then change under exclude
  await eng.store.recordSynced(exclBm.id, 999001);
  mock._raindrops.set(999001, {
    _id: 999001,
    link: exclBm.url,
    title: exclBm.title,
    collection: { $id: 1 },
    tags: [],
    note: "",
  });
  bookmarks.get(exclBm.id).title = "should not sync";
  await eng.sync.handleBookmarkChanged(exclBm.id, { title: "should not sync" });
  assert.equal(
    mock._raindrops.get(999001).title,
    "ERS excl change",
    "exclude title change does not update Raindrop"
  );

  // Mapped folder rename — same collection id, new title, path cache rewritten
  const oldCol = mock._collections.get(Number(folderColId));
  assert.equal(oldCol.title, "ERS-Change-Folder");
  const cacheBefore = await eng.store.getCollectionCache();
  const oldPathKeys = Object.keys(cacheBefore).filter((p) => p.includes("ERS-Change-Folder"));
  assert.ok(oldPathKeys.length > 0, "path cache has old folder title");

  bookmarks.get(folder.id).title = "ERS-Renamed-Folder";
  await eng.sync.handleBookmarkChanged(folder.id, { title: "ERS-Renamed-Folder" });
  const renamed = mock._collections.get(Number(folderColId));
  assert.ok(renamed, "collection still exists");
  assert.equal(renamed.title, "ERS-Renamed-Folder", "collection title renamed");
  assert.equal(
    await eng.store.getFolderCollectionId(folder.id),
    folderColId,
    "folder map keeps same collection id"
  );
  const cacheAfter = await eng.store.getCollectionCache();
  assert.equal(
    Object.keys(cacheAfter).some((p) => p.includes("ERS-Change-Folder")),
    false,
    "path cache dropped old title prefix"
  );
  assert.ok(
    Object.keys(cacheAfter).some((p) => p.includes("ERS-Renamed-Folder")),
    "path cache has new title"
  );
  const logRename = await eng.store.getLog();
  assert.ok(
    logRename.some((e) => typeof e.message === "string" && e.message.startsWith("Renamed folder:")),
    "activity logs Renamed folder:"
  );

  // Unmapped folder rename — no-op
  const orphan = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Never-Synced-Folder",
  });
  const colCount = mock._collections.size;
  bookmarks.get(orphan.id).title = "ERS-Still-Unmapped";
  await eng.sync.handleBookmarkChanged(orphan.id, { title: "ERS-Still-Unmapped" });
  assert.equal(mock._collections.size, colCount, "unmapped rename creates no collection");
  assert.equal(
    (await eng.queue.list()).some((j) => eng.queue.jobKind(j) === JOB.RENAME_COLLECTION),
    false,
    "unmapped rename leaves no rename job"
  );

  // Exclude folder rename skipped
  const exclFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Excl-Folder-Rename",
  });
  await eng.store.setOverride(
    exclFolder.id,
    POLICY.EXCLUDE,
    "Favorites bar/ERS-Excl-Folder-Rename"
  );
  await eng.store.recordFolderCollection(exclFolder.id, folderColId);
  bookmarks.get(exclFolder.id).title = "ERS-Excl-Renamed";
  await eng.sync.handleBookmarkChanged(exclFolder.id, { title: "ERS-Excl-Renamed" });
  assert.equal(
    mock._collections.get(Number(folderColId)).title,
    "ERS-Renamed-Folder",
    "exclude folder rename does not change Raindrop title"
  );

  // Race: upload already queued, then folder rename — rename must win (same id, no orphan).
  const raceFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Race-Old",
  });
  const raceBm = await chrome.bookmarks.create({
    parentId: raceFolder.id,
    title: "ERS race bm",
    url: "https://example.com/ers-verify-rename-race",
  });
  await eng.queue.enqueue(raceBm.id);
  await eng.sync.drain();
  const raceRid = await eng.store.getRaindropId(raceBm.id);
  const raceColId = await eng.store.getFolderCollectionId(raceFolder.id);
  assert.ok(raceColId != null, "race folder mapped");
  const parentOfRace = mock._collections.get(Number(raceColId))?.parent?.$id;
  const colsBeforeRace = [...mock._collections.values()].filter(
    (c) =>
      c.parent?.$id === parentOfRace ||
      (c.parent?.$id == null && parentOfRace == null) ||
      String(c.parent?.$id) === String(parentOfRace)
  ).length;

  bookmarks.get(raceFolder.id).title = "ERS-Race-New";
  await eng.queue.clear();
  // Upload first in storage order; due() must still drain rename first.
  await eng.queue.enqueue(raceBm.id, { reason: "change" });
  await eng.queue.enqueueJob({
    id: `rc-${raceFolder.id}`,
    kind: JOB.RENAME_COLLECTION,
    folderId: String(raceFolder.id),
  });
  const dueOrdered = await eng.queue.due(Date.now());
  assert.equal(
    eng.queue.jobKind(dueOrdered[0]),
    JOB.RENAME_COLLECTION,
    "due() prioritizes rename-collection ahead of upload"
  );
  await eng.sync.drain();

  assert.equal(
    mock._collections.get(Number(raceColId))?.title,
    "ERS-Race-New",
    "mapped collection retitled in place"
  );
  assert.equal(
    await eng.store.getFolderCollectionId(raceFolder.id),
    raceColId,
    "folder map still points at same collection id"
  );
  assert.equal(
    mock._raindrops.get(Number(raceRid))?.collection?.$id,
    Number(raceColId) || raceColId,
    "raindrop stayed on renamed collection"
  );
  const siblingNew = [...mock._collections.values()].filter(
    (c) =>
      (c.title || "") === "ERS-Race-New" &&
      (c.parent?.$id === parentOfRace || String(c.parent?.$id) === String(parentOfRace))
  );
  assert.equal(siblingNew.length, 1, "no duplicate collection for new title");
  assert.equal(
    [...mock._collections.values()].some(
      (c) =>
        (c.title || "") === "ERS-Race-Old" &&
        (c.parent?.$id === parentOfRace || String(c.parent?.$id) === String(parentOfRace))
    ),
    false,
    "old title not left as sibling orphan"
  );
  assert.equal(
    [...mock._collections.values()].filter(
      (c) =>
        c.parent?.$id === parentOfRace ||
        (c.parent?.$id == null && parentOfRace == null) ||
        String(c.parent?.$id) === String(parentOfRace)
    ).length,
    colsBeforeRace,
    "no extra collection under same parent after rename+upload race"
  );

  // Rename defer aborts the pass: upload must not create a duplicate while rename retries.
  const deferFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Defer-Old",
  });
  const deferBm = await chrome.bookmarks.create({
    parentId: deferFolder.id,
    title: "ERS defer bm",
    url: "https://example.com/ers-verify-rename-defer",
  });
  await eng.queue.enqueue(deferBm.id);
  await eng.sync.drain();
  const deferColId = await eng.store.getFolderCollectionId(deferFolder.id);
  assert.ok(deferColId != null, "defer folder mapped");
  const deferParent = mock._collections.get(Number(deferColId))?.parent?.$id;
  const colsBeforeDefer = [...mock._collections.values()].filter(
    (c) =>
      c.parent?.$id === deferParent ||
      (c.parent?.$id == null && deferParent == null) ||
      String(c.parent?.$id) === String(deferParent)
  ).length;

  bookmarks.get(deferFolder.id).title = "ERS-Defer-New";
  await eng.queue.clear();
  await eng.queue.enqueue(deferBm.id, { reason: "change" });
  await eng.queue.enqueueJob({
    id: `rc-${deferFolder.id}`,
    kind: JOB.RENAME_COLLECTION,
    folderId: String(deferFolder.id),
  });

  const realUpdateCollection = mock.updateCollection.bind(mock);
  let renameFailuresLeft = 1;
  mock.updateCollection = async (id, fields) => {
    if (renameFailuresLeft-- > 0) throw new Error("temporary rename failure");
    return realUpdateCollection(id, fields);
  };

  await eng.sync.drain();
  assert.equal(
    mock._collections.get(Number(deferColId))?.title,
    "ERS-Defer-Old",
    "collection title unchanged after failed rename"
  );
  assert.equal(
    [...mock._collections.values()].some((c) => (c.title || "") === "ERS-Defer-New"),
    false,
    "upload did not create new-titled collection after rename defer"
  );
  assert.equal(
    [...mock._collections.values()].filter(
      (c) =>
        c.parent?.$id === deferParent ||
        (c.parent?.$id == null && deferParent == null) ||
        String(c.parent?.$id) === String(deferParent)
    ).length,
    colsBeforeDefer,
    "no extra sibling after rename defer abort"
  );
  const pendingAfterDefer = await eng.queue.list();
  const renamePending = pendingAfterDefer.find(
    (j) => eng.queue.jobKind(j) === JOB.RENAME_COLLECTION
  );
  const uploadPending = pendingAfterDefer.find(
    (j) => eng.queue.jobKind(j) === JOB.UPLOAD && j.id === deferBm.id
  );
  assert.ok(renamePending, "rename job still queued after defer");
  assert.ok(uploadPending, "upload left for a later pass");
  assert.ok(
    (uploadPending.nextAttemptAt ?? 0) >= (renamePending.nextAttemptAt ?? 0),
    "upload deferred at least as late as rename backoff"
  );
  assert.equal(
    (await eng.queue.due(Date.now())).length,
    0,
    "nothing due until rename backoff elapses"
  );

  // Next drain: force both due; rename succeeds, then upload; still one collection id.
  await eng.queue.deferUntil(renamePending.id, 0);
  await eng.queue.deferUntil(uploadPending.id, 0);
  await eng.sync.drain();
  assert.equal(
    mock._collections.get(Number(deferColId))?.title,
    "ERS-Defer-New",
    "rename succeeds on retry"
  );
  assert.equal(
    await eng.store.getFolderCollectionId(deferFolder.id),
    deferColId,
    "folder map unchanged after deferred rename"
  );
  assert.equal(
    [...mock._collections.values()].filter((c) => (c.title || "") === "ERS-Defer-New").length,
    1,
    "single new-titled collection after retry"
  );

  console.log(
    "  ✔ title/URL update, exclude skip, folder rename, unmapped/exclude no-op, rename-before-upload, rename-defer abort"
  );
}

async function scenario71_tombstonePruneAndPullUpdate() {
  console.log("\n== 6.11 Tombstone prune + Raindrop→Edge pull-update/folder rename ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-PrunePull";
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const root = await mock.createCollection(rootName, null);
  const bar = await mock.createCollection("Bookmarks bar", root._id);
  const folder = await mock.createCollection("ERS-Prune-Folder", bar._id);

  // --- Tombstone prune: gone raindrop drops tombstone; living offload keeps it ---
  const gone = mock._seedRich(folder._id, {
    link: "https://example.com/ers-tombstone-gone",
    title: "gone",
  });
  await eng.store.addTombstone(String(gone._id), "edge-user-delete");
  await mock.deleteRaindrop(gone._id);

  const liveOffload = mock._seedRich(folder._id, {
    link: "https://example.com/ers-tombstone-offload",
    title: "offload-keep",
  });
  await eng.store.addTombstone(String(liveOffload._id), "edge-offload");

  await eng.reconcile.reconcile({ force: true });
  assert.equal(
    await eng.store.hasTombstone(String(gone._id)),
    false,
    "absent raindrop tombstone pruned"
  );
  assert.equal(
    await eng.store.hasTombstone(String(liveOffload._id)),
    true,
    "living offload tombstone kept"
  );

  // --- Pull-update: Raindrop title/URL/collection change updates Edge ---
  const remote = mock._seedRich(folder._id, {
    link: "https://example.com/ers-pull-update",
    title: "original title",
  });
  await eng.reconcile.reconcile({ force: true });
  await eng.sync.drain();
  const edge = findEdgeByUrl("https://example.com/ers-pull-update");
  assert.ok(edge, "pulled for update test");
  assert.equal(edge.title, "original title");

  const otherFolder = await mock.createCollection("ERS-Prune-Other", bar._id);
  const item = mock._raindrops.get(remote._id);
  item.title = "renamed in raindrop";
  item.link = "https://example.com/ers-pull-update-v2";
  item.collection = { $id: otherFolder._id };

  await eng.reconcile.reconcile({ force: true });
  const jobs = await eng.queue.list();
  assert.ok(
    jobs.some(
      (j) => eng.queue.jobKind(j) === JOB.PULL_UPDATE && String(j.raindropId) === String(remote._id)
    ),
    "pull-update enqueued"
  );
  await eng.sync.drain();

  const updated = findEdgeByUrl("https://example.com/ers-pull-update-v2");
  assert.ok(updated, "Edge URL updated from Raindrop");
  assert.equal(updated.title, "renamed in raindrop");
  assert.equal(updated.id, edge.id, "same bookmark id");
  const parent = await chrome.bookmarks.get(updated.parentId);
  assert.equal(parent[0].title, "ERS-Prune-Other", "Edge parent follows Raindrop collection");

  // Change suppression: synthetic onChanged must not re-upload
  const beforeSize = mock._raindrops.size;
  await eng.sync.handleBookmarkChanged(updated.id, {
    title: "renamed in raindrop",
    url: "https://example.com/ers-pull-update-v2",
  });
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, beforeSize, "suppressed change does not create duplicate");

  // --- existing-only: Raindrop move to missing path → title OK, no folder create ---
  const { RAINDROP_FOLDER_MODE } = eng.constants;
  await eng.store.setConfig({
    ...(await eng.store.getConfig()),
    raindropFolderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
  });
  const missingDest = await mock.createCollection("ERS-Missing-Dest", bar._id);
  const movedItem = mock._raindrops.get(remote._id);
  movedItem.title = "title while move blocked";
  movedItem.collection = { $id: missingDest._id };
  await eng.reconcile.reconcile({ force: true });
  await eng.sync.drain();
  const stayed = findEdgeByUrl("https://example.com/ers-pull-update-v2");
  assert.ok(stayed, "bookmark still present");
  assert.equal(stayed.title, "title while move blocked", "title updated under existing-only");
  assert.equal(
    (await chrome.bookmarks.get(stayed.parentId))[0].title,
    "ERS-Prune-Other",
    "parent unchanged when dest folders missing"
  );
  assert.equal(
    [...bookmarks.values()].some((n) => !n.url && n.title === "ERS-Missing-Dest"),
    false,
    "existing-only did not create missing dest folder on pull-update"
  );
  // Restore create-as-needed for later folder-rename steps
  await eng.store.setConfig({
    ...(await eng.store.getConfig()),
    raindropFolderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
  });

  // --- Raindrop collection rename → Edge folder title ---
  const edgeFolder = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Folder-Old",
  });
  const folderBm = await chrome.bookmarks.create({
    parentId: edgeFolder.id,
    title: "folder-rename-probe",
    url: "https://example.com/ers-folder-rename-probe",
  });
  await eng.queue.enqueue(folderBm.id);
  await eng.sync.drain();
  const colId = await eng.store.getFolderCollectionId(edgeFolder.id);
  assert.ok(colId != null, "folder→collection mapped on upload");
  const col = mock._collections.get(Number(colId)) || mock._collections.get(colId);
  assert.ok(col, "raindrop collection exists");
  col.title = "ERS-Folder-New";

  await eng.reconcile.reconcile({ force: true });
  const renameJobs = await eng.queue.list();
  assert.ok(
    renameJobs.some(
      (j) =>
        eng.queue.jobKind(j) === JOB.PULL_RENAME_FOLDER &&
        String(j.folderId) === String(edgeFolder.id)
    ),
    "pull-rename-folder enqueued"
  );
  await eng.sync.drain();
  const renamedFolder = (await chrome.bookmarks.get(edgeFolder.id))[0];
  assert.equal(renamedFolder.title, "ERS-Folder-New", "Edge folder title follows Raindrop");

  // Folder onChanged suppress should not enqueue Edge→Raindrop rename
  await eng.sync.handleBookmarkChanged(edgeFolder.id, { title: "ERS-Folder-New" });
  await eng.sync.drain();
  assert.equal(
    (await eng.queue.list()).some((j) => eng.queue.jobKind(j) === JOB.RENAME_COLLECTION),
    false,
    "suppressed folder change does not enqueue rename-collection"
  );

  // --- Pull-created folder must learn folderCollections (no prior Edge upload) ---
  // Nest under a private parent so heal disambiguation is not crowded by other bar folders.
  const healParentCol = await mock.createCollection("ERS-Heal-Parent", bar._id);
  const pullOnlyCol = await mock.createCollection("ERS-PullOnly-Old", healParentCol._id);
  mock._seedRich(pullOnlyCol._id, {
    link: "https://example.com/ers-pull-only-folder",
    title: "pull-only child",
  });
  await eng.reconcile.reconcile({ force: true });
  await eng.sync.drain();
  const pullOnlyEdge = [...bookmarks.values()].find(
    (n) => !n.url && n.title === "ERS-PullOnly-Old"
  );
  assert.ok(pullOnlyEdge, "pull-created Edge folder exists");
  assert.ok(
    (await eng.store.getFolderCollectionId(pullOnlyEdge.id)) != null,
    "pull-create records folder→collection mapping"
  );
  const pullOnlyRemote = mock._collections.get(Number(pullOnlyCol._id)) || mock._collections.get(pullOnlyCol._id);
  pullOnlyRemote.title = "ERS-PullOnly-New";
  await eng.reconcile.reconcile({ force: true });
  assert.ok(
    (await eng.queue.list()).some(
      (j) =>
        eng.queue.jobKind(j) === JOB.PULL_RENAME_FOLDER &&
        String(j.folderId) === String(pullOnlyEdge.id)
    ),
    "pull-created folder enqueues pull-rename-folder after Raindrop rename"
  );
  await eng.sync.drain();
  assert.equal(
    (await chrome.bookmarks.get(pullOnlyEdge.id))[0].title,
    "ERS-PullOnly-New",
    "pull-created Edge folder title follows Raindrop rename"
  );

  // --- Heal: wipe map, Raindrop rename still finds the sole unmapped child ---
  await eng.store.clearFolderCollection(pullOnlyEdge.id);
  assert.equal(
    await eng.store.getFolderCollectionId(pullOnlyEdge.id),
    null,
    "map cleared for heal test"
  );
  pullOnlyRemote.title = "ERS-PullOnly-Healed";
  await eng.reconcile.reconcile({ force: true });
  // Prefer in-place rename (pull-rename-folder) over pull-update creating a sibling path.
  await eng.sync.drain();
  const healedNode = (await chrome.bookmarks.get(pullOnlyEdge.id))[0];
  assert.equal(
    healedNode.title,
    "ERS-PullOnly-Healed",
    "healed Edge folder title follows Raindrop after map wipe"
  );
  assert.ok(
    (await eng.store.getFolderCollectionId(pullOnlyEdge.id)) != null,
    "heal re-records folder→collection after map wipe"
  );
  assert.equal(
    [...bookmarks.values()].filter((n) => !n.url && n.title === "ERS-PullOnly-Healed").length,
    1,
    "in-place rename — no duplicate Healed folder"
  );

  console.log("  ✔ tombstone prune; Raindrop→Edge title/URL/move/folder rename; change suppress");
}

async function scenario72_deadLetterAndStorage() {
  console.log("\n== 7.2 Dead-letter + storage usage ==");
  const eng = await importEngine();
  const { MAX_JOB_ATTEMPTS } = eng.constants;
  await resetAll(eng.store);

  // Storage usage reports via getBytesInUse mock.
  const usage = await eng.store.getStorageUsage();
  assert.ok(typeof usage.bytesInUse === "number", "bytesInUse");
  assert.ok(usage.quotaBytes > 0, "quotaBytes");

  // Exhaust retries on a poison upload (bookmark missing → process removes; use
  // a job that throws: delete-raindrop with a client that always fails).
  const mock = makeMockRaindrop();
  mock.deleteRaindrop = async () => {
    throw new Error("poison-delete");
  };
  patchClient(eng.raindropMod, mock);
  await eng.store.setConfig({
    token: "t",
    syncMode: eng.constants.SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: eng.constants.POLICY.SYNC_KEEP,
    rootName: "Edge",
  });

  await eng.queue.enqueueJob({
    id: "dr-999",
    kind: eng.constants.JOB.DELETE_RAINDROP,
    raindropId: "999",
  });
  // Pre-set attempts just below the cap so one defer lands in dead-letter.
  const jobs = await eng.queue.list();
  jobs[0].attempts = MAX_JOB_ATTEMPTS - 1;
  await chrome.storage.local.set({ queue: jobs });

  await eng.sync.drain();
  assert.equal(await eng.queue.size(), 0, "removed from active queue");
  assert.equal(await eng.queue.deadLetterSize(), 1, "in dead-letter");
  const dead = await eng.queue.listDeadLetter();
  assert.match(dead[0].lastError || "", /poison-delete/);

  const retried = await eng.queue.retryDeadLetter();
  assert.equal(retried, 1, "retried");
  assert.equal(await eng.queue.deadLetterSize(), 0, "dlq cleared");
  assert.equal(await eng.queue.size(), 1, "back on queue");
  const again = await eng.queue.list();
  assert.equal(again[0].attempts, 0, "attempts reset");

  await eng.queue.clearDeadLetter(); // noop
  // Put one in DLQ and clear without retry
  await eng.queue.clear();
  await eng.queue.enqueueJob({
    id: "dr-998",
    kind: eng.constants.JOB.DELETE_RAINDROP,
    raindropId: "998",
  });
  const q2 = await eng.queue.list();
  q2[0].attempts = MAX_JOB_ATTEMPTS - 1;
  await chrome.storage.local.set({ queue: q2 });
  await eng.sync.drain();
  assert.equal(await eng.queue.deadLetterSize(), 1);
  await eng.queue.clearDeadLetter();
  assert.equal(await eng.queue.deadLetterSize(), 0);
  assert.equal(await eng.queue.size(), 0, "clear does not re-enqueue");

  console.log("  ✔ dead-letter after max attempts; retry/clear; storage usage");
}

async function scenario73_coalesceActivityLog() {
  console.log("\n== 7.3 Consecutive activity-log coalesce ==");
  const eng = await importEngine();
  const { LOG_ATS_LIMIT } = eng.constants;
  assert.equal(LOG_ATS_LIMIT, 100);
  await resetAll(eng.store);

  const msg = "Verified allowlisted Edge folder path(s): 414.";
  await eng.store.appendLog("info", msg, 1_000);
  let log = await eng.store.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].ats, undefined, "first occurrence has no ats");

  await eng.store.appendLog("info", msg, 2_000);
  await eng.store.appendLog("info", msg, 3_000);
  log = await eng.store.getLog();
  assert.equal(log.length, 1, "consecutive identical lines stay one row");
  assert.equal(log[0].at, 3_000);
  assert.deepEqual(log[0].ats, [1_000, 2_000, 3_000]);

  await eng.store.appendLog("error", msg, 4_000);
  log = await eng.store.getLog();
  assert.equal(log.length, 2, "different level does not coalesce");

  await eng.store.appendLog("info", "Synced: Example", 5_000);
  await eng.store.appendLog("info", msg, 6_000);
  log = await eng.store.getLog();
  assert.equal(log.length, 4, "different message starts a new row");
  assert.equal(log[0].message, msg);
  assert.equal(log[0].at, 6_000);
  assert.equal(log[0].ats, undefined);
  assert.deepEqual(log[3].ats, [1_000, 2_000, 3_000]);

  await resetAll(eng.store);
  const repeats = LOG_ATS_LIMIT + 5;
  for (let i = 0; i < repeats; i++) {
    await eng.store.appendLog("info", "same", i);
  }
  log = await eng.store.getLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].ats.length, LOG_ATS_LIMIT);
  assert.equal(log[0].at, repeats - 1);
  assert.equal(log[0].ats[0], repeats - LOG_ATS_LIMIT);
  assert.equal(log[0].ats[LOG_ATS_LIMIT - 1], repeats - 1);

  console.log("  ✔ consecutive identical lines coalesce; cap drops oldest times");
}

async function optionalLiveSmoke() {
  if (!USE_LIVE) {
    console.log("\n== Live Raindrop smoke skipped (pass --live with token for API check) ==");
    return;
  }
  console.log("\n== Live Raindrop smoke (ERS-Verify-* only) ==");
  verifyRootTitle = `ERS-Verify-${Date.now()}`;
  try {
    const root = await liveCall("POST", "/collection", { title: verifyRootTitle });
    createdLive.collections.push(root.item._id);
    const child = await liveCall("POST", "/collection", {
      title: "ERS-Verify-Child",
      parent: { $id: root.item._id },
    });
    createdLive.collections.push(child.item._id);

    const created = await liveCall("POST", "/raindrop", {
      link: "https://example.com/ers-verify-live",
      title: "ERS-Verify-Live",
      collection: { $id: child.item._id },
      tags: ["ers-verify"],
      note: "dispose-me",
    });
    createdLive.raindrops.push(created.item._id);

    const listed = await liveCall(
      "GET",
      `/raindrops/${root.item._id}?nested=true&perpage=50&page=0`
    );
    assert.ok(
      (listed.items || []).some((i) => i._id === created.item._id),
      "nested list"
    );

    await liveCall("PUT", `/raindrop/${created.item._id}`, { title: "ERS-Verify-Live-Renamed" });
    const after = await liveCall("GET", `/raindrop/${created.item._id}`);
    assert.ok(after.item.tags?.includes("ers-verify"), "tags preserved on partial PUT");
    assert.equal(after.item.note, "dispose-me", "note preserved");

    await liveCall("DELETE", `/raindrop/${created.item._id}`);
    createdLive.raindrops = createdLive.raindrops.filter((id) => id !== created.item._id);
    console.log("  ✔ live create/list/partial-update/delete on disposable collection only");
  } finally {
    await liveCleanup();
    console.log("  ✔ live cleanup complete");
  }
}

async function scenario74_offloadResumeAndCreateSuppress() {
  console.log("\n== 7.4 offload resume + create suppression by bookmark id ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE } = eng.constants;
  const live = await import("../src/lib/live-handlers.js");
  await resetAll(eng.store);

  await eng.store.setConfig({
    token: "mock",
    rootName: "Edge",
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const bm = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS offload resume",
    url: "https://example.com/ers-offload-resume",
  });
  await eng.store.recordSynced(bm.id, "4242");
  await eng.queue.enqueue(bm.id);
  assert.equal(await eng.queue.patchJob(bm.id, { offloadRaindropId: "4242" }), true);
  bookmarks.delete(bm.id);

  await eng.sync.drain();

  assert.equal(await eng.queue.size(), 0, "resumed offload job removed");
  assert.equal(await eng.store.hasTombstone("4242"), true, "tombstone written after bookmark gone");
  assert.equal(await eng.store.getRaindropId(bm.id), null, "pair cleared on resume");
  assert.equal(
    await eng.store.getBookmarkIdForRaindrop("4242"),
    null,
    "reverse pair cleared on resume"
  );

  await resetAll(eng.store);
  eng.store.abortExtensionCreate();
  const url = "https://example.com/ers-same-url";
  const first = await chrome.bookmarks.create({ parentId: "1", title: "first", url });
  const second = await chrome.bookmarks.create({ parentId: "1", title: "second", url });

  eng.store.expectExtensionCreate(url);
  await live.handleBookmarkCreated(first.id, { id: first.id, url: first.url, title: first.title });
  assert.equal(await eng.queue.size(), 0, "in-flight pull-create does not enqueue");
  await live.handleBookmarkCreated(second.id, {
    id: second.id,
    url: second.url,
    title: second.title,
  });
  assert.equal(await eng.queue.size(), 1, "second bookmark with the same URL is queued");

  await eng.queue.clear();
  eng.store.noteExtensionCreate(first.id);
  await live.handleBookmarkCreated(first.id, { id: first.id, url: first.url, title: first.title });
  assert.equal(await eng.queue.size(), 0, "noted extension id is not queued");
  eng.store.releaseExtensionCreate(first.id);

  await eng.store.suppressCreate(second.id);
  await live.handleBookmarkCreated(second.id, {
    id: second.id,
    url: second.url,
    title: second.title,
  });
  assert.equal(await eng.queue.size(), 0, "durable suppress is by bookmark id");

  console.log("  ✔ offload resume tombstone; same-URL create still queues");
}

async function scenario74b_crashSafeCreates() {
  console.log("\n== 7.4b crash-safe upload + pull-create reclaim ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, JOB } = eng.constants;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  const rootName = "ERS-Verify-CrashCreate";
  await eng.store.setConfig({
    token: "mock",
    rootName,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  const root = await mock.createCollection(rootName, null);
  const bar = await mock.createCollection("Bookmarks bar", root._id);

  // Upload: Raindrop create succeeded, pair never written, intent left on job.
  const uploadUrl = "https://example.com/ers-verify-crash-upload";
  const bm = await chrome.bookmarks.create({
    parentId: "1",
    title: "crash upload",
    url: uploadUrl,
  });
  const orphanItem = mock._seedRich(bar._id, { link: uploadUrl, title: "crash upload" });
  await eng.queue.enqueue(bm.id);
  assert.equal(await eng.queue.patchJob(bm.id, { createAttemptedAt: Date.now() }), true);
  const createsBefore = mock._calls.createRaindrop;
  const sizeBefore = mock._raindrops.size;
  await eng.sync.drain();
  assert.equal(mock._calls.createRaindrop, createsBefore, "upload reclaim creates no raindrop");
  assert.equal(mock._raindrops.size, sizeBefore, "upload reclaim does not fork");
  assert.equal(
    await eng.store.getRaindropId(bm.id),
    String(orphanItem._id),
    "upload reclaim pairs to orphan raindrop"
  );
  assert.equal(await eng.queue.size(), 0, "upload reclaim job removed");

  // Pull-create: Edge bookmark created, pair never written, intent left on job.
  const pullUrl = "https://example.com/ers-verify-crash-pull";
  const pullItem = mock._seedRich(bar._id, { link: pullUrl, title: "crash pull" });
  const pullRid = String(pullItem._id);
  const orphanEdge = await chrome.bookmarks.create({
    parentId: "1",
    title: "crash pull",
    url: pullUrl,
  });
  const edgeCountBefore = [...bookmarks.values()].filter((n) => n.url).length;
  await eng.queue.enqueueJob({
    id: `pull-${pullRid}`,
    kind: JOB.PULL_CREATE,
    raindropId: pullRid,
    link: pullUrl,
    title: "crash pull",
    // Alias → Favorites bar (same parent as orphanEdge above).
    relativeSegments: ["Bookmarks bar"],
    collectionId: String(bar._id),
    pullCreateAttemptedAt: Date.now(),
  });
  await eng.sync.drain();
  const edgeCountAfter = [...bookmarks.values()].filter((n) => n.url).length;
  assert.equal(edgeCountAfter, edgeCountBefore, "pull reclaim creates no Edge bookmark");
  assert.equal(
    await eng.store.getBookmarkIdForRaindrop(pullRid),
    orphanEdge.id,
    "pull reclaim pairs to orphan Edge bookmark"
  );
  assert.equal(await eng.queue.size(), 0, "pull reclaim job removed");

  // Fresh upload still creates when no orphan exists.
  const freshUrl = "https://example.com/ers-verify-crash-fresh";
  const fresh = await chrome.bookmarks.create({
    parentId: "1",
    title: "fresh create",
    url: freshUrl,
  });
  await eng.queue.enqueue(fresh.id);
  const createsBeforeFresh = mock._calls.createRaindrop;
  await eng.sync.drain();
  assert.equal(mock._calls.createRaindrop, createsBeforeFresh + 1, "first create still POSTs");
  assert.ok(await eng.store.getRaindropId(fresh.id), "fresh create pairs");

  console.log("  ✔ createAttemptedAt / pullCreateAttemptedAt reclaim; fresh create still works");
}

async function scenario75_bulkDrainPauseAndResume() {
  console.log("\n== 7.5 Queue bulk prompt pauses drain + tick reconcile ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, QUEUE_BULK_PENDING_THRESHOLD, BULK_DRAIN_PAUSED_LOG } =
    eng.constants;
  const {
    getBulkPrompt,
    snoozeBulkPrompt,
    BULK_PROMPT_NEEDS_CHOICE,
    BULK_PROMPT_IDLE,
  } = eng.queueBulkPrompt;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-BulkPause",
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  await mock.createCollection("ERS-Verify-BulkPause", null);

  const bm = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS bulk pause real",
    url: "https://example.com/ers-bulk-pause",
  });
  const phantomIds = Array.from({ length: QUEUE_BULK_PENDING_THRESHOLD - 1 }, (_, i) => `phantom-bulk-${i}`);
  await eng.queue.enqueueMany(phantomIds);
  await eng.queue.enqueue(bm.id);
  assert.equal(await eng.queue.size(), QUEUE_BULK_PENDING_THRESHOLD);

  const armed = await getBulkPrompt();
  assert.equal(armed.status, BULK_PROMPT_NEEDS_CHOICE, "enqueue at threshold arms needs_choice");

  const pendingBefore = await eng.queue.size();
  const createBefore = mock._calls.createRaindrop;
  const listBefore = mock._calls.listRaindrops;
  const exportBefore = mock._calls.exportRaindropsCsv;

  await eng.sync.drain();
  assert.equal(mock._calls.createRaindrop, createBefore, "paused drain creates no raindrops");
  assert.equal(mock._raindrops.size, 0, "no raindrops while paused");
  assert.equal(await eng.queue.size(), pendingBefore, "jobs stay queued while paused");
  assert.equal((await getBulkPrompt()).status, BULK_PROMPT_NEEDS_CHOICE);

  let log = await eng.store.getLog();
  assert.ok(
    log.some((e) => e.message === BULK_DRAIN_PAUSED_LOG),
    "pause writes coalesced activity log line"
  );

  await eng.sync.drain();
  log = await eng.store.getLog();
  const pauseRows = log.filter((e) => e.message === BULK_DRAIN_PAUSED_LOG);
  assert.equal(pauseRows.length, 1, "second paused drain coalesces pause log");
  assert.ok(pauseRows[0].ats?.length >= 2, "second paused drain coalesces");

  await eng.sync.tick();
  assert.equal(
    mock._calls.listRaindrops,
    listBefore,
    "tick skips reconcile listing while needs_choice"
  );
  assert.equal(
    mock._calls.exportRaindropsCsv,
    exportBefore,
    "tick/drain never fetch export.csv"
  );
  assert.equal(
    (await eng.store.getStatus()).reconcileSkipReason,
    "bulk_pause",
    "tick stamps bulk_pause skip for Status"
  );

  // Live enqueue still allowed while paused
  const extra = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS while paused",
    url: "https://example.com/ers-bulk-while-paused",
  });
  await eng.queue.enqueue(extra.id);
  assert.ok((await eng.queue.size()) > pendingBefore, "live events may still enqueue");

  const snoozed = await snoozeBulkPrompt();
  assert.equal(snoozed.status, BULK_PROMPT_IDLE);
  assert.ok(snoozed.snoozedBelow != null);

  // Continue drip must not leave a stale bulk_pause line (or invent busy).
  await eng.sync.refreshReconcileSkipAfterBulkResume();
  assert.equal(
    (await eng.store.getStatus()).reconcileSkipReason,
    null,
    "after continue, skip is cleared even while Raindrop-bound jobs remain"
  );

  // Clear phantoms so one drain finishes the real upload (proves gate lift, not
  // full resume-under-150-load). clear() does not re-arm; snooze keeps idle.
  await eng.queue.clear();
  await eng.queue.enqueue(bm.id);
  assert.equal((await getBulkPrompt()).status, BULK_PROMPT_IDLE);

  await eng.sync.drain();
  assert.equal(mock._raindrops.size, 1, "after continue drip, upload proceeds");
  assert.ok(await eng.store.hasSynced(bm.id), "real bookmark paired after resume");

  console.log("  ✔ arm / pause drain+tick / coalesce log / continue drip resumes");
}

async function scenario76_applyMatchExistingAndImportSkip() {
  console.log("\n== 7.6 Match apply records pairs; Import skips matched ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE, KEY } = eng.constants;
  const { applyMatchExisting } = eng.matchExisting;
  const {
    resolveBulkPromptAfterMatch,
    BULK_PROMPT_NEEDS_CHOICE,
    BULK_PROMPT_IDLE,
    getBulkPrompt,
  } = eng.queueBulkPrompt;
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-MatchApply",
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const matchedBm = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS match me",
    url: "https://example.com/ers-match-apply",
  });
  const unpairedBm = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS still unpaired",
    url: "https://example.com/ers-match-unpaired",
  });
  const goneId = "bm-gone-stale";
  await eng.store.recordSynced(goneId, "77");

  const createBefore = mock._calls.createRaindrop;
  const deleteBefore = mock._calls.deleteRaindrop;
  const result = await applyMatchExisting([
    { bookmarkId: matchedBm.id, raindropId: "42" },
    { bookmarkId: goneId, raindropId: "99" }, // not in live Edge tree
    { bookmarkId: matchedBm.id, raindropId: "42" }, // duplicate in plan
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.paired, 1, "only live unambiguous rows recorded");
  assert.equal(await eng.store.getRaindropId(matchedBm.id), "42");
  assert.equal(await eng.store.getBookmarkIdForRaindrop("42"), matchedBm.id);
  assert.equal(mock._calls.createRaindrop, createBefore, "Match apply creates no raindrops");
  assert.equal(mock._calls.deleteRaindrop, deleteBefore, "Match apply deletes no raindrops");
  assert.equal(mock._raindrops.size, 0);

  // Conflict: already paired to different id — apply must not overwrite
  const conflicted = await applyMatchExisting([{ bookmarkId: matchedBm.id, raindropId: "999" }]);
  assert.equal(conflicted.paired, 0);
  assert.equal(await eng.store.getRaindropId(matchedBm.id), "42", "conflict does not overwrite");

  const scope = await eng.backfill.scanImportScope();
  assert.ok(!scope.unpairedIds.includes(matchedBm.id), "matched id not in Import unpaired");
  assert.ok(scope.unpairedIds.includes(unpairedBm.id), "unpaired still enqueueable");
  assert.ok(scope.paired >= 1);

  const { queued } = await eng.backfill.startBackfill();
  assert.equal(queued, 1, "Import enqueues only unpaired");
  assert.equal(await eng.queue.size(), 1);
  const jobs = await eng.queue.list();
  assert.equal(jobs[0].id, unpairedBm.id);

  // Post-Match resolve clears needs_choice (same as Continue drip)
  storage.set(KEY.BULK_PROMPT, { status: BULK_PROMPT_NEEDS_CHOICE, snoozedBelow: null });
  assert.equal((await getBulkPrompt()).status, BULK_PROMPT_NEEDS_CHOICE);
  storage.set(KEY.STATUS, {
    ...(storage.get(KEY.STATUS) || {}),
    reconcileSkipReason: "bulk_pause",
    reconcileSkipAt: Date.now(),
    reconcileSkipPending: 10,
  });
  const afterMatch = await resolveBulkPromptAfterMatch();
  assert.equal(afterMatch.status, BULK_PROMPT_IDLE);
  await eng.sync.refreshReconcileSkipAfterBulkResume();
  assert.notEqual(
    (await eng.store.getStatus()).reconcileSkipReason,
    "bulk_pause",
    "Match resume clears stale bulk_pause skip"
  );
  assert.ok(afterMatch.snoozedBelow != null);

  console.log("  ✔ apply pairs only; Import skip; resolveBulkPromptAfterMatch snoozes");
}

async function scenario77_scanImportScopeAndPullBulkGate() {
  console.log("\n== 7.7 scanImportScope exclude/pair rules + Pull one-way gate ==");
  const eng = await importEngine();
  const { POLICY, SYNC_MODE } = eng.constants;
  await resetAll(eng.store);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-Scope",
    syncMode: SYNC_MODE.ONE_WAY,
    defaultPolicy: POLICY.SYNC_KEEP,
  });

  const excl = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS-Scope-Exclude",
  });
  await eng.store.setOverride(excl.id, POLICY.EXCLUDE, "Favorites bar / ERS-Scope-Exclude");
  await chrome.bookmarks.create({
    parentId: excl.id,
    title: "secret",
    url: "https://example.com/ers-scope-excluded",
  });
  const keep = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS scope keep",
    url: "https://example.com/ers-scope-keep",
  });
  const paired = await chrome.bookmarks.create({
    parentId: "1",
    title: "ERS scope paired",
    url: "https://example.com/ers-scope-paired",
  });
  await eng.store.recordSynced(paired.id, "555");

  const scope = await eng.backfill.scanImportScope();
  assert.equal(
    scope.unpairedIds.includes(keep.id),
    true,
    "non-excluded unpaired is in Import scope"
  );
  assert.equal(
    scope.unpairedIds.includes(paired.id),
    false,
    "already paired excluded from unpairedIds"
  );
  const excludedBm = [...bookmarks.values()].find(
    (n) => n.url === "https://example.com/ers-scope-excluded"
  );
  assert.ok(excludedBm);
  assert.equal(scope.unpairedIds.includes(excludedBm.id), false, "exclude not in unpaired");
  assert.equal(scope.paired, 1);
  assert.ok(scope.edgeScanned >= 3, "edgeScanned counts URL bookmarks in tree");

  const pullOneWay = await eng.bulkCandidate.assessPullBulkCandidate();
  assert.equal(pullOneWay.suggest, false, "Pull bulk gate off in one-way");
  assert.equal(pullOneWay.edgeScanned, 0);

  await eng.store.setConfig({
    token: "mock",
    rootName: "ERS-Verify-Scope",
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
  });
  // Small library: should not suggest on Pull either
  const pullSmall = await eng.bulkCandidate.assessPullBulkCandidate();
  assert.equal(pullSmall.suggest, false, "small bidirectional library skips Pull bulk prompt");
  assert.ok(pullSmall.edgeScanned >= 3);

  console.log("  ✔ scanImportScope matches Import rules; Pull one-way never suggests");
}

async function main() {
  console.log(
    `Mode: ${USE_LIVE ? "mock Edge + live Raindrop (ERS-Verify-* only)" : "fully mocked (no real Edge/Raindrop writes)"}`
  );
  console.log("Edge: in-memory disposable tree only (Favorites bar / Other favorites).");

  await scenario62_oneWay();
  await scenario63_bidirectional();
  await scenario64_syncAndDelete();
  await scenario65_exclude();
  await scenario66_raindropFolderModes();
  await scenario67_raindropFolderAllowlist();
  await scenario68_rateLimitBudget();
  await scenario68b_trashFastPath();
  await scenario68e_trashSafeStatus();
  await scenario68c_parkOutOfScopeAlives();
  await scenario68d_pullNowWaitAndResume();
  await scenario69_bookmarkMoves();
  await scenario70_onChangedAndFolderRename();
  await scenario71_tombstonePruneAndPullUpdate();
  await scenario72_deadLetterAndStorage();
  await scenario73_coalesceActivityLog();
  await scenario74_offloadResumeAndCreateSuppress();
  await scenario74b_crashSafeCreates();
  await scenario75_bulkDrainPauseAndResume();
  await scenario76_applyMatchExistingAndImportSkip();
  await scenario77_scanImportScopeAndPullBulkGate();
  await optionalLiveSmoke();

  console.log("\nAll checklist scenarios passed.");
}

main().catch(async (err) => {
  console.error("\nVERIFY FAILED:", err);
  if (USE_LIVE) await liveCleanup();
  process.exit(1);
});
