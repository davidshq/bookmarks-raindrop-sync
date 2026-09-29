## Why

The Sep 25–28 2026 desync forked ~5,500 duplicate raindrops and deleted 890 Edge bookmarks (707 wrongly) because three engine assumptions failed together: Edge bookmark ids are treated as durable identity, a plain create never looks for an existing raindrop, and absence of a paired counterpart is treated as user intent to delete. `docs/sync-engine-rewrite.md` is the decision memo; this change implements its target model so a fork storm or absence-driven delete wave cannot recur, and deletes the confirm-GET presence machinery that the new model makes unnecessary.

The memo's §5 (delete circuit breaker) and the manual Repair pairs dry-run already shipped in commit `03c265e` (see `ops-hardening` spec). This change covers the remaining sections: §1 pair records, §2 unconditional reclaim, §3 evidence-based deletes, §4 export presence snapshot, and the §6 pair-health surface.

## What Changes

- **Pair records replace id pairs.** `PAIRS` becomes a map of records keyed by raindrop id carrying `bookmarkId`, `urlKey`, `url`, `collectionId`, `edgeParentId`, `edgePathAtSync`, `title`, `lastSeenEdgeAt`, `lastSeenRaindropAt`. `byBookmark` / `byRaindrop` become derived in-memory indexes. One-time migration fills `url`/`urlKey` from the live tree and export; unresolvable pairs are dropped, not kept as ghosts.
- **Stale ids rebind by URL, never delete.** A bookmark id missing from the tree rebinds to the same URL under `edgePathAtSync`, then anywhere under the mirror. A raindrop id missing from the presence snapshot rebinds to the oldest surviving raindrop with the same URL.
- **Creates always reclaim.** Before `createRaindrop`, every upload consults presence by URL (snapshot first, `searchRaindrops` if the snapshot is stale) and binds to a claimable existing raindrop instead of creating. The `reason === "move"` / `createAttemptedAt` gate on `shouldReclaim` is removed.
- **Deletes require positive evidence plus a survival check.** Raindrop→Edge runs only when the raindrop id is in Trash or absent from a complete presence snapshot, and no other raindrop carries the URL. Edge→Raindrop runs only from an `onRemoved` event with a node payload, recorded in a durable `edgeRemoved` ledger, and only if the URL is no longer present anywhere under the mirror. A per-id GET that 404s is not evidence on its own.
- **Presence comes from `export.csv`, not per-id GETs.** One export fetch per quiet interval (or on demand when a wake needs it and the snapshot is stale) becomes the presence oracle for delete detection, tombstone prune, rebind, and reclaim. Nested listing stays for placement drift only. Trash listing stays as the fast soft-delete signal.
- **BREAKING (internal):** removes `seenAcc`, `unsettledConfirmCatchUp`, `runConfirmCatchUp`, `rotateConfirmWindow`, `aliveConfirmOffset`, `parkedAliveIds` and park/unpark, "postponed N missing-raindrop check(s)", and most of `finishDeleteDetection`. Reconcile state and Status copy that referenced them go away. The two known issues in that code (catch-up stall, early "safe to empty") are resolved by deletion.
- **Pair health in Status.** Options → Status shows live↔live pairs, stale-Edge-id pairs, stale-Raindrop-id pairs, Edge-only and Raindrop-only URLs, and duplicate-URL groups per side, computed from the snapshot and tree. **Repair pairs** runs the rebind pass on demand and no longer needs to reset confirm-GET state.
- **Tests move to a real runner** with the six invariants from the memo as the priority list.

## Capabilities

### New Capabilities
- `pair-records`: pair record schema, derived indexes, migration, and URL-based rebind rules for stale Edge and Raindrop ids.
- `presence-snapshot`: Raindrop export as the presence oracle: refresh cadence, in-memory and durable forms, and which consumers must use it instead of per-id GETs.
- `delete-evidence`: positive-signal plus survival-check rules for deletes in both directions, including the `edgeRemoved` ledger and duplicate-copy handling.

### Modified Capabilities
- `bookmark-sync-engine`: reclaim-by-URL becomes unconditional on every create (replaces the move/crash-only gate); "Park out-of-scope alive confirm candidates" requirement is removed; tombstone prune becomes a set difference against the snapshot; per-tick confirm-GET cap scenarios are removed.
- `bidirectional-sync`: "User delete propagates Raindrop to Edge" and "Edge to Raindrop" now require evidence and a survival check; unsettled confirm catch-up scenarios and the "Confirm GETs follow spendable" scenario are removed; "Empty Trash only after discovery debt is clear" is restated against the snapshot.
- `export-bulk-sync`: "Heartbeat unchanged" scenario is replaced: heartbeat may refresh the presence snapshot at most once per quiet interval.
- `ops-hardening`: Repair pairs gains pair-health counts in Status, runs the rebind pass, and drops the confirm-GET state reset.

## Impact

- `src/lib/store.js`: pair store shape, migration, indexes, reconcile-state fields removed, `edgeRemoved` ledger and snapshot persistence added.
- `src/lib/job-processors.js`: `processUpload` reclaim path, `processDeleteEdge` / `processDeleteRaindrop` survival checks.
- `src/lib/live-handlers.js`: `handleBookmarkRemoved` writes the ledger and defers the delete decision to the survival check.
- `src/lib/reconcile.js`, `src/lib/reconcile-finish.js`, `src/lib/wake-budget.js`, `src/lib/trash-hygiene.js`: confirm-GET, catch-up, parking and rotating-window code removed (~1,200–1,500 lines); trash and tombstone paths rewired to the snapshot.
- `src/lib/repair-pairs.js`, `src/lib/match-existing.js`, `src/lib/move-rebind.js`: share one rebind/claim implementation with the pair store.
- `src/lib/export-csv.js`, `src/lib/raindrop.js`: snapshot builder on top of the existing export fetch.
- `src/options/options.js`: Status pair-health block; catch-up and postponed copy removed.
- `scripts/verify-*.mjs`: replaced by a test runner (Node `node:test`) covering the six invariants.
- Storage: one-time `PAIRS` migration; reconcile-state keys dropped. No manifest or permission changes. Raindrop API load shifts from many per-id GETs to one export per interval.
