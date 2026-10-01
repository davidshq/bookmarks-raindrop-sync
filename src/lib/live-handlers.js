// Live Edge bookmark listeners: enqueue durable jobs and signal drain.
// Does not call the Raindrop API directly.

import { JOB, SYNC_MODE, ABSOLUTE_ROOT_ID } from "./constants.js";
import {
  getConfig,
  getOverrides,
  getRaindropId,
  getPairRecord,
  getFolderCollectionId,
  consumeRemoveSuppression,
  consumeCreateSuppression,
  claimExtensionCreate,
  isChangeSuppressed,
  addEdgeRemoved,
  primaryUrlKey,
  appendLog,
} from "./store.js";
import * as queue from "./queue.js";
import {
  getNodeOrNull,
  ancestorIdsFromFolder,
  isFolderExcluded,
  collectUrlDescendants,
} from "./bookmarks.js";
import { isExcluded } from "./policy.js";
import { isDifferentBookmark } from "./pair-rebind.js";
import { drain } from "./drain.js";

/**
 * URL nodes removed by an onRemoved event.
 * Chromium notifies once for a folder delete and embeds the tree in
 * `removeInfo.node` — walk it so nested bookmarks are not orphaned in Raindrop.
 *
 * @param {string} removedId
 * @param {{ parentId?: string, node?: object }} [removeInfo]
 * @returns {{ id: string, title?: string, url?: string, pathFolderIds: string[], liveParentId: string|null }[]}
 *   `pathFolderIds` is nearest-first folders inside the deleted tree;
 *   `liveParentId` is the still-existing parent of the removed root.
 *   `title`/`url` come from Chromium's removed-node payload when present.
 */
export function collectRemovedUrlNodes(removedId, removeInfo) {
  const tree = removeInfo?.node;
  const liveParentId =
    removeInfo?.parentId != null && removeInfo.parentId !== "" ? String(removeInfo.parentId) : null;

  if (!tree) {
    return [{ id: String(removedId), pathFolderIds: [], liveParentId }];
  }

  const out = [];
  const walk = (n, folderAncestorsNearestFirst) => {
    if (n.url) {
      out.push({
        id: String(n.id),
        title: n.title != null ? String(n.title) : undefined,
        url: String(n.url),
        pathFolderIds: folderAncestorsNearestFirst,
        liveParentId,
      });
      return;
    }
    const next = [String(n.id), ...folderAncestorsNearestFirst];
    for (const c of n.children ?? []) walk(c, next);
  };
  walk(tree, []);
  return out;
}

/** Human-readable bookmark label for logs (title → url → id). */
function bookmarkLogLabel(target) {
  return target.title || target.url || target.id;
}

/** One "no payload" log line per worker lifetime (a wake), not per event. */
let loggedMissingPayload = false;

/**
 * Handle a user (or extension) remove of an Edge bookmark or folder.
 * Policy-suppressed removes are ignored. The node payload is the only
 * evidence of intent: each mapped URL in it is written to the durable
 * `edgeRemoved` ledger and enqueues a Raindrop delete (unless under an
 * effective `exclude` policy); drain then runs the survival check. An event
 * with no payload enqueues nothing — the pair stays for the stale-id rebind.
 * Folder deletes walk `removeInfo.node` (Chromium's recursive payload).
 * @param {string} bookmarkId
 * @param {{ parentId?: string, node?: object }} [removeInfo] from chrome.bookmarks.onRemoved
 */
export async function handleBookmarkRemoved(bookmarkId, removeInfo) {
  if (await consumeRemoveSuppression(bookmarkId)) return;

  const config = await getConfig();
  if (config.syncMode !== SYNC_MODE.BIDIRECTIONAL) return;

  if (!removeInfo?.node) {
    if ((await getRaindropId(String(bookmarkId))) && !loggedMissingPayload) {
      loggedMissingPayload = true;
      await appendLog(
        "warn",
        `Bookmark removal without a node payload (id ${bookmarkId}); no Raindrop delete, pair kept.`
      );
    }
    return;
  }

  const targets = collectRemovedUrlNodes(bookmarkId, removeInfo);
  if (!targets.length) return;

  const overrides = await getOverrides();
  let queued = 0;

  for (const target of targets) {
    const raindropId = await getRaindropId(target.id);
    if (!raindropId) continue;

    const liveAncestors = target.liveParentId
      ? await ancestorIdsFromFolder(target.liveParentId)
      : [];
    const ancestorIds = [...target.pathFolderIds, ...liveAncestors];
    if (isExcluded(ancestorIds, overrides, config.defaultPolicy)) {
      await appendLog(
        "info",
        `Skipped Raindrop delete for excluded local bookmark ${bookmarkLogLabel(target)}.`
      );
      continue;
    }

    await addEdgeRemoved([
      {
        urlKey: primaryUrlKey(target.url),
        url: target.url,
        title: target.title,
        at: Date.now(),
        bookmarkId: target.id,
        raindropId: String(raindropId),
      },
    ]);
    const added = await queue.enqueueJob({
      id: `dr-${raindropId}`,
      kind: JOB.DELETE_RAINDROP,
      raindropId,
      bookmarkId: target.id,
      // Edge node is already gone by drain time — keep label for the completion log.
      title: target.title,
      url: target.url,
    });
    if (added) {
      queued++;
      await appendLog(
        "info",
        `Queued Raindrop delete for removed local bookmark ${bookmarkLogLabel(target)}.`
      );
    }
  }

  if (queued > 0) await drain();
}

/**
 * Handle Edge bookmark create — skip enqueue when pull/extension-authored or
 * already paired. A pair bound to this id but recorded from another bookmark
 * (dateAdded differs: the id was reassigned) does not count; the upload then
 * rehomes that pair and syncs this bookmark.
 */
export async function handleBookmarkCreated(id, node) {
  if (!node?.url) return;
  // In-memory claim first (sync). Storage key is the bookmark id, not the URL,
  // so a second copy of the same link is still queued.
  if (claimExtensionCreate(id, node.url)) return;
  if (await consumeCreateSuppression(String(id))) return;
  const rid = await getRaindropId(id);
  if (rid && !isDifferentBookmark(await getPairRecord(rid), node)) return;
  await queue.enqueue(id, { dateAdded: node.dateAdded });
  await drain();
}

/**
 * Handle Edge bookmark or folder move (parent change).
 * Same-parent reorders are ignored. URL nodes enqueue an upload job; folders
 * fan out to live descendant URL bookmarks (Chromium does not fire per child).
 * Drain updates Raindrop collection for pairs or creates when unpaired.
 *
 * @param {string} id
 * @param {{ parentId?: string, oldParentId?: string }} [moveInfo] from chrome.bookmarks.onMoved
 */
export async function handleBookmarkMoved(id, moveInfo) {
  if (await isChangeSuppressed(id)) return;

  const oldParent =
    moveInfo?.oldParentId != null && moveInfo.oldParentId !== ""
      ? String(moveInfo.oldParentId)
      : null;
  const newParent =
    moveInfo?.parentId != null && moveInfo.parentId !== "" ? String(moveInfo.parentId) : null;
  if (oldParent != null && newParent != null && oldParent === newParent) return;

  const node = await getNodeOrNull(id);
  if (!node) return;

  const nodes = node.url ? [node] : await collectUrlDescendants(id);
  const ids = nodes.map((n) => String(n.id));
  if (!ids.length) return;
  const dateAddedById = new Map(nodes.map((n) => [String(n.id), n.dateAdded]));

  // Folder fan-out: skip children that are themselves change-suppressed.
  const toEnqueue = [];
  for (const bid of ids) {
    if (await isChangeSuppressed(bid)) continue;
    toEnqueue.push(bid);
  }
  if (!toEnqueue.length) return;

  await queue.enqueueMany(toEnqueue, { reason: "move", dateAddedById });
  await drain();
}

/**
 * Handle Edge bookmark title/URL edits and folder renames (`onChanged`).
 * URL nodes enqueue an upload with reason `change`. Folders with a persisted
 * folder→collection mapping enqueue `rename-collection` (exclude / unmapped = no-op).
 *
 * @param {string} id
 * @param {{ title?: string, url?: string }} [changeInfo] from chrome.bookmarks.onChanged
 */
export async function handleBookmarkChanged(id, changeInfo) {
  if (!changeInfo || (changeInfo.title === undefined && changeInfo.url === undefined)) {
    return;
  }
  if (await isChangeSuppressed(id)) return;

  const node = await getNodeOrNull(id);
  if (!node) return;

  if (node.url) {
    await queue.enqueue(String(id), { reason: "change", dateAdded: node.dateAdded });
    await drain();
    return;
  }

  // Folder title change → in-place Raindrop collection rename when mapped.
  // Never rename Raindrop from browser top roots (parent "0") — their Raindrop
  // titles stay canonical (Bookmarks bar / Other bookmarks).
  if (node.parentId === ABSOLUTE_ROOT_ID) return;

  // Only when the entry was recorded from this folder (dateAdded): after a
  // renumber the id may belong to a folder mapped to some other collection.
  const collectionId = await getFolderCollectionId(id, node);
  if (collectionId == null) return;

  const config = await getConfig();
  const overrides = await getOverrides();
  if (await isFolderExcluded(id, node.parentId, overrides, config.defaultPolicy)) {
    return;
  }

  await queue.enqueueJob({
    id: `rc-${id}`,
    kind: JOB.RENAME_COLLECTION,
    folderId: String(id),
  });
  await drain();
}
