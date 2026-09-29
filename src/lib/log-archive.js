// Opt-in long-term activity archive in IndexedDB.
//
// Recent activity stays in chrome.storage.local (LOG_LIMIT). When the user
// enables keepLongTermLog, appendLog also writes here so history survives
// past the recent ring buffer. Consecutive identical lines update the newest
// row in place (same shape as the recent log, including ats). Export/clear
// run from the options page.
// Failures must not break sync — callers catch and continue.

import { LOG_ARCHIVE_LIMIT } from "./constants.js";

const DB_NAME = "ers-activity-log";
const DB_VERSION = 1;
const STORE = "entries";

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("at", "at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

/**
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function waitTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Fields stored for one archive row. `id` is set only when updating in place.
 * @param {{ at: number, level: string, message: string, ats?: number[] }} entry
 * @param {number} [id]
 */
function toArchiveRecord(entry, id) {
  const record = {
    at: entry.at,
    level: entry.level,
    message: entry.message,
  };
  if (Array.isArray(entry.ats) && entry.ats.length > 0) record.ats = entry.ats.slice();
  if (id != null) record.id = id;
  return record;
}

/**
 * Open the archive, run `fn` against the object store in one transaction, and
 * resolve with its result once the transaction completes. Requests issued in
 * `fn` must be chained from their callbacks so the transaction does not
 * auto-commit across an await.
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const result = await fn(tx.objectStore(STORE));
    await waitTx(tx);
    return result;
  } finally {
    db.close();
  }
}

/**
 * Store one activity line. If the newest row matches level and message, update
 * it (consecutive coalesce). Otherwise append, then prune oldest entries over
 * LOG_ARCHIVE_LIMIT.
 * @param {{ at: number, level: string, message: string, ats?: number[] }} entry
 */
export async function appendArchiveEntry(entry) {
  await withStore("readwrite", (store) => {
    const cursorReq = store.openCursor(null, "prev");
    cursorReq.onsuccess = () => {
      const newest = cursorReq.result?.value;
      const same = newest && newest.level === entry.level && newest.message === entry.message;
      if (same) {
        store.put(toArchiveRecord(entry, newest.id));
        return;
      }
      store.add(toArchiveRecord(entry));
      const countReq = store.count();
      countReq.onsuccess = () => {
        const excess = countReq.result - LOG_ARCHIVE_LIMIT;
        if (excess <= 0) return;
        let deleted = 0;
        const pruneReq = store.openCursor();
        pruneReq.onsuccess = () => {
          const cursor = pruneReq.result;
          if (!cursor || deleted >= excess) return;
          cursor.delete();
          deleted += 1;
          cursor.continue();
        };
      };
    };
  });
}

/** @returns {Promise<number>} */
export async function countArchiveEntries() {
  return withStore("readonly", (store) => reqToPromise(store.count()));
}

/**
 * All archive rows for JSON export (id omitted).
 * @returns {Promise<Array<{ at: number, level: string, message: string, ats?: number[] }>>}
 */
export async function exportArchiveEntries() {
  const all = await withStore("readonly", (store) => reqToPromise(store.getAll()));
  return all.map((row) => toArchiveRecord(row));
}

/** Remove every archived entry. Recent storage.local log is untouched. */
export async function clearArchive() {
  await withStore("readwrite", (store) => {
    store.clear();
  });
}
