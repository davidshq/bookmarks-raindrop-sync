// Pair health (design D9): counts from records + tree + snapshot, no requests.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  computePairHealth,
  formatPairHealth,
  pairHealthNeedsRepair,
} from "../src/lib/pair-health.js";
import { treeIndexFromList } from "../src/lib/tree-index.js";
import { buildSnapshot } from "../src/lib/presence.js";
import { makePairRecord } from "../src/lib/store.js";

test("health counts with every category populated", () => {
  const tree = treeIndexFromList([
    { id: "b1", url: "https://h.example/live" }, // paired live↔live
    { id: "b2", url: "https://h.example/ghost" }, // paired to a gone raindrop
    { id: "b3", url: "https://h.example/edge-only" }, // no raindrop has it
    { id: "b4", url: "https://h.example/dup" }, // Edge duplicate group
    { id: "b5", url: "https://h.example/dup/" },
    { id: "b6", url: "https://h.example/private", inScope: false }, // excluded
  ]);
  const snapshot = buildSnapshot(
    [
      "id,url",
      "1,https://h.example/live",
      "3,https://h.example/rd-only",
      "4,https://h.example/rd-dup",
      "5,https://h.example/rd-dup",
      "6,https://h.example/stale-edge",
      "7,https://h.example/dup",
    ].join("\n"),
    { at: 1_000 }
  );
  const records = {
    1: makePairRecord("1", { bookmarkId: "b1", url: "https://h.example/live" }),
    2: makePairRecord("2", { bookmarkId: "b2", url: "https://h.example/ghost" }),
    6: makePairRecord("6", { bookmarkId: "gone", url: "https://h.example/stale-edge" }),
  };
  const h = computePairHealth({ records, treeIndex: tree, snapshot, now: 61_000 });
  assert.equal(h.pairs, 3);
  assert.equal(h.liveLive, 1);
  assert.equal(h.staleEdgeId, 1, "record 6's bookmark id is gone");
  assert.equal(h.staleRaindropId, 1, "record 2's raindrop id is gone");
  assert.equal(h.edgeOnlyUrls, 2, "ghost + edge-only (excluded copy not counted)");
  assert.equal(h.raindropOnlyUrls, 3, "rd-only, rd-dup, stale-edge");
  assert.equal(h.duplicateUrlGroupsEdge, 1);
  assert.equal(h.duplicateUrlGroupsRaindrop, 1);
  assert.equal(h.snapshotAgeMs, 60_000);
  assert.equal(h.complete, true);
  assert.equal(pairHealthNeedsRepair(h), true);
  assert.match(formatPairHealth(h, 61_000), /1 live↔live, 1 stale Edge id, 1 stale Raindrop id/);
});

test("without a URL index Raindrop-side URL counts are unknown, not zero", () => {
  const tree = treeIndexFromList([{ id: "b1", url: "https://h.example/a" }]);
  const restored = {
    at: 0,
    ids: new Set(["1"]),
    byUrlKey: new Map(),
    urlById: new Map(),
    complete: true,
    urlIndexed: false,
  };
  const records = { 1: makePairRecord("1", { bookmarkId: "b1", url: "https://h.example/a" }) };
  const h = computePairHealth({ records, treeIndex: tree, snapshot: restored, now: 0 });
  assert.equal(h.liveLive, 1);
  assert.equal(h.edgeOnlyUrls, null);
  assert.equal(h.raindropOnlyUrls, null);
  assert.equal(h.duplicateUrlGroupsRaindrop, null);
  assert.equal(pairHealthNeedsRepair(h), false);

  const none = computePairHealth({ records, treeIndex: tree, snapshot: null, now: 0 });
  assert.equal(none.staleRaindropId, null, "unknown without a snapshot");
  assert.match(formatPairHealth(none), /Snapshot age none/);
});
