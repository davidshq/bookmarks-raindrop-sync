/**
 * Live Raindrop helpers scoped to the integration test root collection.
 * All creates/deletes stay under `test-edge-raindrop-sync` — never pre-existing data.
 *
 * API rationing mirrors the extension: pause when X-RateLimit-Remaining is low,
 * back off on 429, avoid redundant GETs (especially during cleanup).
 */

import { RATE_LIMIT_RESERVE, RAINDROP_LIST_PER_PAGE } from "../../src/lib/constants.js";
import { isNotFoundError, RateLimitError } from "../../src/lib/raindrop.js";

/** Fixed Raindrop root collection for integration tests (reused across runs). */
export const TEST_ROOT_NAME = "test-edge-raindrop-sync";

/** Integration API pacing — tune here if Raindrop quota is tight or runs are flaky. */
export const INTER_SCENARIO_PAUSE_MS = 6000;
export const LIST_SETTLE_MS = 2000;
export const INTER_DELETE_PAUSE_MS = 350;
export const MAX_RATE_RETRIES = 3;
/** Safety stop for listAllUnderRoot (the test root should hold a handful of items). */
const MAX_LIST_PAGES = 100;

/**
 * Poll list until a raindrop id appears (Raindrop list can lag behind create).
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} collectionId leaf collection (avoids stale root nested pages)
 * @param {number|string} raindropId
 * @param {number} [maxWaitMs]
 */
export async function waitUntilRaindropListed(client, collectionId, raindropId, maxWaitMs = 15000) {
  const want = String(raindropId);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { items } = await gateClient(
      client,
      () => client.listRaindrops(collectionId, { nested: false, page: 0, perPage: 50 }),
      { label: "waitUntilRaindropListed" }
    );
    if (items.some((i) => String(i._id) === want)) return;
    await sleep(LIST_SETTLE_MS);
  }
  throw new Error(
    `raindrop ${raindropId} not visible in collection ${collectionId} within ${maxWaitMs}ms`
  );
}

/** @type {{ all: object[], byId: Map<number|string, object> } | null} */
let collectionIndexCache = null;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a Raindrop client call with the same rationing posture as the extension:
 * proactive pause when quota is low, limited 429 retries (no retry storms).
 *
 * @template T
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {() => Promise<T>} fn
 * @param {{ label?: string, maxAttempts?: number }} [opts]
 */
export async function gateClient(
  client,
  fn,
  { label = "Raindrop API", maxAttempts = MAX_RATE_RETRIES } = {}
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (client.shouldPause()) {
      const wait = Math.max(500, client.pauseUntil() - Date.now() + 200);
      console.warn(
        `  ⏸ ${label}: quota ≤${RATE_LIMIT_RESERVE}, waiting ${Math.ceil(wait / 1000)}s`
      );
      await sleep(wait);
    }
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimitError) || attempt === maxAttempts) throw err;
      const wait = Math.max(1000, (err.retryAt ?? Date.now() + 5000) - Date.now() + 500);
      console.warn(
        `  ⏳ ${label}: 429, waiting ${Math.ceil(wait / 1000)}s (${attempt}/${maxAttempts})`
      );
      await sleep(wait);
    }
  }
  throw new Error("gateClient: unreachable");
}

export function invalidateCollectionIndex() {
  collectionIndexCache = null;
}

/**
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {{ refresh?: boolean }} [opts]
 */
async function loadCollectionIndex(client, { refresh = false } = {}) {
  if (!refresh && collectionIndexCache) return collectionIndexCache;

  const roots = await gateClient(client, () => client.getRootCollections(), {
    label: "getRootCollections",
  });
  const children = await gateClient(client, () => client.getChildCollections(), {
    label: "getChildCollections",
  });
  const all = [...roots, ...children];
  const byId = new Map();
  for (const col of all) {
    byId.set(col._id, col);
    byId.set(String(col._id), col);
  }
  collectionIndexCache = { all, byId };
  return collectionIndexCache;
}

/**
 * @param {object} col
 * @param {number|string} ancestorId
 * @param {Map<number|string, object>} byId
 */
function isDescendantOf(col, ancestorId, byId) {
  let cur = col;
  const target = Number(ancestorId);
  while (cur) {
    if (Number(cur._id) === target) return true;
    const pid = cur.parent?.$id;
    if (pid == null) return false;
    cur = byId.get(pid) ?? byId.get(String(pid));
  }
  return false;
}

function collectionDepth(col, byId) {
  let depth = 0;
  let cur = col;
  while (cur?.parent?.$id != null) {
    depth++;
    cur = byId.get(cur.parent.$id) ?? byId.get(String(cur.parent.$id));
  }
  return depth;
}

/** True when a list payload row is still in the library (avoid GET per row). */
function listItemInLibrary(item) {
  return item != null && item.removed !== true && item._id != null;
}

/**
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} id
 */
export async function permanentDeleteRaindrop(client, id) {
  await gateClient(
    client,
    async () => {
      // First DELETE moves it to Trash; the second removes it from Trash.
      for (let pass = 0; pass < 2; pass++) {
        try {
          await client.deleteRaindrop(id);
        } catch (err) {
          if (!isNotFoundError(err)) throw err;
        }
      }
    },
    { label: `delete raindrop ${id}` }
  );
}

/**
 * Every raindrop in the nested listing under the test root, paging until a
 * short page (a single page only covers the first RAINDROP_LIST_PER_PAGE items).
 *
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} rootId
 * @param {string} label
 */
export async function listAllUnderRoot(client, rootId, label) {
  const all = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { items } = await gateClient(
      client,
      () => client.listRaindrops(rootId, { nested: true, page, perPage: RAINDROP_LIST_PER_PAGE }),
      { label: `${label} page ${page}` }
    );
    all.push(...items);
    if (items.length < RAINDROP_LIST_PER_PAGE) return all;
  }
  throw new Error(`${label}: more than ${MAX_LIST_PAGES} pages under test root ${rootId}`);
}

/**
 * Remove raindrops and nested collections under the test root (keeps the root).
 * One full listing + targeted deletes — no GET-per-row confirmation loop.
 *
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} rootId
 */
export async function cleanupTestRoot(client, rootId) {
  const items = await listAllUnderRoot(client, rootId, "cleanup listRaindrops");

  for (const item of items) {
    if (!listItemInLibrary(item)) continue;
    await permanentDeleteRaindrop(client, item._id);
    await sleep(INTER_DELETE_PAUSE_MS);
  }

  invalidateCollectionIndex();
  const { all, byId } = await loadCollectionIndex(client, { refresh: true });
  const descendants = all
    .filter((c) => Number(c._id) !== Number(rootId) && isDescendantOf(c, rootId, byId))
    .sort((a, b) => collectionDepth(b, byId) - collectionDepth(a, byId));

  for (const col of descendants) {
    await gateClient(client, () => client.request("DELETE", `/collection/${col._id}`), {
      label: `delete collection ${col._id}`,
    }).catch(() => {
      /* may already be gone */
    });
    await sleep(INTER_DELETE_PAUSE_MS);
  }
  invalidateCollectionIndex();
}

/**
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 */
export async function ensureTestRoot(client) {
  await gateClient(client, () => client.getUser(), { label: "getUser" });

  const roots = await gateClient(client, () => client.getRootCollections(), {
    label: "getRootCollections",
  });
  const matches = roots.filter(
    (c) => (c.title || "").toLowerCase() === TEST_ROOT_NAME.toLowerCase()
  );

  if (matches.length > 1) {
    throw new Error(
      `Multiple "${TEST_ROOT_NAME}" root collections (${matches.map((m) => m._id).join(", ")}). ` +
        "Delete extras in Raindrop before running integration tests."
    );
  }

  const root =
    matches.length === 0
      ? await gateClient(client, () => client.createCollection(TEST_ROOT_NAME, null), {
          label: "create test root",
        })
      : matches[0];

  invalidateCollectionIndex();
  await cleanupTestRoot(client, root._id);
  return { rootId: root._id, rootCollection: root };
}

/**
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} rootId
 */
export async function verifyTestRootEmpty(client, rootId) {
  const items = await listAllUnderRoot(client, rootId, "verify listRaindrops");
  // List can include stale ids; confirm with GET (once at end — not in cleanup loops).
  let liveCount = 0;
  for (const item of items) {
    if (!listItemInLibrary(item)) continue;
    if (await raindropAlive(client, item._id)) liveCount++;
  }
  if (liveCount) {
    throw new Error(`test root not empty: ${liveCount} live raindrop(s) remain`);
  }

  const { all, byId } = await loadCollectionIndex(client);
  const descendants = all.filter(
    (c) => Number(c._id) !== Number(rootId) && isDescendantOf(c, rootId, byId)
  );
  if (descendants.length) {
    throw new Error(`test root not empty: ${descendants.length} nested collection(s) remain`);
  }
}

/**
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} rootId
 * @param {number|string} collectionId
 */
export async function assertCollectionUnderTestRoot(client, rootId, collectionId) {
  let { byId } = await loadCollectionIndex(client);
  let col = byId.get(Number(collectionId)) ?? byId.get(String(collectionId));
  if (!col) {
    invalidateCollectionIndex();
    ({ byId } = await loadCollectionIndex(client, { refresh: true }));
    col = byId.get(Number(collectionId)) ?? byId.get(String(collectionId));
  }
  if (!col) throw new Error(`collection ${collectionId} not found`);
  if (Number(col._id) !== Number(rootId) && !isDescendantOf(col, rootId, byId)) {
    throw new Error(
      `SAFETY: collection ${collectionId} ("${col.title}") is outside "${TEST_ROOT_NAME}"`
    );
  }
}

/**
 * True when the raindrop is still in the library (GET — use sparingly, not in cleanup loops).
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} id
 */
export async function raindropAlive(client, id) {
  return gateClient(
    client,
    async () => {
      try {
        const item = await client.getRaindrop(id);
        return !item.removed;
      } catch (err) {
        if (isNotFoundError(err)) return false;
        throw err;
      }
    },
    { label: `getRaindrop ${id}` }
  );
}

/**
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 * @param {number|string} rootId
 * @param {string[]} segmentTitles
 */
export async function ensureCollectionPathUnderRoot(client, rootId, segmentTitles) {
  let parentId = rootId;
  let leaf = null;
  const { all } = await loadCollectionIndex(client);

  for (const title of segmentTitles) {
    const existing = all.find(
      (c) =>
        (c.title || "") === title &&
        (Number(c.parent?.$id) === Number(parentId) || String(c.parent?.$id) === String(parentId))
    );
    if (existing) {
      leaf = existing;
      parentId = existing._id;
      continue;
    }
    leaf = await gateClient(client, () => client.createCollection(title, parentId), {
      label: `create collection ${title}`,
    });
    all.push(leaf);
    parentId = leaf._id;
    invalidateCollectionIndex();
    await assertCollectionUnderTestRoot(client, rootId, leaf._id);
  }
  return leaf;
}

/**
 * Seed tags/note on a live raindrop (integration-only; sync engine never clears these).
 * @param {import("../../src/lib/raindrop.js").RaindropClient} client
 */
export async function putRaindropRichFields(client, raindropId, { tags, note }) {
  const body = {};
  if (tags != null) body.tags = tags;
  if (note != null) body.note = note;
  await gateClient(client, () => client.request("PUT", `/raindrop/${raindropId}`, body), {
    label: `putRaindropRichFields ${raindropId}`,
  });
}

export function pauseBetweenScenarios() {
  return sleep(INTER_SCENARIO_PAUSE_MS);
}
