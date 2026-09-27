## Why

Edge folder/bookmark moves sync via upload jobs that **create** a new raindrop when the Edge bookmark is unpaired, leaving the existing Raindrop copy in the old collection. Users who reorganize Favorites then see the same URLs in two Raindrop locations. Relocating an existing raindrop by URL on move (instead of creating) stops that fork without requiring Raindrop collection reparenting.

## What Changes

- On upload drain with `reason: "move"`, before `createRaindrop`, resolve an existing raindrop by URL (stable match keys).
- Unique match (or reclaimable stale reverse pair): record the pair and `updateRaindrop` into the destination collection (relocate).
- Multiple matches: relocate one (prefer oldest), do **not** create another copy; log that extras remain.
- No URL match: create as today (genuinely new to Raindrop).
- Conflict (URL's raindrop already paired to a different **live** Edge bookmark): do not steal the pair; do not create; log and drop the job.
- Docs/tests cover the unpaired-move path that previously forked libraries.

## Capabilities

### New Capabilities

<!-- none — behavior is a delta on the existing upload/move engine -->

### Modified Capabilities

- `bookmark-sync-engine`: Unpaired move drain must rebind-by-URL and relocate instead of blindly creating a second raindrop.

## Impact

- `src/lib/job-processors.js` (processUpload move path)
- `src/lib/raindrop.js` (search helper)
- Possibly small helper module for URL→raindrop resolve (reuse `urlMatchKeys` / Match claim rules)
- `scripts/verify-checklist.mjs` / logic tests
- README or sync docs note on move behavior
