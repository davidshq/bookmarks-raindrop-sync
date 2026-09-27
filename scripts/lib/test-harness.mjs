/**
 * Shared in-memory Edge / chrome.storage mocks for verify scripts.
 * Used by verify-checklist.mjs and verify-integration.mjs — keep mocks here, not duplicated.
 * Never touches the real Edge bookmark tree.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @deprecated use scriptsRoot — kept for importers that expect repoRoot */
export const ROOT = path.resolve(__dirname, "../..");
export const scriptsRoot = ROOT;

/** In-memory extension storage and bookmark tree (disposable). */
export const storage = new Map();
export const bookmarks = new Map();

/** Edge folder id for the isolated integration container (under Favorites bar). */
export const TEST_EDGE_CONTAINER_ID = "10";

let bmSeq = 100;

export function bmNode(partial) {
  const id = String(partial.id ?? ++bmSeq);
  const node = {
    id,
    title: partial.title ?? "",
    url: partial.url,
    parentId: partial.parentId,
    children: partial.children,
  };
  bookmarks.set(id, node);
  return node;
}

/** Seed Favorites bar + Other favorites only (Edge-shaped titles). */
export function seedEdge() {
  bookmarks.clear();
  bmSeq = 100;
  bmNode({ id: "0", title: "", parentId: undefined, children: undefined });
  bmNode({ id: "1", title: "Favorites bar", parentId: "0" });
  bmNode({ id: "2", title: "Other favorites", parentId: "0" });
}

/** Seed Bookmarks bar + Other bookmarks (Chrome-shaped titles). */
export function seedChrome() {
  bookmarks.clear();
  bmSeq = 100;
  bmNode({ id: "0", title: "", parentId: undefined, children: undefined });
  bmNode({ id: "1", title: "Bookmarks bar", parentId: "0" });
  bmNode({ id: "2", title: "Other bookmarks", parentId: "0" });
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
      },
    },
    bookmarks: {
      async get(id) {
        const n = bookmarks.get(String(id));
        if (!n) throw new Error("Bookmark not found");
        return [{ ...n }];
      },
      async getChildren(id) {
        return [...bookmarks.values()]
          .filter((n) => n.parentId === String(id))
          .map((n) => ({ ...n }));
      },
      async getTree() {
        const root = { ...bookmarks.get("0"), children: [] };
        const attach = (parent) => {
          parent.children = [...bookmarks.values()]
            .filter((n) => n.parentId === parent.id)
            .map((n) => {
              const copy = { ...n };
              if (!copy.url) attach(copy);
              return copy;
            });
        };
        attach(root);
        return [root];
      },
      async create({ parentId, title, url }) {
        return bmNode({ parentId: String(parentId), title, url });
      },
      async remove(id) {
        const n = bookmarks.get(String(id));
        if (!n) throw new Error("Bookmark not found");
        if (!n.url) {
          const kids = [...bookmarks.values()].filter((c) => c.parentId === String(id));
          if (kids.length) throw new Error("Folder not empty");
        }
        bookmarks.delete(String(id));
      },
      async update(id, patch) {
        const n = bookmarks.get(String(id));
        if (!n) throw new Error("Bookmark not found");
        if (patch.title !== undefined) n.title = patch.title;
        if (patch.url !== undefined) n.url = patch.url;
        return { ...n };
      },
      async move(id, destination) {
        const n = bookmarks.get(String(id));
        if (!n) throw new Error("Bookmark not found");
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

export function loadToken() {
  if (process.env.RAINDROP_TOKEN) return process.env.RAINDROP_TOKEN.trim();
  const p = path.join(ROOT, ".tmp", "raindrop_token");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return "";
}

export async function importEngine() {
  const base = pathToFileURL(path.join(ROOT, "src/lib")).href;
  const constants = await import(`${base}/constants.js`);
  const store = await import(`${base}/store.js`);
  const queue = await import(`${base}/queue.js`);
  const sync = await import(`${base}/sync.js`);
  const reconcile = await import(`${base}/reconcile.js`);
  const raindropMod = await import(`${base}/raindrop.js`);
  return { constants, store, queue, sync, reconcile, raindropMod };
}

export function patchClient(raindropMod, clientImpl) {
  const Proto = raindropMod.RaindropClient.prototype;
  for (const key of Object.keys(clientImpl)) {
    if (key.startsWith("_")) continue;
    Proto[key] = function (...args) {
      return clientImpl[key](...args);
    };
  }
}

export async function resetAll(store, { integration = false } = {}) {
  storage.clear();
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

/** Create a folder inside the integration container (Favorites bar / test-edge-raindrop-sync). */
export async function createIntegrationFolder(title) {
  return chrome.bookmarks.create({
    parentId: TEST_EDGE_CONTAINER_ID,
    title,
  });
}

installChromeMocks();
