// Per-folder policy resolution.
//
// The effective policy for a bookmark is the policy of the NEAREST ancestor
// folder that has an explicit override; if none do, the global default applies.
// `ancestorIds` is nearest-first (the bookmark's parent folder is index 0), so
// the first override we hit walking the list wins.
//
// Prefer `isExcluded` (or bookmarks.isFolderExcluded for folder + parents) over
// comparing resolvePolicy(...) === POLICY.EXCLUDE at call sites.

import { POLICY } from "./constants.js";

export function resolvePolicy(ancestorIds, overrides, defaultPolicy) {
  for (const id of ancestorIds) {
    const override = overrides[id];
    if (override && override.policy) return override.policy;
  }
  return defaultPolicy ?? POLICY.SYNC_DELETE;
}

/** True when effective policy is exclude (upload/ingest/delete blocked both ways). */
export function isExcluded(ancestorIds, overrides, defaultPolicy) {
  return resolvePolicy(ancestorIds, overrides, defaultPolicy) === POLICY.EXCLUDE;
}
