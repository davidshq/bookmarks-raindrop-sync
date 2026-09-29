#!/usr/bin/env node
/**
 * Live Raindrop integration tests through the real sync engine.
 *
 * SAFETY:
 * - Edge: in-memory mock only — creates/edits/deletes under
 *   Favorites bar / test-edge-raindrop-sync / … (never your real Edge tree).
 * - Raindrop: real API — all writes under the root collection
 *   `test-edge-raindrop-sync` only; cleaned before and after each scenario.
 * - API rationing: proactive pause when quota is low (same as the extension),
 *   paced pauses between scenarios/deletes (see live-raindrop-scope.mjs), no GET-per-row cleanup loops.
 * - Most Raindrop→Edge scenarios enqueue pull jobs directly (reconcile nested
 *   listing can lag / return stale ids). Pull now wait-and-resume drives the
 *   real pause → resume loop, then pulls the seeded item the same explicit way.
 *
 * Usage:
 *   RAINDROP_TOKEN=… npm run test:integration
 *   RAINDROP_TOKEN=… node scripts/verify-integration.mjs
 */

import assert from "node:assert/strict";
import { runPullNow } from "../src/lib/pull-now.js";
import { JOB } from "../src/lib/constants.js";
import {
  loadToken,
  importEngine,
  resetAll,
  findEdgeByUrl,
  createIntegrationFolder,
  pullNowSend,
  TEST_EDGE_CONTAINER_ID,
  bookmarks,
} from "./lib/test-harness.mjs";
import {
  TEST_ROOT_NAME,
  ensureTestRoot,
  cleanupTestRoot,
  raindropAlive,
  assertCollectionUnderTestRoot,
  ensureCollectionPathUnderRoot,
  putRaindropRichFields,
  verifyTestRootEmpty,
  gateClient,
  pauseBetweenScenarios,
  waitUntilRaindropListed,
} from "./lib/live-raindrop-scope.mjs";
const TOKEN = loadToken();

async function drainWithRetry(client, sync) {
  return gateClient(client, () => sync.drain(), { label: "sync.drain" });
}

/** Fetch a live raindrop and assert its collection stays under the test root. */
async function getRaindropInRoot(client, rootId, raindropId) {
  const live = await gateClient(client, () => client.getRaindrop(raindropId), {
    label: `getRaindrop ${raindropId}`,
  });
  await assertCollectionUnderTestRoot(client, rootId, live.collection?.$id);
  return live;
}

if (!TOKEN) {
  console.error(
    "RAINDROP_TOKEN is required (or .tmp/raindrop_token).\n" +
      "Integration tests hit the live Raindrop API under test-edge-raindrop-sync only."
  );
  process.exit(1);
}

async function liveConfig(store, constants) {
  const { POLICY, SYNC_MODE, RAINDROP_FOLDER_MODE } = constants;
  await store.setConfig({
    token: TOKEN,
    rootName: TEST_ROOT_NAME,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    raindropFolderMode: RAINDROP_FOLDER_MODE.CREATE_AS_NEEDED,
  });
}

/** Print the scenario header, reset mock Edge + storage, write the live config. */
async function beginScenario(eng, title) {
  console.log(`\n== integration: ${title} ==`);
  await resetAll(eng.store, { integration: true });
  await liveConfig(eng.store, eng.constants);
}

/**
 * Create an Edge bookmark in a fresh integration folder, upload it through the
 * engine and return its pair.
 * @returns {Promise<{ folder: object, bm: object, rid: string }>}
 */
async function uploadedBookmark(eng, client, folderTitle, title, url) {
  const folder = await createIntegrationFolder(folderTitle);
  const bm = await chrome.bookmarks.create({ parentId: folder.id, title, url });
  await eng.queue.enqueue(bm.id);
  await drainWithRetry(client, eng.sync);
  const rid = await eng.store.getRaindropId(bm.id);
  assert.ok(rid, "paired after upload");
  return { folder, bm, rid };
}

/**
 * Create a live raindrop in the collection path `segments` under the test root
 * and wait until the leaf listing shows it.
 * @returns {Promise<{ leaf: object, created: object, segments: string[] }>}
 */
async function seedLiveRaindrop(client, rootId, segments, { link, title }, label) {
  const leaf = await ensureCollectionPathUnderRoot(client, rootId, segments);
  const created = await gateClient(
    client,
    () => client.createRaindrop({ link, title, collectionId: leaf._id }),
    { label }
  );
  await assertCollectionUnderTestRoot(client, rootId, created.collection?.$id);
  await waitUntilRaindropListed(client, leaf._id, created._id);
  return { leaf, created, segments };
}

/** Explicit PULL_CREATE for a raindrop from seedLiveRaindrop. */
function pullCreateJob({ leaf, created, segments }) {
  return {
    id: `pull-${created._id}`,
    kind: JOB.PULL_CREATE,
    raindropId: String(created._id),
    link: created.link,
    title: created.title,
    relativeSegments: segments,
    collectionId: String(leaf._id),
  };
}

async function scenarioCreateUpload(eng, client, rootId) {
  await beginScenario(eng, "Edge create → Raindrop upload");
  const { rid } = await uploadedBookmark(
    eng,
    client,
    "Create-Upload",
    "Integration create",
    "https://example.com/ers-integration-create"
  );
  assert.ok(await raindropAlive(client, rid), "live raindrop exists");

  const live = await getRaindropInRoot(client, rootId, rid);
  assert.equal(live.link, "https://example.com/ers-integration-create");
  assert.equal(live.title, "Integration create");
  console.log("  ✔ upload created live raindrop under test root");
}

async function scenarioUpdateTitleUrl(eng, client, rootId) {
  await beginScenario(eng, "Edge title/URL change → Raindrop update");
  const { sync } = eng;
  const { bm, rid } = await uploadedBookmark(
    eng,
    client,
    "Update",
    "Before update",
    "https://example.com/ers-integration-update"
  );

  await putRaindropRichFields(client, rid, {
    tags: ["integration-keep"],
    note: "preserve-me",
  });

  bookmarks.get(bm.id).title = "After update";
  bookmarks.get(bm.id).url = "https://example.com/ers-integration-update-v2";
  await sync.handleBookmarkChanged(bm.id, {
    title: "After update",
    url: "https://example.com/ers-integration-update-v2",
  });
  await drainWithRetry(client, sync);

  const live = await getRaindropInRoot(client, rootId, rid);
  assert.equal(live.title, "After update");
  assert.equal(live.link, "https://example.com/ers-integration-update-v2");
  assert.ok(live.tags?.includes("integration-keep"), "tags preserved on partial PUT");
  assert.equal(live.note, "preserve-me", "note preserved");
  console.log("  ✔ title/URL updated live; rich fields kept");
}

async function scenarioEdgeDelete(eng, client, rootId) {
  await beginScenario(eng, "Edge delete → Raindrop delete");
  const { store, sync } = eng;
  const { folder, bm, rid } = await uploadedBookmark(
    eng,
    client,
    "Edge-Delete",
    "Delete me",
    "https://example.com/ers-integration-edge-delete"
  );
  await getRaindropInRoot(client, rootId, rid);

  await chrome.bookmarks.remove(bm.id);
  await sync.handleBookmarkRemoved(bm.id, { parentId: folder.id });
  await drainWithRetry(client, sync);

  assert.equal(await raindropAlive(client, rid), false, "raindrop removed from library");
  assert.equal(await store.hasTombstone(String(rid)), true, "tombstone recorded");
  console.log("  ✔ Edge delete propagated to live Raindrop");
}

async function scenarioPullCreate(eng, client, rootId) {
  await beginScenario(eng, "Raindrop create → Edge pull");
  const { store, sync, queue } = eng;
  const seeded = await seedLiveRaindrop(
    client,
    rootId,
    ["Favorites bar", "Integration-Pull"],
    { link: "https://example.com/ers-integration-pull", title: "Pulled from Raindrop" },
    "seed pull raindrop"
  );
  const { created } = seeded;
  await getRaindropInRoot(client, rootId, created._id);

  // Reconcile listing can lag behind collection-scoped lists; enqueue pull explicitly
  // once the live item exists (still exercises real Raindrop data + engine drain).
  await queue.enqueueJob(pullCreateJob(seeded));
  await drainWithRetry(client, sync);

  const edge = findEdgeByUrl("https://example.com/ers-integration-pull");
  assert.ok(edge, "bookmark pulled into mock Edge");
  assert.equal(edge.title, "Pulled from Raindrop");
  assert.equal(await store.getBookmarkIdForRaindrop(String(created._id)), edge.id, "pair recorded");

  const parent = (await chrome.bookmarks.get(edge.parentId))[0];
  assert.equal(parent.title, "Integration-Pull");
  console.log("  ✔ Raindrop item pulled into isolated Edge folder");
}

async function scenarioRaindropDelete(eng, client, rootId) {
  await beginScenario(eng, "Raindrop delete → Edge delete");
  const { store, sync, queue } = eng;
  const seeded = await seedLiveRaindrop(
    client,
    rootId,
    ["Favorites bar", "Integration-Remote-Del"],
    { link: "https://example.com/ers-integration-remote-delete", title: "Remote delete" },
    "seed remote-delete raindrop"
  );
  const { created } = seeded;

  await queue.enqueueJob(pullCreateJob(seeded));
  await drainWithRetry(client, sync);
  const edge = findEdgeByUrl("https://example.com/ers-integration-remote-delete");
  assert.ok(edge, "paired before remote delete");

  await gateClient(client, () => client.deleteRaindrop(created._id), {
    label: "remote delete raindrop",
  });
  assert.equal(await raindropAlive(client, created._id), false, "raindrop trashed");

  await queue.enqueueJob({
    id: `de-${created._id}`,
    kind: JOB.DELETE_EDGE,
    raindropId: String(created._id),
    bookmarkId: edge.id,
  });
  await drainWithRetry(client, sync);

  assert.equal(
    !!findEdgeByUrl("https://example.com/ers-integration-remote-delete"),
    false,
    "Edge bookmark removed"
  );
  assert.equal(await store.hasTombstone(String(created._id)), true);
  console.log("  ✔ Raindrop delete propagated to mock Edge");
}

async function scenarioMove(eng, client, rootId) {
  await beginScenario(eng, "Edge move → Raindrop collection update");
  const { sync } = eng;
  const {
    folder: src,
    bm,
    rid,
  } = await uploadedBookmark(
    eng,
    client,
    "Move-Src",
    "Move me",
    "https://example.com/ers-integration-move"
  );
  const dest = await createIntegrationFolder("Move-Dest");
  const beforeCol = (await getRaindropInRoot(client, rootId, rid)).collection?.$id;
  await putRaindropRichFields(client, rid, { tags: ["move-keep"], note: "move-note" });

  bookmarks.get(bm.id).parentId = dest.id;
  await sync.handleBookmarkMoved(bm.id, { oldParentId: src.id, parentId: dest.id });
  await drainWithRetry(client, sync);

  const after = await getRaindropInRoot(client, rootId, rid);
  assert.notEqual(after.collection?.$id, beforeCol, "collection changed");
  assert.ok(after.tags?.includes("move-keep"), "tags intact after move");
  assert.equal(after.note, "move-note", "note intact after move");
  console.log("  ✔ move updated live Raindrop placement");
}

async function scenarioEdgeFolderRename(eng, client, rootId) {
  await beginScenario(eng, "Edge folder rename → Raindrop collection rename");
  const { store, sync } = eng;
  const { folder, bm, rid } = await uploadedBookmark(
    eng,
    client,
    "Rename-Old",
    "In renamed folder",
    "https://example.com/ers-integration-folder-rename"
  );
  const colId = await store.getFolderCollectionId(folder.id);
  assert.ok(colId != null, "folder mapped to collection");

  bookmarks.get(folder.id).title = "Rename-New";
  await sync.handleBookmarkChanged(folder.id, { title: "Rename-New" });
  await drainWithRetry(client, sync);

  const col = await gateClient(client, () => client.request("GET", `/collection/${colId}`), {
    label: "get collection after rename",
  });
  assert.equal(col.item?.title, "Rename-New", "live collection renamed");
  await assertCollectionUnderTestRoot(client, rootId, colId);

  assert.equal(await store.getRaindropId(bm.id), rid, "pair survives folder rename");
  const item = await getRaindropInRoot(client, rootId, rid);
  assert.equal(
    Number(item.collection?.$id),
    Number(colId),
    "bookmark stayed on renamed collection"
  );
  console.log("  ✔ Edge folder rename updated live Raindrop collection");
}

async function scenarioRaindropPullUpdate(eng, client, rootId) {
  await beginScenario(eng, "Raindrop edit → Edge pull-update");
  const { sync, queue } = eng;
  const { bm, rid } = await uploadedBookmark(
    eng,
    client,
    "Pull-Update",
    "Original pull title",
    "https://example.com/ers-integration-pull-update"
  );
  await getRaindropInRoot(client, rootId, rid);

  const otherLeaf = await ensureCollectionPathUnderRoot(client, rootId, [
    "Favorites bar",
    "Pull-Update-Dest",
  ]);
  await gateClient(
    client,
    () =>
      client.updateRaindrop(rid, {
        title: "Updated from Raindrop",
        link: "https://example.com/ers-integration-pull-update-v2",
        collectionId: otherLeaf._id,
      }),
    { label: "Raindrop pull-update seed" }
  );

  await queue.enqueueJob({
    id: `pu-${rid}`,
    kind: JOB.PULL_UPDATE,
    raindropId: String(rid),
    bookmarkId: bm.id,
    link: "https://example.com/ers-integration-pull-update-v2",
    title: "Updated from Raindrop",
    relativeSegments: ["Favorites bar", "Pull-Update-Dest"],
    collectionId: String(otherLeaf._id),
  });
  await drainWithRetry(client, sync);

  await getRaindropInRoot(client, rootId, rid);

  const updated = findEdgeByUrl("https://example.com/ers-integration-pull-update-v2");
  assert.ok(updated, "Edge URL updated");
  assert.equal(updated.title, "Updated from Raindrop");
  assert.equal(updated.id, bm.id, "same bookmark id");
  const parent = (await chrome.bookmarks.get(updated.parentId))[0];
  assert.equal(parent.title, "Pull-Update-Dest");
  console.log("  ✔ Raindrop edit pulled to mock Edge");
}

async function scenarioRaindropFolderRename(eng, client, rootId) {
  await beginScenario(eng, "Raindrop folder rename → Edge folder rename");
  const { store, queue, sync } = eng;
  const { folder } = await uploadedBookmark(
    eng,
    client,
    "Rain-Rename-Old",
    "Folder rename probe",
    "https://example.com/ers-integration-rain-folder-rename"
  );
  const colId = await store.getFolderCollectionId(folder.id);
  assert.ok(colId);
  await assertCollectionUnderTestRoot(client, rootId, colId);

  await gateClient(client, () => client.updateCollection(colId, { title: "Rain-Rename-New" }), {
    label: "Raindrop folder rename seed",
  });
  await queue.enqueueJob({
    id: `ref-${folder.id}`,
    kind: JOB.PULL_RENAME_FOLDER,
    folderId: String(folder.id),
    collectionId: String(colId),
    title: "Rain-Rename-New",
  });
  await drainWithRetry(client, sync);

  const renamed = (await chrome.bookmarks.get(folder.id))[0];
  assert.equal(renamed.title, "Rain-Rename-New");
  console.log("  ✔ Raindrop collection rename pulled to mock Edge folder");
}

/**
 * Live Pull now wait-and-resume under test-edge-raindrop-sync only.
 *
 * Raindrop nested listing under the root can lag / return stale ids (leaf list
 * is current) — same reason other Raindrop→Edge live scenarios enqueue pulls.
 * This scenario still drives the real runPullNow → reconcileNow loop through a
 * durable rateLimitedUntil pause, then pulls the seeded live item via an
 * explicit PULL_CREATE + drain (live API + engine), without touching anything
 * outside the test root.
 */
async function scenarioPullNowWaitAndResume(eng, client, rootId) {
  await beginScenario(eng, "Pull now waits out rate limit and resumes");
  const { store, sync, queue } = eng;
  const link = "https://example.com/ers-integration-pull-now-wait";
  const seeded = await seedLiveRaindrop(
    client,
    rootId,
    ["Favorites bar", "Integration-PullNow-Wait"],
    { link, title: "Pull now wait resume" },
    "seed pull-now-wait raindrop"
  );
  const { created } = seeded;
  await getRaindropInRoot(client, rootId, created._id);

  // Synthetic pause = same store gate as HTTP 429 / proactive budget stop
  // (avoids burning account quota to force a real 429).
  await store.noteRateLimitedUntil(Date.now() + 5_000);

  let slept = 0;
  let reconcilePasses = 0;
  const send = pullNowSend(eng, { onReconcile: () => reconcilePasses++ });
  const { text } = await runPullNow(send, {
    sleepFn: async () => {
      slept++;
      await store.clearRateLimit();
    },
  });

  assert.equal(slept, 1, "Pull now waited out the rate-limit pause once");
  assert.ok(reconcilePasses >= 2, "skipped once under pause, then resumed reconcileNow");
  assert.equal(await store.isRateLimited(), false, "pause cleared before resume pass");
  assert.match(text, /Pull finished/);

  // Live nested root list can be stale; pull the seeded item explicitly (same
  // pattern as scenarioPullCreate) after wait-and-resume already ran.
  await queue.enqueueJob(pullCreateJob(seeded));
  await drainWithRetry(client, sync);

  const edge = findEdgeByUrl(link);
  assert.ok(edge, "seeded live raindrop pulled into mock Edge");
  assert.equal(edge.title, "Pull now wait resume");
  assert.equal(
    await store.getBookmarkIdForRaindrop(String(created._id)),
    edge.id,
    "pair maps only our seeded raindrop"
  );
  const parent = (await chrome.bookmarks.get(edge.parentId))[0];
  assert.equal(parent.title, "Integration-PullNow-Wait");
  assert.ok(await raindropAlive(client, created._id), "seed raindrop still alive under test root");
  await assertCollectionUnderTestRoot(client, rootId, created.collection?.$id);

  console.log("  ✔ Pull now waited/resumed; seeded live raindrop pulled under test root");
}

/** Run each scenario, cleaning the test root after each and pausing between them. */
async function runScenarios(eng, client, rootId, scenarios) {
  for (const [i, scenario] of scenarios.entries()) {
    await scenario(eng, client, rootId);
    await gateClient(client, () => cleanupTestRoot(client, rootId), { label: "cleanupTestRoot" });
    if (i < scenarios.length - 1) await pauseBetweenScenarios();
  }
}

async function main() {
  console.log("Integration mode: mock Edge + live Raindrop");
  console.log(`Edge container: Favorites bar / ${TEST_ROOT_NAME} (id ${TEST_EDGE_CONTAINER_ID})`);
  console.log(`Raindrop root:  ${TEST_ROOT_NAME}`);

  const eng = await importEngine();
  const client = new eng.raindropMod.RaindropClient(TOKEN);

  let rootId;
  try {
    ({ rootId } = await gateClient(client, () => ensureTestRoot(client), {
      label: "ensureTestRoot",
    }));
    console.log(`Using Raindrop test root _id=${rootId}`);

    await runScenarios(eng, client, rootId, [
      scenarioCreateUpload,
      scenarioUpdateTitleUrl,
      scenarioEdgeDelete,
      scenarioPullCreate,
      scenarioRaindropDelete,
      scenarioMove,
      scenarioEdgeFolderRename,
      scenarioRaindropPullUpdate,
      scenarioRaindropFolderRename,
      scenarioPullNowWaitAndResume,
    ]);
  } finally {
    if (rootId != null) {
      await gateClient(client, () => cleanupTestRoot(client, rootId), { label: "final cleanup" });
      await gateClient(client, () => verifyTestRootEmpty(client, rootId), {
        label: "verifyTestRootEmpty",
      });
      console.log("\n  ✔ final Raindrop cleanup — test root empty");
    }
  }

  console.log("\nAll integration scenarios passed.");
}

main().catch(async (err) => {
  console.error("\nINTEGRATION FAILED:", err);
  process.exit(1);
});
