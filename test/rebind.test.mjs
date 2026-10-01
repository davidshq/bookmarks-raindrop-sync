// Stale-id rebind rules (design D3; memo invariants 3 and 4). Pure over
// (records, tree index, snapshot).

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  rebindPass,
  rebindStaleEdgeId,
  rebindLogLines,
  isPairBookmarkLive,
  isDifferentBookmark,
} from "../src/lib/pair-rebind.js";
import {
  treeIndexFromList,
  buildTreeIndex,
  makeScopePredicate,
  treeEntriesForUrl,
} from "../src/lib/tree-index.js";
import { buildSnapshot } from "../src/lib/presence.js";
import { makePairRecord, pairsView } from "../src/lib/store.js";
import { resolveMigratedRecords } from "../src/lib/pair-migration.js";

const URL_A = "https://a.example/doc";

function record(rid, bid, url, extra = {}) {
  return makePairRecord(rid, { bookmarkId: bid, url, ...extra });
}

test("invariant 3: stale Edge id rebinds by URL under the same path", () => {
  // Chromium renumbered: record's bookmark 12 is gone; the URL exists twice,
  // once under the recorded path.
  const tree = treeIndexFromList([
    { id: "900", url: URL_A, path: ["Other favorites", "Elsewhere"] },
    { id: "901", url: URL_A, path: ["Favorites bar", "Dev"] },
  ]);
  const records = { 7: record("7", "12", URL_A, { edgePathAtSync: ["Favorites bar", "Dev"] }) };
  const pass = rebindPass({ records, treeIndex: tree });
  assert.equal(pass.edgeRebinds.length, 1);
  assert.equal(pass.edgeRebinds[0].to, "901", "prefers the copy under edgePathAtSync");
  assert.equal(pass.edgeRebinds[0].samePath, true);
  assert.equal(pass.records["7"].bookmarkId, "901");
  assert.deepEqual(pass.records["7"].edgePathAtSync, ["Favorites bar", "Dev"]);
  assert.deepEqual(pass.staleEdge, []);
  assert.equal(pass.changes[0].type, "edge");
  assert.equal(pass.changes[0].fromBookmarkId, "12");
});

test("stale Edge id with the URL moved elsewhere in the mirror rebinds there", () => {
  const tree = treeIndexFromList([
    { id: "905", url: `${URL_A}/`, path: ["Other favorites", "New"] },
  ]);
  const records = { 7: record("7", "12", URL_A, { edgePathAtSync: ["Favorites bar", "Dev"] }) };
  const pass = rebindPass({ records, treeIndex: tree });
  assert.equal(pass.records["7"].bookmarkId, "905");
  assert.equal(pass.edgeRebinds[0].samePath, false);
  assert.deepEqual(
    pass.records["7"].edgePathAtSync,
    ["Other favorites", "New"],
    "placement updated"
  );
});

test("Edge id reused by another bookmark after a renumber is stale, not live", () => {
  // Overlapping renumber: id 500 now holds an unrelated bookmark; the pair's
  // bookmark came back as 1234.
  const tree = treeIndexFromList([
    { id: "500", url: "https://unrelated.example/", path: [] },
    { id: "1234", url: URL_A, path: [] },
  ]);
  const records = { 7: record("7", "500", URL_A) };
  const pass = rebindPass({ records, treeIndex: tree });
  assert.equal(pass.records["7"].bookmarkId, "1234");
  assert.deepEqual(
    pass.edgeRebinds.map((r) => [r.from, r.to]),
    [["500", "1234"]]
  );
});

test("renumber that swaps two pairs' ids rebinds both", () => {
  const URL_B = "https://b.example/doc";
  const tree = treeIndexFromList([
    { id: "500", url: URL_B, path: [] },
    { id: "600", url: URL_A, path: [] },
  ]);
  const records = { 7: record("7", "500", URL_A), 8: record("8", "600", URL_B) };
  const pass = rebindPass({ records, treeIndex: tree });
  assert.equal(pass.records["7"].bookmarkId, "600");
  assert.equal(pass.records["8"].bookmarkId, "500");
  assert.deepEqual(pass.staleEdge, []);
});

test("a bookmark with a queued upload stays live while its pair URL lags the edit", () => {
  // The user edited 500's URL; the upload that updates the record is queued.
  const tree = treeIndexFromList([
    { id: "500", url: "https://a.example/edited", path: [] },
    { id: "501", url: URL_A, path: [] },
  ]);
  const records = { 7: record("7", "500", URL_A) };
  const pass = rebindPass({ records, treeIndex: tree, pendingBookmarkIds: new Set(["500"]) });
  assert.equal(pass.records["7"].bookmarkId, "500", "not moved onto the other copy");
  assert.deepEqual(pass.edgeRebinds, []);
});

test("id-only record takes the raindrop's URL, not the reused id's", () => {
  const tree = treeIndexFromList([{ id: "500", url: "https://unrelated.example/", path: [] }]);
  const snapshot = buildSnapshot(`id,url\n7,${URL_A}\n`, { at: 1000 });
  const records = { 7: makePairRecord("7", { bookmarkId: "500", lastSeenRaindropAt: 1 }) };
  const pass = rebindPass({ records, treeIndex: tree, snapshot });
  assert.equal(pass.records["7"].url, URL_A);
  assert.deepEqual(pass.staleEdge, ["7"], "reused id is not the pair's bookmark");
});

test("bound elsewhere is not claimed; stale record stays stale (no delete)", () => {
  const tree = treeIndexFromList([{ id: "901", url: URL_A, path: [] }]);
  const records = {
    7: record("7", "12", URL_A), // stale
    8: record("8", "901", URL_A), // live pair owns the only copy
  };
  const pass = rebindPass({ records, treeIndex: tree });
  assert.deepEqual(pass.edgeRebinds, []);
  assert.deepEqual(pass.staleEdge, ["7"]);
  assert.equal(pass.records["7"].bookmarkId, "12", "record untouched");
  assert.equal(rebindStaleEdgeId(records["7"], tree, pairsView({ records })), null);
});

test("copies outside the synced scope are never rebound to", () => {
  const roots = [
    {
      id: "0",
      children: [
        {
          id: "2",
          title: "Other favorites",
          children: [
            {
              id: "50",
              title: "Private",
              children: [{ id: "51", url: URL_A, title: "a", parentId: "50" }],
            },
            {
              id: "60",
              title: "Raindrop",
              children: [{ id: "61", url: URL_A, title: "a", parentId: "60" }],
            },
          ],
        },
      ],
    },
  ];
  const overrides = { 50: { policy: "exclude" } };
  const records = { 7: record("7", "12", URL_A) };

  const noAllowlist = buildTreeIndex(roots, {
    isInScope: makeScopePredicate({
      overrides,
      defaultPolicy: "sync-and-keep",
      allowlistActive: false,
    }),
  });
  assert.equal(noAllowlist.byId.get("51").inScope, false, "excluded folder");
  assert.equal(noAllowlist.byId.get("61").inScope, false, "landing zone without allowlist");
  assert.deepEqual(rebindPass({ records, treeIndex: noAllowlist }).staleEdge, ["7"]);

  const withAllowlist = buildTreeIndex(roots, {
    isInScope: makeScopePredicate({
      overrides,
      defaultPolicy: "sync-and-keep",
      allowlistActive: true,
    }),
  });
  assert.equal(withAllowlist.byId.get("61").inScope, true, "landing zone with allowlist");
  assert.equal(rebindPass({ records, treeIndex: withAllowlist }).records["7"].bookmarkId, "61");
});

test("query variants are not the same URL for Edge rebind", () => {
  // Chromium renumbered both bookmarks; each pair must rebind to its own video,
  // not cross via the shared query-stripped key.
  const urlA = "https://example.com/watch?v=A";
  const urlB = "https://example.com/watch?v=B";
  const tree = treeIndexFromList([
    { id: "900", url: urlA, path: ["Favorites bar"] },
    { id: "901", url: urlB, path: ["Favorites bar"] },
  ]);
  const records = {
    7: record("7", "12", urlA, { edgePathAtSync: ["Favorites bar"] }),
    8: record("8", "13", urlB, { edgePathAtSync: ["Favorites bar"] }),
  };
  const pass = rebindPass({ records, treeIndex: tree });
  assert.equal(pass.records["7"].bookmarkId, "900");
  assert.equal(pass.records["8"].bookmarkId, "901");
  assert.deepEqual(pass.staleEdge, []);
});

test("survival: different-query URL is ignored when both query variants exist", () => {
  const urlA = "https://example.com/watch?v=A";
  const urlB = "https://example.com/watch?v=B";
  // When both are present, lookup for A must not list B (else a delete of A
  // would treat B as a survivor and silently drop).
  const both = treeIndexFromList([
    { id: "1", url: urlA, inScope: true },
    { id: "2", url: urlB, inScope: true },
  ]);
  assert.deepEqual(
    treeEntriesForUrl(both, urlA).map((e) => e.id),
    ["1"]
  );
  assert.deepEqual(
    treeEntriesForUrl(both, urlB).map((e) => e.id),
    ["2"]
  );
});

test("invariant 4: stale Raindrop id rebinds to the oldest surviving copy", () => {
  const tree = treeIndexFromList([{ id: "101", url: URL_A }]);
  // Raindrop 500 (the pair) was trashed; 300 and 400 carry the same URL.
  const snapshot = buildSnapshot(`id,url\n400,${URL_A}\n300,${URL_A}\n`, { at: 1000 });
  const records = { 500: record("500", "101", URL_A, { lastSeenRaindropAt: 900 }) };
  const pass = rebindPass({ records, treeIndex: tree, snapshot });
  assert.deepEqual(
    pass.raindropRebinds.map((r) => [r.from, r.to]),
    [["500", "300"]]
  );
  assert.equal(pass.records["300"].bookmarkId, "101", "record re-keyed; Edge bookmark kept");
  assert.equal(pass.records["500"], undefined);
  assert.deepEqual(pass.raindropCandidates, [], "not a delete candidate");
});

test("survivor bound to another live bookmark is not claimed; no survivor → candidate only", () => {
  const tree = treeIndexFromList([
    { id: "101", url: URL_A },
    { id: "102", url: URL_A },
  ]);
  const snapshot = buildSnapshot(`id,url\n300,${URL_A}\n`, { at: 1000 });
  const records = {
    500: record("500", "101", URL_A, { lastSeenRaindropAt: 1 }),
    300: record("300", "102", URL_A, { lastSeenRaindropAt: 1 }),
    600: record("600", "101x", "https://gone.example/", { lastSeenRaindropAt: 1 }),
  };
  const pass = rebindPass({ records, treeIndex: tree, snapshot });
  assert.deepEqual(pass.raindropRebinds, []);
  assert.deepEqual(pass.raindropCandidates.sort(), ["500", "600"]);
  // The pass is pure: it returns candidates, it never enqueues deletes.
  assert.ok(pass.changes.every((c) => c.type !== "drop"));
});

test("renumber + fork shape merges into one live pair", () => {
  // X (live) → trashed fork R1; dead Y → original R2 with the same URL.
  const tree = treeIndexFromList([{ id: "X", url: URL_A }]);
  const snapshot = buildSnapshot(`id,url\n2,${URL_A}\n`, { at: 1000 });
  const records = {
    1: record("1", "X", URL_A, { lastSeenRaindropAt: 1 }),
    2: record("2", "Y", URL_A, { lastSeenRaindropAt: 1 }),
  };
  const pass = rebindPass({ records, treeIndex: tree, snapshot });
  assert.equal(pass.records["2"].bookmarkId, "X");
  assert.equal(pass.records["1"], undefined);
  assert.equal(pass.raindropRebinds[0].replacedBookmarkId, "Y");
});

test("records paired after the export began are never judged absent", () => {
  const tree = treeIndexFromList([{ id: "101", url: URL_A }]);
  const snapshot = buildSnapshot("id,url\n", { at: 1000 });
  const records = { 777: record("777", "101", URL_A, { lastSeenRaindropAt: 1001 }) };
  const pass = rebindPass({ records, treeIndex: tree, snapshot });
  assert.deepEqual(pass.raindropCandidates, []);
});

test("id-only records get their URL from the tree, the export, or a Trash hint", () => {
  const tree = treeIndexFromList([{ id: "101", url: URL_A, path: ["Favorites bar"] }]);
  const snapshot = buildSnapshot("id,url\n20,https://b.example/\n", { at: 1000 });
  const records = {
    10: makePairRecord("10", { bookmarkId: "101" }),
    20: makePairRecord("20", { bookmarkId: "dead" }),
    30: makePairRecord("30", { bookmarkId: "dead2" }),
  };
  const pass = rebindPass({
    records,
    treeIndex: tree,
    snapshot,
    urlHints: new Map([["30", "https://c.example/"]]),
  });
  assert.equal(pass.records["10"].url, URL_A);
  assert.deepEqual(pass.records["10"].edgePathAtSync, ["Favorites bar"]);
  assert.equal(pass.records["20"].url, "https://b.example/");
  assert.equal(pass.records["30"].url, "https://c.example/");
});

test("rebind log lines cap at 20 plus a summary", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ title: `t${i}`, to: String(i) }));
  const lines = rebindLogLines({ edgeRebinds: many, raindropRebinds: [] });
  assert.equal(lines.length, 21);
  assert.equal(lines[0], "Rebound: t0 (Edge id changed)");
  assert.match(lines[20], /Rebound 5 more pair\(s\)/);
});

test("migration drops a pair whose id holds another bookmark and whose raindrop is gone", () => {
  const tree = treeIndexFromList([{ id: "500", url: "https://unrelated.example/", path: [] }]);
  const snapshot = buildSnapshot("id,url\n9,https://other.example/\n", { at: 1000 });
  const records = { 7: record("7", "500", URL_A, { lastSeenRaindropAt: 1 }) };
  const out = resolveMigratedRecords(records, tree, snapshot, 2000);
  assert.equal(out.dropped, 1);
  assert.equal(out.records["7"], undefined);
});

test("record left on the raindrop's old URL heals when the bookmark has its new URL", () => {
  // Raindrop 7 changed its link to URL_B and a pull-update moved bookmark 500
  // to URL_B, but the record still carries URL_A.
  const URL_B = "https://b.example/new";
  const tree = treeIndexFromList([{ id: "500", url: URL_B, path: [] }]);
  const snapshot = buildSnapshot(`id,url\n7,${URL_B}\n`, { at: 1000 });
  const records = { 7: record("7", "500", URL_A, { lastSeenRaindropAt: 1 }) };
  const pass = rebindPass({ records, treeIndex: tree, snapshot });
  assert.equal(pass.records["7"].bookmarkId, "500", "kept on its bookmark");
  assert.equal(pass.records["7"].url, URL_B, "URL refreshed");
  assert.deepEqual(pass.staleEdge, []);
  assert.deepEqual(pass.edgeRebinds, []);
  assert.deepEqual(
    pass.changes.map((c) => c.type),
    ["fill"]
  );
});

test("dateAdded backfills from a node whose URL matches, never from a reused id", () => {
  const tree = treeIndexFromList([
    { id: "500", url: URL_A, dateAdded: 111, path: [] },
    { id: "600", url: "https://unrelated.example/", dateAdded: 222, path: [] },
  ]);
  const records = { 7: record("7", "500", URL_A), 8: record("8", "600", "https://b.example/x") };
  const pass = rebindPass({ records, treeIndex: tree, pendingBookmarkIds: new Set(["600"]) });
  assert.equal(pass.records["7"].dateAdded, 111);
  assert.equal(pass.records["8"].dateAdded, null, "a pending job alone does not vouch");
});

test("dateAdded decides identity when both sides have it", () => {
  const rec = record("7", "500", URL_A, { dateAdded: 111 });
  const same = { id: "500", url: "https://a.example/edited", dateAdded: 111 };
  const other = { id: "500", url: URL_A, dateAdded: 222 };
  assert.equal(isPairBookmarkLive(rec, same), true, "URL edit, same bookmark");
  assert.equal(isPairBookmarkLive(rec, other), false, "same URL, other bookmark");
  // Record without dateAdded, node's URL edited: only a queued upload vouches.
  const edited = { id: "500", url: "https://a.example/edited", dateAdded: 222 };
  const legacy = record("7", "500", URL_A);
  assert.equal(
    isPairBookmarkLive(legacy, edited, new Map([["500", 111]])),
    false,
    "a job queued for another bookmark does not vouch"
  );
  assert.equal(
    isPairBookmarkLive(legacy, edited, new Map([["500", 222]])),
    true,
    "a job queued for this bookmark does"
  );
});

test("rebind finds a renumbered bookmark by dateAdded even after its URL changed", () => {
  const tree = treeIndexFromList([
    { id: "500", url: URL_A, dateAdded: 999, path: [] }, // unrelated, same URL
    { id: "900", url: "https://a.example/moved-on", dateAdded: 111, path: [] },
  ]);
  const rec = record("7", "12", URL_A, { dateAdded: 111 });
  const view = pairsView({ records: { 7: rec } });
  assert.equal(rebindStaleEdgeId(rec, tree, view).entry.id, "900");
  const gone = record("7", "12", URL_A, { dateAdded: 333 });
  assert.equal(rebindStaleEdgeId(gone, tree, view).entry.id, "500", "rebind: URL copy");
  assert.equal(rebindStaleEdgeId(gone, tree, view, { strict: true }), null, "delete: none");
});

test("without dateAdded, only a change of URL, title and folder counts as another bookmark", () => {
  const rec = record("7", "500", URL_A, { title: "A", edgeParentId: "1" });
  const node = (patch) => ({ id: "500", url: URL_A, title: "A", parentId: "1", ...patch });
  assert.equal(isDifferentBookmark(rec, node({ url: "https://x.example/" })), false);
  assert.equal(
    isDifferentBookmark(rec, node({ url: "https://x.example/", title: "X", parentId: "2" })),
    true
  );
  assert.equal(
    isDifferentBookmark(
      { ...rec, dateAdded: 1 },
      node({ dateAdded: 1, url: "https://x/", title: "X", parentId: "2" })
    ),
    false,
    "dateAdded match wins over everything else"
  );
});
