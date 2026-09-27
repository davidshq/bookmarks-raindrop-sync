// Raindrop collection allowlist for selective Raindrop-only sync.
//
// When the allowlist is non-empty, Raindrop-only paths (missing in Edge) sync
// only if the raindrop's collection or an ancestor is listed (under the sync
// root or elsewhere in the account). Edge paths that already exist bypass the
// allowlist. Empty allowlist leaves raindropFolderMode behavior unchanged
// (still scoped to the sync root only).
//
// Membership walks share collections.walkCollectionAncestors with path helpers.
//
// Stale entries (collections deleted from Raindrop) are pruned. Fully mirrored
// subtrees stay on the allowlist until the user clears selection — selective
// mode must not auto-exit and undo a saved opt-in (especially with
// existing-only, where an empty allowlist skips all Raindrop-only creates).

import { getById, walkCollectionAncestors, collectionPathFromRoot } from "./collections.js";
import { RAINDROP_FOLDER_MODE } from "./constants.js";

/**
 * @param {Record<string, { path?: string }>|null|undefined} allowlist
 * @returns {boolean}
 */
export function isAllowlistActive(allowlist) {
  return !!allowlist && Object.keys(allowlist).length > 0;
}

/**
 * True when a raindrop in `collectionId` would appear in scoped reconcile listing
 * (nested under sync root, or under an active outside-root allowlist).
 * @param {string|number|null|undefined} collectionId
 * @param {{ byId?: Map }|null|undefined} index
 * @param {string|number|null|undefined} rootId
 * @param {Record<string, { path?: string }>|null|undefined} allowlist
 */
export function isInScopedListing(collectionId, index, rootId, allowlist) {
  if (collectionId == null || !index?.byId) return false;
  if (collectionPathFromRoot(index, collectionId, rootId).length) return true;
  return isCollectionAllowed(collectionId, index, rootId, allowlist);
}

/**
 * True if `collectionId` or any ancestor is on the allowlist.
 * When walking hits `rootId` without a match, stops (sync root is not an
 * implicit allow). Collections outside the sync root walk to the Raindrop top.
 * @param {string|number|null|undefined} collectionId
 * @param {{ byId: Map }} index
 * @param {string|number|null|undefined} rootId
 * @param {Record<string, { path?: string }>|null|undefined} allowlist
 */
export function isCollectionAllowed(collectionId, index, rootId, allowlist) {
  if (!isAllowlistActive(allowlist) || collectionId == null || !index?.byId) {
    return false;
  }
  let allowed = false;
  const result = walkCollectionAncestors(index, collectionId, (col) => {
    const key = String(col._id);
    if (allowlist[key] || allowlist[col._id]) {
      allowed = true;
      return "stop";
    }
    // Sync root is not an implicit allow — stop without matching.
    if (rootId != null && String(col._id) === String(rootId)) return "abort";
    return "continue";
  });
  return allowed && result.ok;
}

/**
 * Whether a pull that would create Edge folders is permitted.
 * Edge-existing paths always allowed. With active allowlist, need membership.
 * With empty allowlist, `existing-only` blocks missing paths; other modes allow.
 *
 * `existingOnlyValue` defaults to RAINDROP_FOLDER_MODE.EXISTING_ONLY so callers
 * only pass the varying gate fields.
 *
 * @param {{
 *   allowlist: Record<string, { path?: string }>|null|undefined,
 *   collectionId: string|number|null|undefined,
 *   index: { byId: Map }|null|undefined,
 *   rootId: string|number|null|undefined,
 *   edgePathExists: boolean,
 *   folderMode: string,
 *   existingOnlyValue?: string,
 * }} opts
 */
export function canCreateRaindropOnlyPath(opts) {
  const {
    allowlist,
    collectionId,
    index,
    rootId,
    edgePathExists,
    folderMode,
    existingOnlyValue = RAINDROP_FOLDER_MODE.EXISTING_ONLY,
  } = opts;
  if (edgePathExists) return true;
  if (isAllowlistActive(allowlist)) {
    if (!index) return false;
    return isCollectionAllowed(collectionId, index, rootId, allowlist);
  }
  return folderMode !== existingOnlyValue;
}

/**
 * Drop allowlist ids whose Raindrop collection no longer exists.
 * Does not remove fully-mirrored entries — use Clear selection to leave
 * selective mode. Keeping live ids also preserves outside-root pairs (those
 * raindrops are outside the nested root listing; delete detection relies on
 * the allowlist pass).
 *
 * `rootId` / `edgePathExists` are accepted for call-site compatibility but
 * unused: membership is solely "id still in the live index".
 *
 * @param {Record<string, { path?: string }>|null|undefined} allowlist
 * @param {{ byId: Map, byParent?: Map }} index
 * @param {string|number|null|undefined} [_rootId]
 * @param {(relativeSegments: string[]) => boolean|Promise<boolean>} [_edgePathExists]
 * @returns {Promise<{ allowlist: Record<string, { path?: string }>, removed: number }>}
 */
export async function pruneAllowlist(allowlist, index, _rootId, _edgePathExists) {
  const src = allowlist && typeof allowlist === "object" ? allowlist : {};
  const keys = Object.keys(src);
  if (!keys.length) return { allowlist: {}, removed: 0 };

  const next = {};
  let removed = 0;
  for (const id of keys) {
    if (getById(index, id)) next[id] = src[id];
    else removed++;
  }
  return { allowlist: next, removed };
}
