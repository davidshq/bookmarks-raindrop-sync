#!/usr/bin/env node
// Offline unit checks for pure sync helpers (no Raindrop token / Edge / chrome).
// Imports the real src/lib modules — do not reimplement algorithms here.
// Run: node scripts/verify-bidirectional-logic.mjs
// Or:  npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePolicy, isExcluded } from "../src/lib/policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
import {
  collectionPathFromRoot,
  collectionIdAlive,
  ensureCollectionPath,
  collectionsUnderRoot,
  collectionIdFromRelative,
  collectionAbsolutePath,
  mirrorRelativeSegments,
  collectionsForAllowlistPicker,
  raindropUploadSegments,
} from "../src/lib/collections.js";
import {
  jobKind,
  drainJobPriority,
  jobDirection,
  countByDirection,
  formatPendingByDirection,
} from "../src/lib/queue.js";
import {
  POLICY,
  JOB,
  DEFAULT_CONFIG,
  RAINDROP_FOLDER_MODE,
  SYNC_MODE,
  LOG_LIMIT,
  LOG_ARCHIVE_LIMIT,
  DEFAULT_RECONCILE_INTERVAL_MINUTES,
  MIN_RECONCILE_INTERVAL_MINUTES,
  MAX_RECONCILE_INTERVAL_MINUTES,
  reconcileIntervalMs,
} from "../src/lib/constants.js";
import { normalizeConfig, clampReconcileIntervalMinutes } from "../src/lib/store.js";
import { runPullNow } from "../src/lib/pull-now.js";
import {
  isAllowlistActive,
  isCollectionAllowed,
  isInScopedListing,
  canCreateRaindropOnlyPath,
  pruneAllowlist,
} from "../src/lib/allowlist.js";
import {
  rootRole,
  canonicalRootTitle,
  rootTitlesEqual,
  canonicalizeUploadSegments,
  CANONICAL_TOOLBAR,
  CANONICAL_OTHER,
  DEFAULT_ROOT_NAME,
} from "../src/lib/bookmark-roots.js";

console.log("== canonical bookmark roots ==");
{
  assert.equal(rootRole("Favorites bar"), "toolbar");
  assert.equal(rootRole("Bookmarks bar"), "toolbar");
  assert.equal(rootRole("Other favorites"), "other");
  assert.equal(rootRole("Other bookmarks"), "other");
  assert.equal(rootRole("Work"), null);
  assert.equal(canonicalRootTitle("Favorites bar"), CANONICAL_TOOLBAR);
  assert.equal(canonicalRootTitle("Other favorites"), CANONICAL_OTHER);
  assert.equal(rootTitlesEqual("Favorites bar", "Bookmarks bar"), true);
  assert.equal(rootTitlesEqual("Favorites bar", "Other favorites"), false);
  assert.deepEqual(canonicalizeUploadSegments(["Favorites bar", "Work"]), [
    CANONICAL_TOOLBAR,
    "Work",
  ]);
  assert.equal(DEFAULT_CONFIG.rootName, DEFAULT_ROOT_NAME);
  console.log("  ✔ roles, aliases, upload canonicalize, default root");
}

console.log("== roots migration (mock client) ==");
{
  const { migrateLegacyRaindropRoots } = await import("../src/lib/migrate-roots.js");
  const harness = await import("./lib/test-harness.mjs");
  harness.storage.clear();
  harness.seedEdge();
  harness.installChromeMocks();
  const { setConfig, getConfig, getCollectionCache } = await import("../src/lib/store.js");
  await setConfig({ token: "mock", rootName: "Edge" });
  // Ensure migration flag is absent for this run.
  const stored = await chrome.storage.local.get("config");
  delete stored.config.rootsMigratedAt;
  await chrome.storage.local.set({ config: stored.config });
  await chrome.storage.local.set({
    collectionCache: {
      Edge: 1,
      "Edge/Favorites bar": 2,
      "Edge/Favorites bar/Work": 3,
    },
  });

  const cols = new Map([
    [1, { _id: 1, title: "Edge", parent: null }],
    [2, { _id: 2, title: "Favorites bar", parent: { $id: 1 } }],
    [3, { _id: 3, title: "Work", parent: { $id: 2 } }],
  ]);
  const client = {
    async getRootCollections() {
      return [...cols.values()].filter((c) => !c.parent);
    },
    async getChildCollections() {
      return [...cols.values()].filter((c) => c.parent);
    },
    async updateCollection(id, { title }) {
      const c = cols.get(Number(id));
      c.title = title;
      return c;
    },
  };

  const first = await migrateLegacyRaindropRoots(client);
  assert.equal(first.ran, true);
  assert.ok(first.renamed.some((r) => r.includes("Bookmarks")));
  assert.equal(cols.get(1).title, "Bookmarks");
  assert.equal(cols.get(2).title, "Bookmarks bar");
  const cfg = await getConfig();
  assert.equal(cfg.rootName, "Bookmarks");
  assert.ok(cfg.rootsMigratedAt);
  const cache = await getCollectionCache();
  assert.equal(cache.Bookmarks, 1);
  assert.equal(cache["Bookmarks/Bookmarks bar"], 2);

  const second = await migrateLegacyRaindropRoots(client);
  assert.equal(second.ran, false, "second pass is no-op");
  console.log("  ✔ rename Edge/Favorites → Bookmarks/Bookmarks bar + cache rewrite");

  // Conflict: both Edge and Bookmarks exist — must not set rootsMigratedAt.
  harness.storage.clear();
  harness.seedEdge();
  await setConfig({ token: "mock", rootName: "Edge" });
  const stored2 = await chrome.storage.local.get("config");
  delete stored2.config.rootsMigratedAt;
  await chrome.storage.local.set({ config: stored2.config });
  const conflictCols = new Map([
    [1, { _id: 1, title: "Edge", parent: null }],
    [10, { _id: 10, title: "Bookmarks", parent: null }],
    [2, { _id: 2, title: "Favorites bar", parent: { $id: 1 } }],
  ]);
  const conflictClient = {
    async getRootCollections() {
      return [...conflictCols.values()].filter((c) => !c.parent);
    },
    async getChildCollections() {
      return [...conflictCols.values()].filter((c) => c.parent);
    },
    async updateCollection(id, { title }) {
      const c = conflictCols.get(Number(id));
      c.title = title;
      return c;
    },
  };
  const blocked = await migrateLegacyRaindropRoots(conflictClient);
  assert.equal(blocked.blocked, true);
  assert.equal(conflictCols.get(1).title, "Edge", "root not renamed on conflict");
  const cfgBlocked = await getConfig();
  assert.equal(cfgBlocked.rootName, "Edge");
  assert.equal(cfgBlocked.rootsMigratedAt, undefined);
  console.log("  ✔ conflict leaves flag unset for retry");

  // Partial: root renamed, child conflict — bump rootName, leave flag unset.
  harness.storage.clear();
  harness.seedEdge();
  await setConfig({ token: "mock", rootName: "Edge" });
  const stored3 = await chrome.storage.local.get("config");
  delete stored3.config.rootsMigratedAt;
  await chrome.storage.local.set({ config: stored3.config });
  const partialCols = new Map([
    [1, { _id: 1, title: "Edge", parent: null }],
    [2, { _id: 2, title: "Favorites bar", parent: { $id: 1 } }],
    [3, { _id: 3, title: "Bookmarks bar", parent: { $id: 1 } }],
  ]);
  const partialClient = {
    async getRootCollections() {
      return [...partialCols.values()].filter((c) => !c.parent);
    },
    async getChildCollections() {
      return [...partialCols.values()].filter((c) => c.parent);
    },
    async updateCollection(id, { title }) {
      const c = partialCols.get(Number(id));
      c.title = title;
      return c;
    },
  };
  const partial = await migrateLegacyRaindropRoots(partialClient);
  assert.equal(partial.blocked, true);
  assert.equal(partialCols.get(1).title, "Bookmarks");
  const cfgPartial = await getConfig();
  assert.equal(cfgPartial.rootName, "Bookmarks");
  assert.ok(!cfgPartial.rootsMigratedAt);
  console.log("  ✔ partial root rename persists rootName for retry");
}

console.log("== mirror placement aliases ==");
{
  const harness = await import("./lib/test-harness.mjs");
  harness.storage.clear();
  harness.seedEdge();
  harness.installChromeMocks();
  const { resolveMirrorPlacement } = await import("../src/lib/bookmarks.js");
  const tops = await chrome.bookmarks.getChildren("0");
  const edgePlan = await resolveMirrorPlacement(["Bookmarks bar", "Work"], "Bookmarks", tops);
  assert.equal(edgePlan.startId, "1", "canonical bar → Favorites bar root");
  assert.deepEqual(edgePlan.titles, ["Work"]);
  harness.seedChrome();
  const chromeTops = await chrome.bookmarks.getChildren("0");
  const chromePlan = await resolveMirrorPlacement(
    ["Bookmarks bar", "Work"],
    "Bookmarks",
    chromeTops
  );
  assert.equal(chromePlan.startId, "1");
  assert.deepEqual(chromePlan.titles, ["Work"]);
  console.log("  ✔ Bookmarks bar lands on Edge Favorites bar and Chrome Bookmarks bar");
}

console.log("== policy resolution ==");
{
  const overrides = {
    work: { policy: POLICY.SYNC_KEEP },
    secrets: { policy: POLICY.EXCLUDE },
  };
  assert.equal(resolvePolicy(["secrets", "work"], overrides, POLICY.SYNC_DELETE), POLICY.EXCLUDE);
  assert.equal(resolvePolicy(["archive", "work"], overrides, POLICY.SYNC_DELETE), POLICY.SYNC_KEEP);
  assert.equal(resolvePolicy(["misc"], overrides, POLICY.SYNC_DELETE), POLICY.SYNC_DELETE);
  assert.equal(isExcluded(["secrets", "work"], overrides, POLICY.SYNC_DELETE), true);
  assert.equal(isExcluded(["archive", "work"], overrides, POLICY.SYNC_DELETE), false);
  console.log("  ✔ nearest-ancestor + exclude");
}

console.log("== raindropFolderMode default ==");
{
  assert.equal(
    DEFAULT_CONFIG.raindropFolderMode,
    RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    "default preserves create-as-needed"
  );
  console.log("  ✔ default create-as-needed");
}

console.log("== bidirectional coerces global keep-both ==");
{
  const coerced = normalizeConfig({
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_DELETE,
  });
  assert.equal(coerced.defaultPolicy, POLICY.SYNC_KEEP);
  const oneWay = normalizeConfig({
    syncMode: SYNC_MODE.ONE_WAY,
    defaultPolicy: POLICY.SYNC_DELETE,
  });
  assert.equal(oneWay.defaultPolicy, POLICY.SYNC_DELETE, "one-way offload unchanged");
  console.log("  ✔ stale bidirectional offload → keep-both");
}

console.log("== pull now loop ==");
{
  let calls = 0;
  const finished = await runPullNow(async () => {
    calls++;
    if (calls < 3) return { ok: true, done: false, enqueued: 1 };
    return { ok: true, done: true, enqueued: 2 };
  });
  assert.equal(calls, 3, "keeps scanning until done");
  assert.equal(finished.totalQueued, 4);
  assert.match(finished.text, /Pull finished: queued 4/);

  const capped = await runPullNow(async () => ({ ok: true, done: false, enqueued: 0 }));
  assert.match(capped.text, /Manual Sync/);
  assert.doesNotMatch(capped.text, /Settings/);
  console.log("  ✔ popup and options share the pass loop");
}

console.log("== collection path under root ==");
{
  const byId = new Map();
  const root = { _id: 1, title: "Edge", parent: null };
  const bar = { _id: 2, title: "Favorites bar", parent: { $id: 1 } };
  const work = { _id: 3, title: "Work", parent: { $id: 2 } };
  const other = { _id: 9, title: "Elsewhere", parent: null };
  for (const c of [root, bar, work, other]) {
    byId.set(c._id, c);
    byId.set(String(c._id), c);
  }
  const index = { byId };
  assert.deepEqual(collectionPathFromRoot(index, 3, 1), ["Edge", "Favorites bar", "Work"]);
  assert.deepEqual(collectionPathFromRoot(index, 9, 1), []);

  const under = collectionsUnderRoot(index, 1);
  assert.equal(under.length, 3, "root + bar + work");
  assert.ok(under.some((u) => u.relativeSegments.join("/") === "Favorites bar/Work"));
  assert.ok(
    under.some((u) => u.relativeSegments.length === 0),
    "includes root with empty relative"
  );
  console.log("  ✔ path under root / outside root / collectionsUnderRoot");
}

console.log("== collection cache vs live index ==");
{
  const byParent = new Map();
  const byId = new Map();
  const root = { _id: 1, title: "Edge", parent: null };
  byParent.set("root", new Map([["edge", root]]));
  byId.set(1, root);
  byId.set("1", root);
  const index = { byParent, byId };

  assert.equal(collectionIdAlive(index, 1), true);
  assert.equal(collectionIdAlive(index, 999), false);

  const created = [];
  const client = {
    async createCollection(title, parentId) {
      const col = { _id: 50, title, parent: parentId != null ? { $id: parentId } : null };
      created.push(col);
      return col;
    },
  };
  const cache = { Edge: 999 }; // stale — id 999 not in index
  const uncached = [];
  const id = await ensureCollectionPath(
    client,
    index,
    ["Edge"],
    cache,
    async () => {},
    async (path) => uncached.push(path)
  );
  assert.equal(id, 1, "match existing live collection by title, not stale cache");
  assert.deepEqual(uncached, ["Edge"]);
  assert.equal(created.length, 0, "must not create a duplicate root");
  assert.equal(cache.Edge, 1);
  console.log("  ✔ stale cache dropped; title match reused");
}

console.log("== job kind defaults ==");
{
  assert.equal(jobKind({ id: "1" }), JOB.UPLOAD);
  assert.equal(jobKind({ id: "pull-9", kind: JOB.PULL_CREATE }), JOB.PULL_CREATE);
  assert.ok(
    drainJobPriority(JOB.RENAME_COLLECTION) < drainJobPriority(JOB.UPLOAD),
    "rename-collection drains before upload"
  );
  assert.ok(
    drainJobPriority(JOB.PULL_RENAME_FOLDER) < drainJobPriority(JOB.PULL_UPDATE),
    "pull-rename-folder drains before pull-update"
  );
  assert.equal(drainJobPriority(JOB.UPLOAD), drainJobPriority(JOB.PULL_CREATE));
  console.log("  ✔ legacy jobs are upload; rename before upload");
}

console.log("== pending direction breakdown ==");
{
  assert.equal(jobDirection(JOB.UPLOAD), "edgeToRaindrop");
  assert.equal(jobDirection(JOB.DELETE_RAINDROP), "edgeToRaindrop");
  assert.equal(jobDirection(JOB.RENAME_COLLECTION), "edgeToRaindrop");
  assert.equal(jobDirection(JOB.PULL_CREATE), "raindropToEdge");
  assert.equal(jobDirection(JOB.PULL_UPDATE), "raindropToEdge");
  assert.equal(jobDirection(JOB.PULL_RENAME_FOLDER), "raindropToEdge");
  assert.equal(jobDirection(JOB.DELETE_EDGE), "raindropToEdge");
  // Legacy jobs without kind follow upload → Edge→Raindrop.
  assert.equal(jobDirection(jobKind({ id: "legacy" })), "edgeToRaindrop");

  const counts = countByDirection([
    { id: "a" },
    { id: "b", kind: JOB.UPLOAD },
    { id: "c", kind: JOB.PULL_CREATE },
    { id: "d", kind: JOB.DELETE_EDGE },
    { id: "e", kind: JOB.RENAME_COLLECTION },
  ]);
  assert.deepEqual(counts, { total: 5, edgeToRaindrop: 3, raindropToEdge: 2 });
  assert.equal(
    formatPendingByDirection(counts),
    "Edge → Raindrop: 3 · Raindrop → Edge: 2"
  );

  const optionsHtml = fs.readFileSync(
    path.join(REPO_ROOT, "src/options/options.html"),
    "utf8"
  );
  assert.ok(
    optionsHtml.includes('id="pendingByDirection"'),
    "Options Status exposes pendingByDirection"
  );
  const popupHtml = fs.readFileSync(
    path.join(REPO_ROOT, "src/popup/popup.html"),
    "utf8"
  );
  assert.ok(
    popupHtml.includes('id="pendingByDirection"'),
    "popup exposes pendingByDirection"
  );
  console.log("  ✔ Edge→Raindrop vs Raindrop→Edge counts + Status markup");
}

console.log("== raindrop folder allowlist ==");
{
  assert.deepEqual(DEFAULT_CONFIG.raindropFolderAllowlist, {});
  assert.equal(DEFAULT_CONFIG.keepLongTermLog, false);
  assert.equal(LOG_LIMIT, 500);
  assert.equal(LOG_ARCHIVE_LIMIT, 50_000);
  assert.equal(normalizeConfig({ keepLongTermLog: 1 }).keepLongTermLog, true);
  assert.equal(normalizeConfig({}).keepLongTermLog, false);
  assert.equal(isAllowlistActive({}), false);
  assert.equal(isAllowlistActive(null), false);
  assert.equal(isAllowlistActive({ 3: { path: "Work" } }), true);

  const byId = new Map();
  const byParent = new Map();
  const root = { _id: 1, title: "Edge", parent: null };
  const bar = { _id: 2, title: "Favorites bar", parent: { $id: 1 } };
  const work = { _id: 3, title: "Work", parent: { $id: 2 } };
  const nested = { _id: 4, title: "Nested", parent: { $id: 3 } };
  // Account-level collection outside the sync root.
  const indie = { _id: 20, title: "Indie", parent: null };
  const indieChild = { _id: 21, title: "Child", parent: { $id: 20 } };
  for (const c of [root, bar, work, nested, indie, indieChild]) {
    byId.set(c._id, c);
    byId.set(String(c._id), c);
  }
  byParent.set(
    "root",
    new Map([
      ["edge", root],
      ["indie", indie],
    ])
  );
  byParent.set(1, new Map([["favorites bar", bar]]));
  byParent.set(2, new Map([["work", work]]));
  byParent.set(3, new Map([["nested", nested]]));
  byParent.set(20, new Map([["child", indieChild]]));
  const index = { byId, byParent };

  assert.equal(isCollectionAllowed(4, index, 1, { 3: { path: "Work" } }), true, "parent covers");
  assert.equal(isCollectionAllowed(4, index, 1, { 9: { path: "Other" } }), false);
  assert.equal(isCollectionAllowed(4, index, 1, {}), false, "empty allowlist → not allowed");
  assert.equal(
    isCollectionAllowed(21, index, 1, { 20: { path: "Indie" } }),
    true,
    "outside-root parent covers"
  );
  assert.equal(isInScopedListing(4, index, 1, {}), true, "under sync root is in scoped listing");
  assert.equal(
    isInScopedListing(21, index, 1, {}),
    false,
    "outside-root without allowlist is out of scope"
  );
  assert.equal(
    isInScopedListing(21, index, 1, { 20: { path: "Indie" } }),
    true,
    "outside-root allowlisted is in scoped listing"
  );
  assert.deepEqual(collectionAbsolutePath(index, 21), ["Indie", "Child"]);
  assert.deepEqual(mirrorRelativeSegments(index, 21, 1), ["Raindrop", "Indie", "Child"]);
  assert.deepEqual(mirrorRelativeSegments(index, 4, 1), ["Favorites bar", "Work", "Nested"]);
  // Outside-root name colliding with Edge top still prefixes Raindrop container.
  const fakeBar = { _id: 30, title: "Favorites bar", parent: null };
  byId.set(30, fakeBar);
  byId.set("30", fakeBar);
  byParent.get("root").set("favorites bar", fakeBar);
  assert.deepEqual(mirrorRelativeSegments(index, 30, 1), ["Raindrop", "Favorites bar"]);
  assert.deepEqual(
    raindropUploadSegments(["Other favorites", "Raindrop", "Indie", "Child"], "Bookmarks"),
    ["Indie", "Child"],
    "outside-root path uploads to account-level collection"
  );
  assert.deepEqual(
    raindropUploadSegments(["Favorites bar", "Work"], "Bookmarks"),
    ["Bookmarks", "Bookmarks bar", "Work"],
    "under-root path nests under sync root with canonical bar title"
  );
  assert.deepEqual(
    raindropUploadSegments(["Bookmarks bar", "Work"], "Bookmarks"),
    ["Bookmarks", "Bookmarks bar", "Work"],
    "Chrome bar title stays canonical"
  );
  assert.deepEqual(
    raindropUploadSegments(["Other favorites", "Raindrop"], "Bookmarks"),
    ["Bookmarks", "Other bookmarks", "Raindrop"],
    "bare Raindrop container falls back under sync root with canonical other"
  );
  assert.equal(rootRole("Other"), null, "bare Other is not a top-root alias");
  assert.deepEqual(
    raindropUploadSegments(["Other", "Raindrop", "Indie"], "Bookmarks"),
    ["Bookmarks", "Other", "Raindrop", "Indie"],
    "bare Other is not outside-root landing"
  );
  const picker = collectionsForAllowlistPicker(index, 1);
  assert.ok(picker.some((p) => p.collectionId === 20 && !p.underSyncRoot));
  assert.ok(picker.some((p) => p.collectionId === 4 && p.underSyncRoot));
  assert.equal(
    canCreateRaindropOnlyPath({
      allowlist: { 20: { path: "Indie" } },
      collectionId: 21,
      index,
      rootId: 1,
      edgePathExists: false,
      folderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
    }),
    true,
    "outside-root allowlisted may create"
  );
  assert.equal(
    collectionIdFromRelative(index, 1, ["Favorites bar", "Work", "Nested"]),
    4,
    "resolve path → id"
  );
  assert.equal(collectionIdFromRelative(index, 1, ["Missing"]), null);

  assert.equal(
    canCreateRaindropOnlyPath({
      allowlist: {},
      collectionId: 4,
      index,
      rootId: 1,
      edgePathExists: false,
      folderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    }),
    true,
    "empty allowlist + create-as-needed"
  );
  assert.equal(
    canCreateRaindropOnlyPath({
      allowlist: {},
      collectionId: 4,
      index,
      rootId: 1,
      edgePathExists: false,
      folderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
    }),
    false,
    "empty allowlist + existing-only blocks"
  );
  assert.equal(
    canCreateRaindropOnlyPath({
      allowlist: { 3: { path: "Work" } },
      collectionId: 4,
      index,
      rootId: 1,
      edgePathExists: false,
      folderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
    }),
    true,
    "allowlisted via parent"
  );
  assert.equal(
    canCreateRaindropOnlyPath({
      allowlist: { 3: { path: "Work" } },
      collectionId: 99,
      index,
      rootId: 1,
      edgePathExists: false,
      folderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
    }),
    false,
    "active allowlist skips unchecked"
  );
  assert.equal(
    canCreateRaindropOnlyPath({
      allowlist: { 3: { path: "Work" } },
      collectionId: 99,
      index,
      rootId: 1,
      edgePathExists: true,
      folderMode: RAINDROP_FOLDER_MODE.EXISTING_ONLY,
    }),
    true,
    "Edge path exists bypasses allowlist"
  );

  const mirrored = new Set(["Favorites bar", "Favorites bar/Work", "Favorites bar/Work/Nested"]);
  const prunedGone = await pruneAllowlist(
    { 3: { path: "Work" }, 99: { path: "Gone" } },
    index,
    1,
    async (rel) => mirrored.has(rel.join("/"))
  );
  assert.equal(prunedGone.removed, 1, "missing Raindrop ids pruned");
  assert.deepEqual(prunedGone.allowlist, { 3: { path: "Work" } }, "fully mirrored ids kept");

  const prunedKeep = await pruneAllowlist(
    { 3: { path: "Work" } },
    index,
    1,
    async (rel) => rel.join("/") === "Favorites bar/Work" // Nested still missing
  );
  assert.equal(prunedKeep.removed, 0, "keep while collection still in Raindrop");
  assert.ok(prunedKeep.allowlist["3"]);

  const normalized = normalizeConfig({ token: "x" });
  assert.deepEqual(normalized.raindropFolderAllowlist, {});
  console.log("  ✔ active/parent/empty-mode/Edge-bypass/prune/path-resolve/outside-root");
}

console.log("== outside-root forest list ids ==");
{
  const { outsideRootListIds } = await import("../src/lib/reconcile.js");
  const byId = new Map();
  const syncRoot = { _id: 1, title: "Edge", parent: null };
  const indie = { _id: 10, title: "Indie", parent: null };
  const child = { _id: 11, title: "Child", parent: { $id: 10 } };
  const other = { _id: 20, title: "Other", parent: null };
  for (const c of [syncRoot, indie, child, other]) {
    byId.set(c._id, c);
    byId.set(String(c._id), c);
  }
  const index = { byId };
  const ids = outsideRootListIds(
    {
      10: { path: "Indie" },
      11: { path: "Indie/Child" },
      20: { path: "Other" },
      1: { path: "Edge" },
    },
    index,
    1
  );
  assert.deepEqual(
    ids.sort(),
    ["10", "20"],
    "skips sync-root member and child when parent allowlisted"
  );
  console.log("  ✔ forest roots only");
}

console.log("== reconcile interval config ==");
{
  assert.equal(DEFAULT_CONFIG.reconcileIntervalMinutes, DEFAULT_RECONCILE_INTERVAL_MINUTES);
  assert.equal(DEFAULT_RECONCILE_INTERVAL_MINUTES, 1);
  assert.equal(clampReconcileIntervalMinutes(undefined), 1);
  assert.equal(clampReconcileIntervalMinutes("nope"), 1);
  assert.equal(clampReconcileIntervalMinutes(0), MIN_RECONCILE_INTERVAL_MINUTES);
  assert.equal(clampReconcileIntervalMinutes(99), MAX_RECONCILE_INTERVAL_MINUTES);
  assert.equal(normalizeConfig({}).reconcileIntervalMinutes, 1);
  assert.equal(normalizeConfig({ reconcileIntervalMinutes: 15 }).reconcileIntervalMinutes, 15);
  assert.equal(normalizeConfig({ reconcileIntervalMinutes: 1 }).reconcileIntervalMinutes, 1);
  assert.equal(reconcileIntervalMs({ reconcileIntervalMinutes: 2 }), 2 * 60_000);
  console.log("  ✔ default / clamp / reconcileIntervalMs");
}

console.log("== rate-limit constants ==");
{
  const {
    RATE_LIMIT_RESERVE: reserve,
    BOOTSTRAP_REQS,
    SOFT_MAX_REQS_PER_WAKE,
    SOFT_MAX_DRAIN_JOBS_PER_WAKE,
    MAX_ALIVE_CHECKS_PER_TICK,
    MAX_JOBS_PER_DRAIN,
    MAX_JOBS_PER_DRAIN_BUSY,
    DRAIN_BUSY_PENDING_THRESHOLD,
    drainJobsCap,
    MAX_RECONCILE_PAGES_PER_TICK,
    MAX_TRASH_PAGES_PER_TICK,
    RAINDROP_TRASH_COLLECTION_ID,
  } = await import("../src/lib/constants.js");
  assert.ok(reserve >= 1);
  assert.ok(reserve <= 8);
  assert.ok(BOOTSTRAP_REQS >= 1 && BOOTSTRAP_REQS < SOFT_MAX_REQS_PER_WAKE);
  assert.ok(SOFT_MAX_DRAIN_JOBS_PER_WAKE >= MAX_JOBS_PER_DRAIN_BUSY);
  assert.ok(MAX_ALIVE_CHECKS_PER_TICK > 8, "confirm soft backstop above legacy primary 8");
  assert.ok(MAX_JOBS_PER_DRAIN >= 1);
  assert.ok(MAX_JOBS_PER_DRAIN_BUSY > MAX_JOBS_PER_DRAIN);
  assert.equal(drainJobsCap(0), MAX_JOBS_PER_DRAIN);
  assert.equal(drainJobsCap(DRAIN_BUSY_PENDING_THRESHOLD - 1), MAX_JOBS_PER_DRAIN);
  assert.equal(drainJobsCap(DRAIN_BUSY_PENDING_THRESHOLD), MAX_JOBS_PER_DRAIN_BUSY);
  assert.ok(MAX_RECONCILE_PAGES_PER_TICK >= 1);
  assert.ok(MAX_TRASH_PAGES_PER_TICK >= 1);
  assert.equal(RAINDROP_TRASH_COLLECTION_ID, -99);
  assert.ok(reconcileIntervalMs(DEFAULT_CONFIG) >= 60_000);
  const { RateLimitError, raindropCollectionId } = await import("../src/lib/raindrop.js");
  const err = new RateLimitError(Date.now() + 1000, { proactive: true });
  assert.equal(err.proactive, true);
  assert.equal(raindropCollectionId({ collection: { $id: 42 } }), 42);
  assert.equal(raindropCollectionId({ collection: { id: 7 } }), 7);
  assert.equal(raindropCollectionId({ collection: { $id: 1, id: 2 } }), 1);
  assert.equal(raindropCollectionId(null), undefined);
  console.log("  ✔ reserve / wake budget constants / short drain caps / proactive RateLimitError");
}

console.log("== wake budget spendable / self-cap ==");
{
  // chrome.storage mock for persist-window / lastThrottle helpers
  await import("./lib/test-harness.mjs");
  const { BOOTSTRAP_REQS, SHORT_WAKE_REQS, SOFT_MAX_REQS_PER_WAKE } = await import(
    "../src/lib/constants.js"
  );
  assert.ok(SHORT_WAKE_REQS > BOOTSTRAP_REQS);
  const {
    WakeBudget,
    formatLastThrottleNotice,
    loadPersistedRateWindow,
  } = await import("../src/lib/wake-budget.js");
  const { setStatus, getStatus, noteRateLimitedUntil, clearRateLimit } = await import(
    "../src/lib/store.js"
  );

  const boot = new WakeBudget({
    mode: "full",
    headerRemaining: null,
    headerResetAt: null,
    wakeCapReqs: SOFT_MAX_REQS_PER_WAKE,
  });
  assert.equal(boot.allowance(), BOOTSTRAP_REQS);
  for (let i = 0; i < BOOTSTRAP_REQS; i++) boot.noteRequest(null);
  assert.equal(boot.allowance(), 0);
  assert.equal(boot.consumeSelfCapReason(), "bootstrap");
  assert.ok(formatLastThrottleNotice({ lastThrottle: "bootstrap", rateLimitedUntil: null }));

  const rich = new WakeBudget({
    mode: "full",
    headerRemaining: 100,
    headerResetAt: Date.now() + 60_000,
  });
  assert.ok(rich.allowance() > 25, "header spendable exceeds legacy drain primary 25");
  assert.ok(rich.allowance() > 8, "header spendable exceeds legacy confirm primary 8");
  // Soft wake cap still binds.
  const capped = new WakeBudget({
    mode: "full",
    headerRemaining: 100,
    headerResetAt: Date.now() + 60_000,
    wakeCapReqs: 3,
  });
  capped.noteRequest({ remaining: 99, resetAt: Date.now() + 60_000 });
  capped.noteRequest({ remaining: 98, resetAt: Date.now() + 60_000 });
  capped.noteRequest({ remaining: 97, resetAt: Date.now() + 60_000 });
  assert.equal(capped.allowance(), 0);
  assert.equal(capped.consumeSelfCapReason(), "wake_cap");
  assert.ok(formatLastThrottleNotice({ lastThrottle: "wake_cap" })?.includes("wake"));
  assert.equal(
    formatLastThrottleNotice({
      lastThrottle: "wake_cap",
      rateLimitedUntil: Date.now() + 60_000,
    }),
    null,
    "active Raindrop pause hides self-cap copy"
  );

  await setStatus({
    rateRemaining: 80,
    rateResetAt: Date.now() + 120_000,
    rateObservedAt: Date.now(),
  });
  const win = await loadPersistedRateWindow();
  assert.equal(win.remaining, 80);
  await setStatus({ rateResetAt: Date.now() - 1 });
  const stale = await loadPersistedRateWindow();
  assert.equal(stale.remaining, null, "stale reset → bootstrap");

  await clearRateLimit();
  await setStatus({ lastThrottle: "wake_cap" });
  await noteRateLimitedUntil(Date.now() + 30_000);
  assert.equal((await getStatus()).lastThrottle, null, "real pause clears self-cap note");
  await clearRateLimit();
  console.log("  ✔ bootstrap / spendable / wake_cap / persist window / Status copy");
}

console.log("== bulk candidate heuristics ==");
{
  const { assessFromScope, assessPullFromScope, formatBulkCandidatePrompt } = await import(
    "../src/lib/bulk-candidate.js"
  );
  const { BULK_UNPAIRED_IMPORT_THRESHOLD, BULK_EDGE_COUNT_THRESHOLD } = await import(
    "../src/lib/constants.js"
  );
  const small = assessFromScope({ unpaired: 10, paired: 50, edgeScanned: 60 });
  assert.equal(small.suggest, false);
  const largeUnpaired = assessFromScope({
    unpaired: BULK_UNPAIRED_IMPORT_THRESHOLD,
    paired: 0,
    edgeScanned: BULK_UNPAIRED_IMPORT_THRESHOLD,
  });
  assert.equal(largeUnpaired.suggest, true);
  assert.equal(largeUnpaired.reason, "large_unpaired");
  // Pull must NOT use Import's unpaired threshold alone
  const pullIgnoresUnpaired = assessPullFromScope({
    unpaired: BULK_UNPAIRED_IMPORT_THRESHOLD,
    paired: BULK_UNPAIRED_IMPORT_THRESHOLD, // high coverage
    edgeScanned: BULK_UNPAIRED_IMPORT_THRESHOLD * 2,
  });
  assert.equal(pullIgnoresUnpaired.suggest, false);
  const lowScope = {
    unpaired: BULK_EDGE_COUNT_THRESHOLD,
    paired: 5,
    edgeScanned: BULK_EDGE_COUNT_THRESHOLD + 5,
  };
  const lowCoverage = assessFromScope(lowScope);
  assert.equal(lowCoverage.suggest, true);
  assert.equal(lowCoverage.reason, "low_pair_coverage");
  assert.equal(assessPullFromScope(lowScope).suggest, true);
  const pullCopy = formatBulkCandidatePrompt(lowCoverage, "pull");
  assert.ok(pullCopy.includes("before Pull"));
  assert.ok(!pullCopy.includes("re-uploaded"));
  console.log("  ✔ assessFromScope / assessPullFromScope / prompt copy");
}

console.log("== export URL match + Match existing planner ==");
{
  const { urlMatchKeys } = await import("../src/lib/url-match.js");
  const { parseCsvRows, indexExportByUrl } = await import("../src/lib/export-csv.js");
  const { planMatchFromExport } = await import("../src/lib/match-existing.js");

  const keys = urlMatchKeys("https://www.Example.com/a/?utm=1#frag");
  assert.ok(keys.some((k) => k.includes("example.com/a") && !k.includes("utm")));
  assert.ok(keys.every((k) => !k.includes("#frag")));

  const rows = parseCsvRows('id,url\n1,"https://ex.com/a,b"\n2,https://ex.com/c\n');
  assert.deepEqual(rows[1], ["1", "https://ex.com/a,b"]);
  const indexed = indexExportByUrl("id,title,url\n99,Hi,https://www.Example.com/x/\n");
  assert.equal(indexed.raindropCount, 1);
  assert.ok(indexed.byKey.get("https://example.com/x")?.includes("99"));

  const csv =
    "id,url\n" +
    "10,https://a.example/one\n" +
    "20,https://b.example/two\n" +
    "30,https://c.example/dup\n" +
    "31,https://c.example/dup\n";
  const edge = [
    { id: "b1", url: "https://a.example/one" },
    { id: "b2", url: "https://b.example/two" },
    { id: "b3", url: "https://c.example/dup" },
    { id: "b4", url: "https://only.edge/local" },
    { id: "b5", url: "https://b.example/two?utm=1" }, // same bare key as b2 → ambiguous
  ];
  const pairs = {
    byBookmark: { b2: "20" },
    byRaindrop: { "20": "b2" },
  };
  const plan = planMatchFromExport(csv, edge, pairs);
  assert.equal(plan.matched.length, 1);
  assert.equal(plan.matched[0].bookmarkId, "b1");
  assert.equal(plan.matched[0].raindropId, "10");
  assert.equal(plan.alreadyPaired, 0); // b2/b5 collide on URL → ambiguous, not alreadyPaired
  assert.ok(plan.ambiguous >= 1);
  assert.ok(plan.edgeOnly >= 1);
  assert.ok(plan.raindropOnly >= 1);

  // Ambiguous: two Edge bookmarks, one raindrop URL
  const amb = planMatchFromExport(
    "id,url\n1,https://same.example/\n",
    [
      { id: "x1", url: "https://same.example/" },
      { id: "x2", url: "https://same.example/" },
    ],
    { byBookmark: {}, byRaindrop: {} }
  );
  assert.equal(amb.matched.length, 0);
  assert.equal(amb.ambiguous, 2);

  // Conflict: bookmark paired to different raindrop
  const conflict = planMatchFromExport(
    "id,url\n99,https://z.example/\n",
    [{ id: "z1", url: "https://z.example/" }],
    { byBookmark: { z1: "1" }, byRaindrop: { "1": "z1" } }
  );
  assert.equal(conflict.matched.length, 0);
  assert.equal(conflict.conflicts, 1);

  const pairedOk = planMatchFromExport(
    "id,url\n5,https://ok.example/\n",
    [{ id: "p1", url: "https://ok.example/" }],
    { byBookmark: { p1: "5" }, byRaindrop: { "5": "p1" } }
  );
  assert.equal(pairedOk.alreadyPaired, 1);
  assert.equal(pairedOk.matched.length, 0);

  // Stale reverse pair (old bookmark id gone) → re-pair to new id
  const staleReverse = planMatchFromExport(
    "id,url\n77,https://rebind.example/\n",
    [{ id: "new1", url: "https://rebind.example/" }],
    { byBookmark: { oldGone: "77" }, byRaindrop: { "77": "oldGone" } }
  );
  assert.equal(staleReverse.matched.length, 1);
  assert.equal(staleReverse.matched[0].bookmarkId, "new1");
  assert.equal(staleReverse.matched[0].raindropId, "77");
  assert.equal(staleReverse.conflicts, 0);

  // Live reverse conflict: another live bookmark still owns the raindrop
  const liveReverseConflict = planMatchFromExport(
    "id,url\n88,https://taken.example/\n",
    [
      { id: "want", url: "https://taken.example/" },
      { id: "owner", url: "https://other.example/" },
    ],
    { byBookmark: { owner: "88" }, byRaindrop: { "88": "owner" } }
  );
  assert.equal(liveReverseConflict.matched.length, 0);
  assert.equal(liveReverseConflict.conflicts, 1);

  console.log("  ✔ urlMatchKeys / export CSV / planMatchFromExport");
}

console.log("== move URL rebind picker ==");
{
  const { filterUrlMatchingItems, pickMoveRebindCandidate } = await import(
    "../src/lib/move-rebind.js"
  );

  const filtered = filterUrlMatchingItems("https://www.Example.com/a/", [
    { _id: 1, link: "https://example.com/a" },
    { _id: 2, link: "https://other.example/b" },
    { _id: 3, link: "https://example.com/a?utm=1" },
  ]);
  assert.deepEqual(
    filtered.map((i) => i._id).sort((a, b) => a - b),
    [1, 3]
  );

  const emptyPairs = { byBookmark: {}, byRaindrop: {} };
  const live = new Set(["bm1"]);
  const unique = pickMoveRebindCandidate(
    "bm1",
    [{ _id: 50, link: "https://x.example/" }],
    emptyPairs,
    live
  );
  assert.equal(unique.kind, "unique");
  assert.equal(unique.rid, "50");

  const multi = pickMoveRebindCandidate(
    "bm1",
    [
      { _id: 90, link: "https://x.example/" },
      { _id: 40, link: "https://x.example/" },
    ],
    emptyPairs,
    live
  );
  assert.equal(multi.kind, "multi");
  assert.equal(multi.rid, "40");
  assert.equal(multi.extras, 1);

  const conflict = pickMoveRebindCandidate(
    "bm1",
    [{ _id: 7, link: "https://x.example/" }],
    { byBookmark: { owner: "7" }, byRaindrop: { "7": "owner" } },
    new Set(["bm1", "owner"])
  );
  assert.equal(conflict.kind, "conflict");

  const staleOk = pickMoveRebindCandidate(
    "bm1",
    [{ _id: 8, link: "https://x.example/" }],
    { byBookmark: { gone: "8" }, byRaindrop: { "8": "gone" } },
    new Set(["bm1"])
  );
  assert.equal(staleOk.kind, "unique");
  assert.equal(staleOk.rid, "8");

  assert.equal(pickMoveRebindCandidate("bm1", [], emptyPairs, live).kind, "none");
  console.log("  ✔ filterUrlMatchingItems / pickMoveRebindCandidate");
}

console.log("== reconcile skip Status copy ==");
{
  const { formatReconcileSkipNotice } = await import("../src/lib/store.js");
  assert.equal(formatReconcileSkipNotice(null), null);
  assert.ok(formatReconcileSkipNotice({ reconcileSkipReason: "busy", reconcileSkipPending: 40 }).includes("40"));
  assert.ok(formatReconcileSkipNotice({ reconcileSkipReason: "busy", reconcileSkipPending: 40 }).includes("Pull now"));
  const coolNotice = formatReconcileSkipNotice({ reconcileSkipReason: "cooldown" });
  assert.ok(coolNotice.includes("cooldown"));
  assert.ok(coolNotice.includes("settled"), "cooldown copy mentions settled check");
  assert.ok(formatReconcileSkipNotice({ reconcileSkipReason: "bulk_pause" }).includes("Continue"));
  console.log("  ✔ busy / cooldown / bulk_pause notices");
}

console.log("== postpone confirm log copy ==");
{
  const fs = await import("node:fs/promises");
  const finishSrc = await fs.readFile(
    new URL("../src/lib/reconcile-finish.js", import.meta.url),
    "utf8"
  );
  assert.ok(
    finishSrc.includes("confirm budget this cycle"),
    "postpone log mentions confirm budget"
  );
  assert.ok(
    !finishSrc.includes("rate-limit budget; continues next cycle"),
    "postpone log must not blame rate-limit budget"
  );
  console.log("  ✔ postpone log honesty");
}

console.log("== pulled-path folderCollections zip ==");
{
  const { recordFolderCollectionsForPulledPath } = await import("../src/lib/collections.js");
  // Minimal fake index: Bookmarks / Bookmarks bar / Leaf
  const byId = new Map();
  const add = (col) => {
    byId.set(col._id, col);
    byId.set(String(col._id), col);
  };
  add({ _id: 1, title: "Bookmarks", parent: null });
  add({ _id: 2, title: "Bookmarks bar", parent: { $id: 1 } });
  add({ _id: 3, title: "Leaf", parent: { $id: 2 } });
  const index = { byId };
  const recorded = [];
  await recordFolderCollectionsForPulledPath(
    index,
    1,
    3,
    ["Bookmarks bar", "Leaf"],
    ["edge-leaf", "edge-bar", "edge-other"],
    async (folderId, colId) => {
      recorded.push([folderId, colId]);
    }
  );
  assert.deepEqual(recorded, [
    ["edge-leaf", 3],
    ["edge-bar", 2],
  ]);
  console.log("  ✔ under-root pull path maps leaf+ancestors");
}

console.log("== queue-depth bulk prompt ==");
{
  const {
    QUEUE_BULK_PENDING_THRESHOLD,
    BULK_DRAIN_PAUSED_LOG,
    drainJobsCap,
    HEARTBEAT_MINUTES,
  } = await import("../src/lib/constants.js");
  const {
    defaultBulkPrompt,
    evolveBulkPrompt,
    snoozeBulkPromptState,
    isBulkDrainPaused,
    queueBulkClearWatermark,
    estimateDrainEtaMinutes,
    formatBulkQueueNotice,
    armBulkPromptIfNeeded,
    BULK_PROMPT_NEEDS_CHOICE,
    BULK_PROMPT_IDLE,
  } = await import("../src/lib/queue-bulk-prompt.js");

  assert.equal(QUEUE_BULK_PENDING_THRESHOLD, 150);
  await assert.rejects(
    () => armBulkPromptIfNeeded(),
    /requires pending/,
    "armBulkPromptIfNeeded must not treat missing pending as depth 0"
  );
  assert.ok(BULK_DRAIN_PAUSED_LOG.includes("Status"));
  assert.equal(queueBulkClearWatermark(), QUEUE_BULK_PENDING_THRESHOLD / 2);

  const idle = defaultBulkPrompt();
  assert.equal(idle.status, BULK_PROMPT_IDLE);
  assert.equal(isBulkDrainPaused(idle), false);

  // Below threshold: stay idle
  assert.equal(
    evolveBulkPrompt(idle, QUEUE_BULK_PENDING_THRESHOLD - 1).status,
    BULK_PROMPT_IDLE
  );

  // Cross threshold → needs_choice
  const armed = evolveBulkPrompt(idle, QUEUE_BULK_PENDING_THRESHOLD);
  assert.equal(armed.status, BULK_PROMPT_NEEDS_CHOICE);
  assert.equal(isBulkDrainPaused(armed), true);

  // Stay armed while still large
  assert.equal(
    evolveBulkPrompt(armed, QUEUE_BULK_PENDING_THRESHOLD + 500).status,
    BULK_PROMPT_NEEDS_CHOICE
  );

  // Natural drain below half clears needs_choice
  const cleared = evolveBulkPrompt(armed, queueBulkClearWatermark() - 1);
  assert.equal(cleared.status, BULK_PROMPT_IDLE);
  assert.equal(cleared.snoozedBelow, null);

  // Continue drip snoozes; same depth does not re-arm
  const snoozed = snoozeBulkPromptState();
  assert.equal(snoozed.status, BULK_PROMPT_IDLE);
  assert.equal(snoozed.snoozedBelow, queueBulkClearWatermark());
  assert.equal(
    evolveBulkPrompt(snoozed, QUEUE_BULK_PENDING_THRESHOLD + 100).status,
    BULK_PROMPT_IDLE
  );
  // After pending drops below watermark, a new spike can arm again
  const afterSnooze = evolveBulkPrompt(snoozed, queueBulkClearWatermark() - 1);
  assert.equal(afterSnooze.snoozedBelow, null);
  assert.equal(
    evolveBulkPrompt(afterSnooze, QUEUE_BULK_PENDING_THRESHOLD).status,
    BULK_PROMPT_NEEDS_CHOICE
  );

  const eta = estimateDrainEtaMinutes(QUEUE_BULK_PENDING_THRESHOLD);
  assert.equal(eta, Math.ceil(QUEUE_BULK_PENDING_THRESHOLD / drainJobsCap(QUEUE_BULK_PENDING_THRESHOLD)) * HEARTBEAT_MINUTES);
  assert.ok(formatBulkQueueNotice(200).includes("200"));
  assert.ok(formatBulkQueueNotice(200).includes("Match"));

  console.log("  ✔ arm / snooze / clear watermarks / ETA / drain-pause predicate");
}

console.log("== Options HTML bulk lane controls ==");
{
  const html = fs.readFileSync(path.join(REPO_ROOT, "src/options/options.html"), "utf8");
  assert.ok(html.includes('id="bulkQueueBanner"'), "Status bulk-queue banner");
  assert.ok(html.includes('id="bulkQueueMatch"'), "Match from queue banner");
  assert.ok(html.includes('id="bulkQueueContinue"'), "Continue drip on Status");
  assert.ok(html.includes('id="matchExisting"'), "Manual Sync Match existing");
  assert.ok(!/id=["'][^"']*repair[^"']*["']/i.test(html), "no repair control id");
  assert.ok(
    !/Other\s+favorites\s+repair/i.test(html),
    "no Other-favorites repair product control"
  );
  console.log("  ✔ bulk banner + Match existing; no Other-favorites repair");
}

console.log("\nAll offline checks passed.");
console.log("Engine scenarios: npm test runs verify-checklist.mjs next (mocked Edge).");
console.log(
  "Bulk engine wiring: checklist 7.5–7.7 (drain pause, Match apply, scanImportScope)."
);
console.log("Manual Edge still useful for SW lifecycle / Options confirm dialogs only.");
