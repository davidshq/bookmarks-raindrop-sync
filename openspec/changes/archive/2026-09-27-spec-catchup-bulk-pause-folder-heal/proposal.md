## Why

After archiving the bulk-lane and move-rebind OpenSpec changes, several hardening commits shipped without a follow-up delta: Status can look “dead” during a bulk-queue pause, reconcile keeps listing while drain is paused, and folder→collection maps needed for Raindrop→browser folder renames stay missing on older installs. Specs should catch up to the behavior already in code so archive/main stay honest.

## What Changes

- Document heartbeat reconcile skip reason `bulk_pause` (alongside `busy` / `cooldown` / `rate_limited`) and that bulk-prompt `needs_choice` pauses Raindrop-bound **reconcile** as well as drain.
- Document Status honesty after Match / Continue drip: refresh stale `bulk_pause` to `busy` (or clear) so Options does not keep showing a resolved pause.
- Document reconcile-finish healing of missing `edgeFolderId → raindropCollectionId` maps (path / title / single-sibling match) so pull-rename can run on libraries that pulled before maps were recorded; pull-create/pull-update continue to learn maps.
- Document drain ordering: `rename-collection` and `pull-rename-folder` before uploads / pull-updates so path-ensure cannot orphan a mapped collection.
- Fill `canonical-bookmark-roots` Purpose (currently TBD) when syncing to main; no new root-alias requirements.
- Pin documented bulk thresholds (200 / 100 / 30% / 150 / half watermark) and the pair-coverage formula used in code (size gate on all scanned Edge URLs; coverage = paired / in-scope non-excluded).
- Clarify that the guided Match gate applies to Options Manual Sync (and Status queue remediation), not the compact popup Import/Pull controls.

No **BREAKING** product changes — this is a spec catch-up for shipped behavior.

## Capabilities

### New Capabilities

<!-- none — catch-up only -->

### Modified Capabilities

- `bookmark-sync-engine`: Expand skip reasons with `bulk_pause`; rename-before-update drain priority; folder-map learn/heal for pull-rename.
- `queue-bulk-prompt`: Pause heartbeat reconcile while `needs_choice`; clear/refresh reconcile-skip after Match or Continue.
- `extension-config`: Status surfaces `bulk_pause` / busy / cooldown deferral copy (not only “already running”).
- `bidirectional-sync`: Pull path learns and heals folder→collection maps so Raindrop collection title drift can rename Edge folders in place.
- `export-bulk-sync`: Pin Import/Pull bulk-candidate numeric thresholds and in-scope coverage formula; scope guided Match to Options (+ Status), not popup.

Hygiene (no delta requirement): fill `canonical-bookmark-roots` Purpose (currently TBD) when syncing to main.

## Impact

- Primarily OpenSpec artifacts and main-spec sync/archive; verify scripts already cover most of this (`verify-checklist` 7.5–7.7, rename priority, skip notices).
- Touched implementation (already shipped): `src/lib/sync.js`, `src/lib/store.js`, `src/lib/reconcile-finish.js`, `src/lib/queue.js`, `src/lib/job-processors.js`, `src/options/options.js`.
- Untracked `docs/export-bulk-sync.md` should be kept in sync with the pinned thresholds when this change archives.
