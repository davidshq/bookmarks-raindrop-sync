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
 * Write the mock config: token "mock", ROOT_NAME, bidirectional, sync-and-keep,
 * then `overrides`. setConfig merges, so call this after resetAll (or to
 * restate every base field); use store.setConfig for a partial patch.
 *
 * @param {Awaited<ReturnType<typeof importEngine>>} eng
 * @param {object} [overrides]
 */
export async function configureMock(eng, overrides = {}) {
  const { SYNC_MODE, POLICY } = eng.constants;
  await eng.store.setConfig({
    token: "mock",
    rootName: ROOT_NAME,
    syncMode: SYNC_MODE.BIDIRECTIONAL,
    defaultPolicy: POLICY.SYNC_KEEP,
    ...overrides,
  });
}

/**
 * @param {{ config?: object, seedRoot?: boolean, bystander?: boolean }} [opts]
 *   seedRoot: create the sync-root collection (titled config.rootName ?? ROOT_NAME)
 *   in the fake Raindrop; `root` is null when false.
 *   bystander: seed one unrelated live raindrop under that root (needs seedRoot).
 */
export async function setupEngine({ config = {}, seedRoot = true, bystander = true } = {}) {
  const eng = await importEngine();
  await resetAll(eng.store);
  const mock = makeMockRaindrop();
  patchClient(eng.raindropMod, mock);
  await configureMock(eng, config);
  const root = seedRoot ? await mock.createCollection(config.rootName ?? ROOT_NAME, null) : null;
  // Unrelated live raindrop so tests that delete raindrops never empty the
  // library (an empty export while pairs exist is incomplete by design).
  if (root && bystander) {
    mock._seedRich(root._id, { link: "https://example.com/ers-bystander", title: "bystander" });
  }
  const { presence, pairRebind, treeIndex } = eng;
  return { eng, mock, root, presence, pairRebind, treeIndex };
}

/** Take a fresh presence snapshot from the fake Raindrop (as Pull now does). */
export async function warmPresence(eng) {
  return eng.presence.ensurePresence({
    client: new eng.raindropMod.RaindropClient("mock"),
    reason: "pull-now",
  });
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
