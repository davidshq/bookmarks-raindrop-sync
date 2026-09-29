// Query variants that select different content are different URLs. Only
// tracking params may be dropped to find a loose match (review item 1).

import assert from "node:assert/strict";
import { test } from "vitest";
import { urlMatchKeys, urlMatchKind } from "../src/lib/url-match.js";
import { filterUrlMatchingItems } from "../src/lib/move-rebind.js";
import { buildSnapshot, idsForUrl } from "../src/lib/presence.js";
import { treeIndexFromList, treeEntriesForUrl } from "../src/lib/tree-index.js";

test("loose key drops tracking params only, verbatim", () => {
  assert.deepEqual(urlMatchKeys("https://www.youtube.com/watch?v=A&si=x"), [
    "https://youtube.com/watch?v=A&si=x",
    "https://youtube.com/watch?v=A",
  ]);
  assert.deepEqual(urlMatchKeys("https://ex.com/p?q=a%20b&utm_source=z&fbclid=1"), [
    "https://ex.com/p?q=a%20b&utm_source=z&fbclid=1",
    "https://ex.com/p?q=a%20b",
  ]);
  // Content-selecting queries get no second key.
  assert.deepEqual(urlMatchKeys("https://news.ycombinator.com/item?id=1"), [
    "https://news.ycombinator.com/item?id=1",
  ]);
});

test("urlMatchKind: tracking variant is loose, content variant is no match", () => {
  assert.equal(urlMatchKind("https://ex.com/a?utm_source=1", "https://ex.com/a"), "loose");
  assert.equal(urlMatchKind("https://ex.com/watch?v=A", "https://ex.com/watch?v=B"), null);
  assert.equal(urlMatchKind("https://ex.com/item", "https://ex.com/item?id=5"), null);
});

test("a lone different-query candidate is not a match (snapshot, search, tree)", () => {
  const snap = buildSnapshot(
    "id,url\n1,https://www.youtube.com/watch?v=AAA\n7,https://news.ycombinator.com/item?id=1\n",
    { at: 1 }
  );
  assert.deepEqual(idsForUrl(snap, "https://youtube.com/watch?v=BBB"), []);
  assert.deepEqual(idsForUrl(snap, "https://news.ycombinator.com/item?id=2"), []);
  assert.deepEqual(
    filterUrlMatchingItems("https://youtube.com/watch?v=BBB", [
      { _id: 1, link: "https://youtube.com/watch?v=AAA" },
    ]),
    []
  );
  const tree = treeIndexFromList([{ id: "5", url: "https://example.com/watch?v=B" }]);
  assert.deepEqual(treeEntriesForUrl(tree, "https://example.com/watch?v=A"), []);
});

test("a lone tracking variant still matches loosely", () => {
  const snap = buildSnapshot("id,url\n3,https://ex.com/page?utm_source=old\n", { at: 1 });
  assert.deepEqual(idsForUrl(snap, "https://ex.com/page?utm_source=new"), ["3"]);
  assert.deepEqual(idsForUrl(snap, "https://ex.com/page"), ["3"]);
});
