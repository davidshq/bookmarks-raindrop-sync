// Map-valued store keys are read-modify-write; concurrent writers (drain and
// reconcile share one service worker) must not drop each other's updates.

import assert from "node:assert/strict";
import { test, beforeEach } from "vitest";
import { storage } from "../scripts/lib/test-harness.mjs";
import * as store from "../src/lib/store.js";

beforeEach(() => storage.clear());

test("concurrent tombstone adds all survive", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
  await Promise.all(ids.map((id) => store.addTombstone(id, "delete")));
  assert.deepEqual(Object.keys(await store.getTombstones()).sort(), [...ids].sort());
});

test("tombstone add and clear interleave without losing the add", async () => {
  await store.addTombstone("old", "delete");
  await Promise.all([store.clearTombstone("old"), store.addTombstone("new", "offload")]);
  assert.deepEqual(Object.keys(await store.getTombstones()), ["new"]);
});

test("concurrent folder-collection and cache writes all survive", async () => {
  await Promise.all([
    ...[1, 2, 3].map((n) => store.recordFolderCollection(`f${n}`, n)),
    ...[1, 2, 3].map((n) => store.cacheCollection(`Root/P${n}`, n)),
  ]);
  assert.deepEqual(await store.getFolderCollections(), { f1: 1, f2: 2, f3: 3 });
  assert.deepEqual(await store.getCollectionCache(), { "Root/P1": 1, "Root/P2": 2, "Root/P3": 3 });
});

test("concurrent reconcile-state patches merge", async () => {
  await Promise.all([
    store.setReconcileState({ cursorPage: 4 }),
    store.setReconcileState({ presencePending: true }),
  ]);
  const state = await store.getReconcileState();
  assert.equal(state.cursorPage, 4);
  assert.equal(state.presencePending, true);
});
