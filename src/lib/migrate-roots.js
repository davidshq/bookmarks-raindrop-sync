// One-shot migration: legacy Edge/Favorites Raindrop tree → Bookmarks/Bookmarks bar.
//
// Renames collections in place (same ids) so pairs and folderCollections stay valid.
// Safe to call repeatedly; a completion flag on config prevents re-entry.
// Conflicts (both old and new titles present) do NOT set the flag — next drain retries.

import {
  CANONICAL_OTHER,
  CANONICAL_TOOLBAR,
  DEFAULT_ROOT_NAME,
  LEGACY_ROOT_NAME,
} from "./bookmark-roots.js";
import {
  applyCollectionTitleInIndex,
  buildCollectionIndex,
  findRootCollection,
  getByParent,
} from "./collections.js";
import {
  appendLog,
  getCollectionCache,
  getConfig,
  setCollectionCache,
  setConfig,
} from "./store.js";

/** Legacy → canonical child titles under the sync root. */
const CHILD_RENAMES = [
  { from: "Favorites bar", to: CANONICAL_TOOLBAR },
  { from: "Other favorites", to: CANONICAL_OTHER },
];

/**
 * Run legacy Raindrop root/segment renames once when a token is configured.
 * @param {import("./raindrop.js").RaindropClient} client
 * @returns {Promise<{ ran: boolean, renamed: string[], blocked?: boolean }>}
 */
export async function migrateLegacyRaindropRoots(client) {
  const config = await getConfig();
  if (config.rootsMigratedAt) {
    return { ran: false, renamed: [] };
  }
  if (!config.token) {
    return { ran: false, renamed: [] };
  }

  const index = await buildCollectionIndex(client);
  const renamed = [];
  let blocked = false;

  // Prefer renaming the collection that matches current/legacy rootName.
  const legacyTitle =
    config.rootName === LEGACY_ROOT_NAME || !config.rootName
      ? LEGACY_ROOT_NAME
      : config.rootName === DEFAULT_ROOT_NAME
        ? LEGACY_ROOT_NAME
        : null;

  let rootCol = null;
  if (legacyTitle) {
    rootCol = findRootCollection(index, legacyTitle);
  }
  // Also try explicit Edge even when rootName was already changed manually.
  if (!rootCol) {
    rootCol = findRootCollection(index, LEGACY_ROOT_NAME);
  }

  let syncRootId = rootCol?._id ?? null;
  let rootRenamed = false;

  if (rootCol && (rootCol.title || "") === LEGACY_ROOT_NAME) {
    const conflict = findRootCollection(index, DEFAULT_ROOT_NAME);
    if (conflict && String(conflict._id) !== String(rootCol._id)) {
      blocked = true;
      await appendLog(
        "warn",
        `Roots migration: both "${LEGACY_ROOT_NAME}" and "${DEFAULT_ROOT_NAME}" exist — skipped root rename.`
      );
    } else {
      await client.updateCollection(rootCol._id, { title: DEFAULT_ROOT_NAME });
      applyCollectionTitleInIndex(index, rootCol._id, DEFAULT_ROOT_NAME);
      rootRenamed = true;
      renamed.push(`${LEGACY_ROOT_NAME}→${DEFAULT_ROOT_NAME}`);
    }
  }

  if (syncRootId == null) {
    const current = findRootCollection(index, config.rootName || DEFAULT_ROOT_NAME);
    syncRootId = current?._id ?? null;
  }

  if (syncRootId != null) {
    for (const { from, to } of CHILD_RENAMES) {
      const children = getByParent(index, syncRootId);
      const oldCol = children?.get(from.toLowerCase()) ?? null;
      if (!oldCol) continue;
      const existing = children?.get(to.toLowerCase()) ?? null;
      if (existing && String(existing._id) !== String(oldCol._id)) {
        blocked = true;
        await appendLog(
          "warn",
          `Roots migration: both "${from}" and "${to}" under sync root — skipped.`
        );
        continue;
      }
      if ((oldCol.title || "") === to) continue;
      await client.updateCollection(oldCol._id, { title: to });
      applyCollectionTitleInIndex(index, oldCol._id, to);
      renamed.push(`${from}→${to}`);
    }
  }

  if (blocked) {
    // Root may already be Bookmarks while a child rename conflicted — persist
    // rootName so the next drain can find the tree. Do not set rootsMigratedAt.
    if (rootRenamed && (config.rootName === LEGACY_ROOT_NAME || !config.rootName)) {
      await setConfig({ rootName: DEFAULT_ROOT_NAME });
    }
    await appendLog(
      "warn",
      "Roots migration incomplete (name conflict) — will retry on next drain. Resolve duplicate collections in Raindrop if this persists."
    );
    return { ran: true, renamed, blocked: true };
  }

  // Rewrite path cache prefixes for legacy names only after a clean pass.
  const cache = await getCollectionCache();
  const next = {};
  let cacheChanged = false;
  for (const [pathKey, id] of Object.entries(cache || {})) {
    let newKey = pathKey;
    if (newKey === LEGACY_ROOT_NAME || newKey.startsWith(`${LEGACY_ROOT_NAME}/`)) {
      newKey = DEFAULT_ROOT_NAME + newKey.slice(LEGACY_ROOT_NAME.length);
      cacheChanged = true;
    }
    newKey = newKey
      .replace(/\/Favorites bar(\/|$)/g, `/${CANONICAL_TOOLBAR}$1`)
      .replace(/^Favorites bar(\/|$)/, `${CANONICAL_TOOLBAR}$1`)
      .replace(/\/Other favorites(\/|$)/g, `/${CANONICAL_OTHER}$1`)
      .replace(/^Other favorites(\/|$)/, `${CANONICAL_OTHER}$1`);
    if (newKey !== pathKey) cacheChanged = true;
    // Prefer canonical key if both old and new somehow appear.
    if (next[newKey] == null) next[newKey] = id;
  }
  if (cacheChanged) {
    await setCollectionCache(next);
  }

  const patch = { rootsMigratedAt: Date.now() };
  // Bump stored root name only when we renamed Edge→Bookmarks, or config still
  // says Edge and there is no leftover Edge collection to rename.
  if (rootRenamed || config.rootName === LEGACY_ROOT_NAME || !config.rootName) {
    if (rootRenamed || !findRootCollection(index, LEGACY_ROOT_NAME)) {
      patch.rootName = DEFAULT_ROOT_NAME;
    }
  }
  await setConfig(patch);

  if (renamed.length) {
    await appendLog("info", `Roots migration: renamed ${renamed.join(", ")}.`);
  } else {
    await appendLog("info", "Roots migration: nothing to rename (already canonical or absent).");
  }

  return { ran: true, renamed };
}
