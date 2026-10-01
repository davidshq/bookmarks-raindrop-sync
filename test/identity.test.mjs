// Bookmark identity by dateAdded: after ids are reassigned (Edge and older
// Chrome renumber every id when the Bookmarks file needs recovery), the node
// at a pair's old id may be another bookmark. dateAdded survives and decides.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  setupEngine,
  edgeBookmark,
  edgeFolder,
  jobsOfKind,
  bookmarks,
  renumberBookmarks,
} from "./helpers/engine.mjs";

/** Two synced bookmarks A and B, then a renumber that swaps their ids. */
async function swappedPair() {
  const { eng, mock, root } = await setupEngine();
  const a = await edgeBookmark("1", "A", "https://id.example/a");
  const b = await edgeBookmark("1", "B", "https://id.example/b");
  await eng.queue.enqueue(a.id, { dateAdded: a.dateAdded });
  await eng.queue.enqueue(b.id, { dateAdded: b.dateAdded });
  await eng.sync.drain();
  const ridA = await eng.store.getRaindropId(a.id);
  const ridB = await eng.store.getRaindropId(b.id);
  const map = renumberBookmarks({ start: Number(a.id), reverse: true });
  assert.equal(map.get(b.id), a.id, "B now holds A's old id");
  return { eng, mock, root, a, b, ridA, ridB, bAt: a.id, aAt: map.get(a.id) };
}

test("an edit to the bookmark now at a pair's old id never overwrites that pair's raindrop", async () => {
  const { eng, mock, a, ridA, ridB, bAt } = await swappedPair();
  bookmarks.get(bAt).title = "B edited";
  await eng.sync.handleBookmarkChanged(bAt, { title: "B edited" });
  await eng.sync.drain();
  const rdA = mock._raindrops.get(Number(ridA)) ?? mock._raindrops.get(ridA);
  const rdB = mock._raindrops.get(Number(ridB)) ?? mock._raindrops.get(ridB);
  assert.equal(rdA.link, a.url, "A's raindrop keeps A's link");
  assert.equal(rdA.title, "A", "A's raindrop keeps A's title");
  assert.equal(rdB.title, "B edited", "the edit reaches B's own raindrop");
  assert.equal(await eng.store.getRaindropId(bAt), ridB);
});

test("a queued upload follows its bookmark to the new id", async () => {
  const { eng, mock } = await setupEngine();
  const a = await edgeBookmark("1", "A", "https://id.example/qa");
  const b = await edgeBookmark("1", "B", "https://id.example/qb");
  await eng.queue.enqueue(a.id, { dateAdded: a.dateAdded });
  await eng.queue.enqueue(b.id, { dateAdded: b.dateAdded });
  await eng.sync.drain();
  const ridA = await eng.store.getRaindropId(a.id);
  // A is edited, the upload is queued, then the browser restarts and renumbers.
  bookmarks.get(a.id).title = "A edited";
  await eng.queue.enqueue(a.id, { reason: "change", dateAdded: a.dateAdded });
  const map = renumberBookmarks({ start: Number(a.id), reverse: true });
  await eng.sync.drain(); // moves the job to A's new id
  assert.deepEqual(
    (await eng.queue.list()).map((j) => j.id),
    [map.get(a.id)]
  );
  await eng.sync.drain(); // next wake runs it there
  const rdA = mock._raindrops.get(Number(ridA)) ?? mock._raindrops.get(ridA);
  assert.equal(rdA.title, "A edited", "A's edit lands on A's raindrop");
  assert.equal(await eng.store.getRaindropId(map.get(a.id)), ridA);
  assert.equal(mock._raindrops.size, 3, "no duplicate (A, B, bystander)");
});

test("URL, title and folder all changing on the same bookmark still update its pair", async () => {
  const { eng, mock } = await setupEngine();
  const a = await edgeBookmark("1", "A", "https://id.example/all");
  await eng.queue.enqueue(a.id, { dateAdded: a.dateAdded });
  await eng.sync.drain();
  const rid = await eng.store.getRaindropId(a.id);
  const folder = await edgeFolder("2", "Elsewhere");
  Object.assign(bookmarks.get(a.id), {
    title: "A renamed",
    url: "https://id.example/all-new",
    parentId: folder.id,
  });
  await eng.sync.handleBookmarkChanged(a.id, { title: "A renamed" });
  await eng.sync.drain();
  const rd = mock._raindrops.get(Number(rid)) ?? mock._raindrops.get(rid);
  assert.equal(rd.link, "https://id.example/all-new");
  assert.equal(await eng.store.getRaindropId(a.id), rid, "same pair");
  assert.equal(mock._raindrops.size, 2, "no duplicate (A, bystander)");
});

test("delete-edge removes the pair's bookmark at its new id, not the one at its old id", async () => {
  const { eng, mock, a, b, ridA, bAt, aAt } = await swappedPair();
  mock._raindrops.delete(Number(ridA));
  mock._raindrops.delete(ridA);
  await eng.reconcile.reconcile({ force: true });
  await eng.sync.drain();
  assert.equal(bookmarks.has(aAt), false, "A removed");
  assert.equal(bookmarks.get(bAt)?.url, b.url, "B, now at A's old id, kept");
  assert.equal((await jobsOfKind(eng, "delete-edge")).length, 0);
  void a;
});

test("a restarted offload after a renumber deletes its own bookmark, not the one at its old id", async () => {
  const { eng, mock } = await setupEngine({
    config: { syncMode: "one-way", defaultPolicy: "sync-and-delete" },
  });
  const a = await edgeBookmark("1", "A", "https://id.example/off-a");
  const b = await edgeBookmark("1", "B", "https://id.example/off-b");
  // Offload had stashed A's raindrop id, then the worker died before removeNode.
  const rd = mock._seedRich(null, { link: a.url, title: "A" });
  await eng.store.recordSynced(a.id, rd._id, { url: a.url, dateAdded: a.dateAdded });
  await eng.queue.enqueueJob({
    id: a.id,
    kind: "upload",
    dateAdded: a.dateAdded,
    offloadRaindropId: String(rd._id),
  });
  const map = renumberBookmarks({ start: Number(a.id), reverse: true });
  assert.equal(map.get(b.id), a.id, "B now holds A's old id");
  await eng.sync.drain(); // retargets the job to A's new id
  await eng.sync.drain(); // finishes the offload there
  assert.equal(bookmarks.get(a.id)?.url, b.url, "B kept");
  assert.equal(bookmarks.has(map.get(a.id)), false, "A offloaded");
  assert.equal(await eng.store.hasTombstone(rd._id), true, "A's raindrop tombstoned");
  assert.equal((await eng.queue.list()).length, 0);
});

test("a job whose bookmark is gone after a renumber finishes its offload instead of deleting", async () => {
  const { eng, mock } = await setupEngine({
    config: { syncMode: "one-way", defaultPolicy: "sync-and-delete" },
  });
  const a = await edgeBookmark("1", "A", "https://id.example/off-gone");
  const rd = mock._seedRich(null, { link: a.url, title: "A" });
  await eng.queue.enqueueJob({
    id: a.id,
    kind: "upload",
    dateAdded: a.dateAdded,
    offloadRaindropId: String(rd._id),
  });
  bookmarks.delete(a.id);
  const b = await edgeBookmark("1", "B", "https://id.example/off-b2");
  bookmarks.delete(b.id);
  bookmarks.set(a.id, { ...bookmarks.get(b.id), ...b, id: a.id });
  await eng.sync.drain();
  assert.equal(bookmarks.get(a.id)?.url, b.url, "B (now at A's old id) kept");
  assert.equal(await eng.store.hasTombstone(rd._id), true);
  assert.equal((await eng.queue.list()).length, 0);
});

/** Two synced folders, then a renumber that swaps their ids. */
async function swappedFolders() {
  const { eng, mock } = await setupEngine();
  const work = await edgeFolder("1", "Work");
  const recipes = await edgeFolder("1", "Recipes");
  const a = await edgeBookmark(work.id, "A", "https://id.example/f-a");
  const b = await edgeBookmark(recipes.id, "B", "https://id.example/f-b");
  await eng.queue.enqueue(a.id, { dateAdded: a.dateAdded });
  await eng.queue.enqueue(b.id, { dateAdded: b.dateAdded });
  await eng.sync.drain();
  const workCol = await eng.store.getFolderCollectionId(work.id);
  const recipesCol = await eng.store.getFolderCollectionId(recipes.id);
  assert.ok(workCol != null && recipesCol != null, "both folders mapped");
  const map = renumberBookmarks({ start: Number(work.id), reverse: true });
  assert.equal(map.get(recipes.id), work.id, "Recipes now holds Work's old id");
  const colTitle = (id) =>
    mock._collections.get(Number(id))?.title ?? mock._collections.get(id)?.title;
  return { eng, mock, work, recipes, workCol, recipesCol, map, colTitle };
}

test("a Raindrop folder rename never lands on the folder that reused the id", async () => {
  const { eng, work, recipes, workCol, map } = await swappedFolders();
  await eng.reconcile.reconcile({ force: true });
  assert.deepEqual(
    (await jobsOfKind(eng, "pull-rename-folder")).map((j) => j.folderId),
    [],
    "no rename queued for a reused id"
  );
  await eng.sync.drain();
  assert.equal(bookmarks.get(map.get(work.id)).title, "Work");
  assert.equal(bookmarks.get(map.get(recipes.id)).title, "Recipes");
  // The heal re-derives the map by path, so both folders map again at their new ids.
  await eng.reconcile.reconcile({ force: true });
  assert.equal(await eng.store.getFolderCollectionId(map.get(work.id)), workCol);
});

test("an Edge folder rename at a reused id never renames the other folder's collection", async () => {
  const { eng, work, workCol, recipesCol, colTitle } = await swappedFolders();
  bookmarks.get(work.id).title = "Recipes renamed";
  await eng.sync.handleBookmarkChanged(work.id, { title: "Recipes renamed" });
  await eng.sync.drain();
  assert.equal(colTitle(workCol), "Work", "Work's collection untouched");
  assert.equal(colTitle(recipesCol), "Recipes", "Recipes' collection untouched (mapping stale)");
});

test("legacy folder entries confirm by title and gain dateAdded, or are dropped", async () => {
  const { eng } = await setupEngine();
  const work = await edgeFolder("1", "Work");
  const a = await edgeBookmark(work.id, "A", "https://id.example/legacy-a");
  await eng.queue.enqueue(a.id, { dateAdded: a.dateAdded });
  await eng.sync.drain();
  const col = await eng.store.getFolderCollectionId(work.id);
  const other = await edgeFolder("1", "Unrelated");
  // Legacy shape: bare ids. `other` never synced, so its entry cannot be confirmed.
  await eng.store._write("folderCollections", { [work.id]: col, [other.id]: col });
  await eng.reconcile.reconcile({ force: true });
  const entries = await eng.store.getFolderCollections();
  assert.equal(entries[work.id].collectionId, col);
  assert.equal(entries[work.id].dateAdded, work.dateAdded, "confirmed by title");
  assert.equal(entries[other.id], undefined, "title mismatch: dropped, not renamed");
  assert.equal(bookmarks.get(other.id).title, "Unrelated");
});

test("a bookmark created at a stale paired id still uploads", async () => {
  const { eng, mock } = await setupEngine();
  const a = await edgeBookmark("1", "A", "https://id.example/stale-a");
  await eng.queue.enqueue(a.id, { dateAdded: a.dateAdded });
  await eng.sync.drain();
  const ridA = await eng.store.getRaindropId(a.id);
  const before = mock._raindrops.size;
  const map = renumberBookmarks({ start: Number(a.id) + 5 });
  // A new bookmark lands on A's old id.
  const n = await chrome.bookmarks.create({
    parentId: "1",
    title: "N",
    url: "https://id.example/new",
  });
  bookmarks.delete(n.id);
  bookmarks.set(a.id, { ...n, id: a.id });
  await eng.sync.handleBookmarkCreated(a.id, bookmarks.get(a.id));
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, before + 1, "N uploaded");
  assert.notEqual(await eng.store.getRaindropId(a.id), ridA, "N has its own pair");
  assert.equal(
    await eng.store.getRaindropId(map.get(a.id)),
    ridA,
    "A's pair rehomed to its new id"
  );
});

test("Import ties each job to its bookmark and skips nothing that is really unpaired", async () => {
  const { eng, mock } = await setupEngine();
  const a = await edgeBookmark("1", "A", "https://id.example/imp-a");
  await eng.queue.enqueue(a.id, { dateAdded: a.dateAdded });
  await eng.sync.drain();
  const ridA = await eng.store.getRaindropId(a.id);
  const map = renumberBookmarks({ start: Number(a.id) + 5 });
  const n = await chrome.bookmarks.create({
    parentId: "1",
    title: "N",
    url: "https://id.example/imp-n",
  });
  bookmarks.delete(n.id);
  bookmarks.set(a.id, { ...n, id: a.id });
  const scope = await eng.backfill.scanImportScope();
  assert.ok(scope.unpairedIds.includes(a.id), "N (at A's old id) counts as unpaired");
  assert.equal(scope.dateAddedById.get(a.id), n.dateAdded);
  // A at its new id is unpaired too until rebound; both queue, each tied to its node.
  const { queued } = await eng.backfill.startBackfill();
  assert.equal(queued, 2);
  const byId = new Map((await eng.queue.list()).map((j) => [j.id, j.dateAdded]));
  assert.equal(byId.get(a.id), n.dateAdded);
  assert.equal(byId.get(map.get(a.id)), a.dateAdded);
  await eng.sync.drain();
  assert.equal(mock._raindrops.size, 3, "A reclaimed its raindrop, N created one, bystander");
  assert.equal(await eng.store.getRaindropId(map.get(a.id)), ridA);
});
