// Engine test setup: fresh in-memory storage + Edge tree, a fake Raindrop
// client patched onto RaindropClient, and a bidirectional config with a sync
// root collection. One call per test; each test file runs in its own process.

import {
  importEngine,
  resetAll,
  patchClient,
  bookmarks,
  storage,
} from "../../scripts/lib/test-harness.mjs";
import { makeMockRaindrop } from "./fake-raindrop.mjs";

export { bookmarks, storage };

/** Stable test root; Raindrop sync-root collection has the same title. */
export const ROOT_NAME = "ERS-Test";

/**
 * @param {{ config?: object }} [opts]
 */
export async function setupEngine({ config = {} } = {}) {
  const eng = await importEngine();
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);
  const { SYNC_MODE, POLICY } = eng.constants;
  await eng.store.setConfig({
    token: "mock",
    rootName: ROOT_NAME,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    ...config,
  });
  const root = await mock.createCollection(ROOT_NAME, null);
  // Unrelated live raindrop so tests that delete raindrops never empty the
  // library (an empty export while pairs exist is incomplete by design).
  mock._seedRich(root._id, { link: "https://example.com/ers-bystander", title: "bystander" });
  const presence = await import("../../src/lib/presence.js");
  const pairRebind = await import("../../src/lib/pair-rebind.js");
  const treeIndex = await import("../../src/lib/tree-index.js");
  return { eng, mock, root, presence, pairRebind, treeIndex };
}

/** Create a URL bookmark in the fake Edge tree. */
export async function edgeBookmark(parentId, title, url) {
  return chrome.bookmarks.create({ parentId: String(parentId), title, url });
}

/** Create a folder in the fake Edge tree. */
export async function edgeFolder(parentId, title) {
  return chrome.bookmarks.create({ parentId: String(parentId), title });
}

/** Queued jobs of one kind. */
export async function jobsOfKind(eng, kind) {
  return (await eng.queue.list()).filter((j) => eng.queue.jobKind(j) === kind);
}
