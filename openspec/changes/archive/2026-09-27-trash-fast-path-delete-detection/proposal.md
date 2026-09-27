## Why

Bidirectional delete detection confirms “missing from sync-root listing” with per-id `GET /raindrop/{id}` (capped at 8/tick). Soft-deletes in Raindrop land in Trash (`-99`) first; listing Trash can catch nearly all real remote deletes in a few list pages instead of rotating through a large confirm backlog. Scoped-listing misses that are still alive outside the sync tree keep inflating that backlog and burning rate-limit budget.

## What Changes

- On reconcile finish (after scoped listing), **list Raindrop Trash** (`collectionId=-99`) and enqueue Edge deletes for paired ids found there (and/or confirmed trashed).
- Keep existing confirm-GET path as a fallback for empties/permanent deletes and ambiguous cases; share the same per-tick GET budget where both run.
- Prefer trash listing as the primary soft-delete signal so typical “deleted in Raindrop” cases resolve within one or a few cycles without waiting on the rotating alive-confirm window.
- Broader strategy options live in `docs/raindrop-delete-detection-options.md`; this change implements the trash fast path only.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `bookmark-sync-engine`: Raindrop→Edge delete detection SHALL use Trash listing as a fast path before (or alongside) capped per-id alive confirms.
- `bidirectional-sync`: Clarify that remote soft-delete discoverability is driven primarily by Trash presence under the sync pair map.

## Impact

- `src/lib/reconcile-finish.js` — trash list pass; enqueue `delete-edge` for paired trash ids; adjust candidate / confirm interaction.
- `src/lib/raindrop.js` — list Trash (reuse `listRaindrops(-99)`; optional search/`lastUpdate` later).
- `src/lib/constants.js` — page/budget caps for trash listing if distinct from root listing.
- Verify scripts / activity-log messages for trash-driven deletes vs confirm-GET deletes.
- Rate-limit interaction with existing `MAX_RECONCILE_PAGES_PER_TICK` / `MAX_ALIVE_CHECKS_PER_TICK` and adaptive-reconcile busy/budget skips.
