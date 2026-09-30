/**
 * Shared in-memory Edge / chrome.storage mocks for verify scripts.
 * Used by test/*.test.mjs and verify-integration.mjs — keep mocks here, not
 * duplicated. Importing this module installs the chrome.* mocks; scripts that
 * only need the token import ./token.mjs instead.
 * Never touches the real Edge bookmark tree.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, loadToken } from "./token.mjs";

export { loadToken };

/** @deprecated use scriptsRoot — kept for importers that expect repoRoot */
export const ROOT = REPO_ROOT;
export const scriptsRoot = ROOT;

/** In-memory extension storage and bookmark tree (disposable). */
export const storage = new Map();
export const bookmarks = new Map();

/** Edge folder id for the isolated integration container (under Favorites bar). */
export const TEST_EDGE_CONTAINER_ID = "10";

let bmSeq = 100;
/** dateAdded clock: unique, increasing ms like real creation times. */
let dateSeq = 1_700_000_000_000;

export function bmNode(partial) {
  const id = String(partial.id ?? ++bmSeq);
  const node = {
    id,
    title: partial.title ?? "",
    url: partial.url,
    parentId: partial.parentId,
    children: partial.children,
    dateAdded: partial.dateAdded ?? ++dateSeq,
  };
  bookmarks.set(id, node);
  return node;
}

/**
 * Reassign every non-root bookmark id the way Chromium does on a load that
 * needs recovery: depth-first from the root, dateAdded kept. Ids are handed
 * out from `start`; `reverse` walks children last-first so old and new ids
 * overlap on different bookmarks.
 * @param {{ start?: number, reverse?: boolean }} [opts]
 * @returns {Map<string, string>} old id → new id
 */
export function renumberBookmarks({ start = 101, reverse = false } = {}) {
  const fixed = new Set(["0", "1", "2"]);
  const order = [];
  const walk = (id) => {
    const kids = [...bookmarks.values()].filter((n) => n.parentId === id);
    if (reverse) kids.reverse();
    for (const k of kids) {
      if (!fixed.has(k.id)) order.push(k.id);
      walk(k.id);
    }
  };
  walk("0");
  const map = new Map(order.map((old, i) => [old, String(start + i)]));
  const nodes = [...bookmarks.values()];
  bookmarks.clear();
  for (const n of nodes) {
    const id = map.get(n.id) ?? n.id;
    const parentId = n.parentId != null ? (map.get(n.parentId) ?? n.parentId) : n.parentId;
    bookmarks.set(id, { ...n, id, parentId });
  }
  bmSeq = Math.max(bmSeq, start + order.length);
  return map;
}

/** Reset the tree to the invisible root "0" plus the two top-level folders. */
function seedRoots(barTitle, otherTitle) {
  bookmarks.clear();
  bmSeq = 100;
  bmNode({ id: "0", title: "", parentId: undefined, children: undefined });
  bmNode({ id: "1", title: barTitle, parentId: "0" });
  bmNode({ id: "2", title: otherTitle, parentId: "0" });
}

/** Seed Favorites bar + Other favorites only (Edge-shaped titles). */
export function seedEdge() {
  seedRoots("Favorites bar", "Other favorites");
}

/** Seed Bookmarks bar + Other bookmarks (Chrome-shaped titles). */
export function seedChrome() {
  seedRoots("Bookmarks bar", "Other bookmarks");
}

/** Stored node or the same error chrome.bookmarks throws for a missing id. */
function mustGet(id) {
  const n = bookmarks.get(String(id));
  if (!n) throw new Error("Bookmark not found");
  return n;
}

/** Copy of a node; folders get their children attached recursively. */
function withChildren(node) {
  const copy = { ...node };
  if (!copy.url) {
    copy.children = [...bookmarks.values()].filter((c) => c.parentId === copy.id).map(withChildren);
  }
  return copy;
}

/**
 * Seed Edge with an isolated `test-edge-raindrop-sync` folder under Favorites bar.
 * All integration scenarios should create bookmarks only inside this container.
 */
export function seedIntegrationEdge() {
  seedEdge();
  bmNode({
    id: TEST_EDGE_CONTAINER_ID,
    title: "test-edge-raindrop-sync",
    parentId: "1",
  });
}

export function installChromeMocks() {
  globalThis.chrome = {
    storage: {
      local: {
        QUOTA_BYTES: 10_485_760,
        async getBytesInUse() {
          let n = 0;
          for (const v of storage.values()) n += JSON.stringify(v).length;
          return n;
        },
        async get(key) {
          if (typeof key === "string") {
            if (!storage.has(key)) return {};
            return { [key]: structuredClone(storage.get(key)) };
          }
          const out = {};
          for (const k of Object.keys(key)) {
            if (storage.has(k)) out[k] = structuredClone(storage.get(k));
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storage.set(k, structuredClone(v));
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
        },
      },
    },
    bookmarks: {
      async get(id) {
        return [{ ...mustGet(id) }];
      },
      async getChildren(id) {
        return [...bookmarks.values()]
          .filter((n) => n.parentId === String(id))
          .map((n) => ({ ...n }));
      },
      async getTree() {
        return [withChildren(bookmarks.get("0"))];
      },
      async getSubTree(id) {
        return [withChildren(mustGet(id))];
      },
      async create({ parentId, title, url }) {
        return bmNode({ parentId: String(parentId), title, url });
      },
      async remove(id) {
        const n = mustGet(id);
        if (!n.url) {
          const kids = [...bookmarks.values()].filter((c) => c.parentId === String(id));
          if (kids.length) throw new Error("Folder not empty");
        }
        bookmarks.delete(String(id));
      },
      async update(id, patch) {
        const n = mustGet(id);
        if (patch.title !== undefined) n.title = patch.title;
        if (patch.url !== undefined) n.url = patch.url;
        return { ...n };
      },
      async move(id, destination) {
        const n = mustGet(id);
        if (destination.parentId !== undefined) n.parentId = String(destination.parentId);
        if (destination.index !== undefined) n.index = destination.index;
        return { ...n };
      },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
    },
  };
}

export async function importEngine() {
  const base = pathToFileURL(path.join(ROOT, "src/lib")).href;
  const constants = await import(`${base}/constants.js`);
  const store = await import(`${base}/store.js`);
  const queue = await import(`${base}/queue.js`);
  const sync = await import(`${base}/sync.js`);
  const reconcile = await import(`${base}/reconcile.js`);
  const raindropMod = await import(`${base}/raindrop.js`);
  const backfill = await import(`${base}/backfill.js`);
  const matchExisting = await import(`${base}/match-existing.js`);
  const queueBulkPrompt = await import(`${base}/queue-bulk-prompt.js`);
  const bulkCandidate = await import(`${base}/bulk-candidate.js`);
  const wakeBudget = await import(`${base}/wake-budget.js`);
  const reconcileFinish = await import(`${base}/reconcile-finish.js`);
  const repairPairs = await import(`${base}/repair-pairs.js`);
  const drainMod = await import(`${base}/drain.js`);
  const presence = await import(`${base}/presence.js`);
  const pairRebind = await import(`${base}/pair-rebind.js`);
  const treeIndex = await import(`${base}/tree-index.js`);
  return {
    presence,
    pairRebind,
    treeIndex,
    repairPairs,
    drainMod,
    constants,
    store,
    queue,
    sync,
    reconcile,
    reconcileFinish,
    raindropMod,
    backfill,
    matchExisting,
    queueBulkPrompt,
    bulkCandidate,
    wakeBudget,
  };
}

export function patchClient(raindropMod, clientImpl) {
  const Proto = raindropMod.RaindropClient.prototype;
  for (const key of Object.keys(clientImpl)) {
    if (key.startsWith("_")) continue;
    Proto[key] = function (...args) {
      const out = clientImpl[key](...args);
      const finish = (result) => {
        // Simulate Raindrop rate-limit headers so WakeBudget can follow spendable
        // (real request() does this; mocks replace methods and skip fetch).
        // Keep Remaining above RESERVE so normal scenarios are not tripped by
        // proactive pause; tests that need 429 still throw RateLimitError.
        if (typeof this._remaining !== "number") this._remaining = 10_000;
        this._remaining = Math.max(50, this._remaining - 1);
        if (this._resetAt == null || this._resetAt <= Date.now()) {
          this._resetAt = Date.now() + 60_000;
        }
        this._budget?.noteRequest(this);
        return result;
      };
      if (out && typeof out.then === "function") return out.then(finish);
      return finish(out);
    };
  }
}

export async function resetAll(store, { integration = false } = {}) {
  storage.clear();
  // The presence snapshot also lives in worker memory; a reset is a restart.
  const presence = await import(pathToFileURL(path.join(ROOT, "src/lib/presence.js")).href);
  presence.resetPresenceMemory();
  if (integration) seedIntegrationEdge();
  else seedEdge();
  await store.ensurePairsMigrated();
  // Integration scenarios share one Raindrop client; clear engine pause between runs.
  if (integration && typeof store.clearRateLimit === "function") {
    await store.clearRateLimit();
  }
}

export function edgeUrls() {
  return [...bookmarks.values()].filter((n) => n.url).map((n) => n.url);
}

export function findEdgeByUrl(url) {
  return [...bookmarks.values()].find((n) => n.url === url);
}

/** First folder (no url) with this title, anywhere in the mock tree. */
export function findEdgeFolder(title) {
  return [...bookmarks.values()].find((n) => !n.url && n.title === title);
}

/**
 * runPullNow `send` stub that answers the popup/options messages from the
 * engine in this process. `onReconcile` runs before each RECONCILE_NOW pass.
 *
 * @param {Awaited<ReturnType<typeof importEngine>>} eng
 * @param {{ onReconcile?: () => void }} [opts]
 */
export function pullNowSend(eng, { onReconcile } = {}) {
  const { MSG } = eng.constants;
  return async (msg) => {
    if (msg.type === MSG.GET_STATUS) {
      return { ok: true, status: await eng.store.getStatus() };
    }
    if (msg.type === MSG.RECONCILE_NOW) {
      onReconcile?.();
      try {
        const result = await eng.sync.reconcileNow();
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: `unexpected message ${msg.type}` };
  };
}

/** Create a folder inside the integration container (Favorites bar / test-edge-raindrop-sync). */
export async function createIntegrationFolder(title) {
  return chrome.bookmarks.create({
    parentId: TEST_EDGE_CONTAINER_ID,
    title,
  });
}

installChromeMocks();
