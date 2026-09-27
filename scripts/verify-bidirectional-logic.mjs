#!/usr/bin/env node
// Offline unit checks for pure sync helpers (no Raindrop token / Edge / chrome).
// Imports the real src/lib modules — do not reimplement algorithms here.
// Run: node scripts/verify-bidirectional-logic.mjs
// Or:  npm test

import assert from "node:assert/strict";
import { resolvePolicy, isExcluded } from "../src/lib/policy.js";
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
import { jobKind, drainJobPriority } from "../src/lib/queue.js";
import {
  POLICY,
  JOB,
  DEFAULT_CONFIG,
  RAINDROP_FOLDER_MODE,
  SYNC_MODE,
  LOG_LIMIT,
  LOG_ARCHIVE_LIMIT,
} from "../src/lib/constants.js";
import { normalizeConfig } from "../src/lib/store.js";
import { runPullNow } from "../src/lib/pull-now.js";
import {
  isAllowlistActive,
  isCollectionAllowed,
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
  assert.equal(drainJobPriority(JOB.UPLOAD), drainJobPriority(JOB.PULL_CREATE));
  console.log("  ✔ legacy jobs are upload; rename before upload");
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

console.log("== rate-limit constants ==");
{
  const {
    RATE_LIMIT_RESERVE,
    MAX_ALIVE_CHECKS_PER_TICK,
    MAX_JOBS_PER_DRAIN,
    MAX_RECONCILE_PAGES_PER_TICK,
    MAX_TRASH_PAGES_PER_TICK,
    RAINDROP_TRASH_COLLECTION_ID,
    MIN_RECONCILE_INTERVAL_MS,
  } = await import("../src/lib/constants.js");
  assert.ok(RATE_LIMIT_RESERVE >= 1);
  assert.ok(MAX_ALIVE_CHECKS_PER_TICK >= 1);
  assert.ok(MAX_JOBS_PER_DRAIN >= 1);
  assert.ok(MAX_RECONCILE_PAGES_PER_TICK >= 1);
  assert.ok(MAX_TRASH_PAGES_PER_TICK >= 1);
  assert.equal(RAINDROP_TRASH_COLLECTION_ID, -99);
  assert.ok(MIN_RECONCILE_INTERVAL_MS >= 60_000);
  const { RateLimitError } = await import("../src/lib/raindrop.js");
  const err = new RateLimitError(Date.now() + 1000, { proactive: true });
  assert.equal(err.proactive, true);
  console.log("  ✔ reserve / caps / cooldown / proactive RateLimitError");
}

console.log("\nAll offline checks passed.");
console.log("Engine scenarios: npm test runs verify-checklist.mjs next (mocked Edge).");
console.log("Manual Edge still useful for SW lifecycle / Options UI only.");
