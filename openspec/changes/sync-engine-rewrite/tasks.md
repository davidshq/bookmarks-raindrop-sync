## 1. Test runner and fixtures

- [x] 1.1 Add `test/` with `node --test` wiring in `package.json` (`test` runs `node --test test/`, keep `test:live` pointing at the checklist `--live` entry)
- [x] 1.2 Add fixture helpers: in-memory `chrome.storage.local`, a fake Edge tree with `getTree`/`getSubTree`/`create`/`remove`, a fake Raindrop client with export CSV, Trash listing, search, create/update/delete stubs, and a request counter
- [x] 1.3 Port `verify-bidirectional-logic.mjs` and `verify-checklist.mjs` offline cases to `test/*.test.mjs` and delete the old scripts once green

## 2. Presence snapshot (design D4)

- [x] 2.1 Add `src/lib/presence.js`: build `{ at, ids, byUrlKey, complete }` from export CSV via `export-csv.js` and `urlMatchKeys`; `complete` false on parse error or row count under half of the previous complete snapshot
- [x] 2.2 Persist `{ at, ids }` under a new storage key; restore on worker start; add `PRESENCE_STALE_MS` (10 min, fixed) and `PRESENCE_MAX_AGE_MS` (24 h) to `constants.js`
- [x] 2.3 Add `ensurePresence({ client, budget, reason })` implementing the refresh cadence (heartbeat by interval, on-demand by staleness, Pull now always) and charging the wake budget
- [x] 2.4 Tests: snapshot build, incomplete on malformed CSV, restore on restart, refresh policy for each reason

## 3. Pair records (design D1, D2)

- [x] 3.1 Define the v2 `PAIRS` shape in `store.js` with records keyed by raindrop id and derived `byBookmark` / `byUrlKey` indexes rebuilt on load and after mutation
- [x] 3.2 Keep `getRaindropId`, `getBookmarkIdForRaindrop`, `hasSynced`, `getPairs`, `forgetSynced`, `forgetPairByRaindrop`, `rewritePairs` working on the indexes; extend `recordSynced(bookmarkId, raindropId, meta)` and pass node/collection meta from every caller
- [x] 3.3 Implement one-shot v1→v2 migration under the pair lock: build records from the tree and snapshot, apply rebind rules, drop unresolved, log one summary line, keep `PAIRS_V1_BACKUP` until the next completed finish, set `migrationPartial` when the export fails
- [x] 3.4 Tests: record write, index rebuild, migration keep/rebind/drop, partial migration flag

## 4. Rebind rules (design D3)

- [x] 4.1 Add `src/lib/pair-rebind.js` with pure `rebindStaleEdgeId(record, treeIndex, pairs)` (prefer `edgePathAtSync`, then mirror, skip bound-elsewhere) and `rebindStaleRaindropId(record, snapshot, pairs)` (oldest unbound id wins)
- [x] 4.2 Add a `rebindPass({ tree, snapshot, pairs })` that walks all records, applies both rules, logs `Rebound: <title> (Edge id changed)` / Raindrop equivalent, and returns candidates for delete-evidence
- [x] 4.3 Route `match-existing.js` and `repair-pairs.js` through the same functions; treat forward links to ids absent from the snapshot as stale, not conflict
- [x] 4.4 Tests: memo invariants 3 and 4 (stale Edge id rebinds under same path; stale Raindrop id rebinds to survivor), bound-elsewhere not claimed

## 5. Reclaim on every create (design D6)

- [x] 5.1 In `processUpload`, remove the `shouldReclaim` gate; before create, look up urlKey in the snapshot (via `ensurePresence`) and bind via `pickMoveRebindCandidate` semantics; fall back to one `searchRaindrops` when the snapshot is stale and cannot be refreshed
- [x] 5.2 Keep move-conflict drop for `reason === "move"`; plain create in conflict creates
- [x] 5.3 Backfill refreshes the snapshot once before enqueuing
- [x] 5.4 Tests: memo invariant 2 (create with existing URL binds instead of forking), crash retry still reclaims, stale snapshot falls back to a single search, conflict behavior per reason

## 6. Delete evidence (design D5)

- [x] 6.1 Add the durable `edgeRemoved` ledger to `store.js` with 7-day prune; `handleBookmarkRemoved` writes entries only when a node payload exists and logs once per wake when it does not
- [x] 6.2 `processDeleteRaindrop`: survival check by urlKey over the synced scope (mirror root plus outside-root landing when an allowlist is active, reuse `isOutsideRootLandingSegments`); surviving copy rebinds the record and drops the job; otherwise delete, tombstone, remove record and ledger entry
- [x] 6.3 Add `presenceDeletesEnabled` to config (default true) with a Status toggle
- [x] 6.4 Reconcile finish: Trash-listed pairs and pairs absent from a complete snapshot become candidates; run the survival check against `byUrlKey`; rebind survivors; enqueue `delete-edge` only for the rest; skip absence candidates when `migrationPartial`, snapshot incomplete, aged out, or flag off
- [x] 6.5 `processDeleteEdge`: repeat the survival check against the current snapshot at execution; rebind and drop when the URL reappears
- [x] 6.6 Tests: memo invariant 1 (no delete without signal plus failed survival), 404-only is not evidence, duplicate copy removal rebinds, unsynced-folder copy is not a survivor, landing-zone copy is a survivor, no-payload remove does nothing, execution-time survival check

## 7. Delete the confirm-GET machinery (design D7, D8)

- [x] 7.1 Remove from `reconcile-finish.js`: `runConfirmCatchUp`, `finishConfirmGets`, `rotateConfirmWindow`, `seenAccWithLive`, `finishDeleteDetection`, `probeLivingRaindrop`, `raindropStillAlive`; replace `finishTombstonePrune` with a set difference against a complete snapshot
- [x] 7.2 Remove from `reconcile.js` the confirm-only wake branch and `seenAcc` union; "complete" finish means listing done plus due snapshot refresh; cooldown always arms after completion
- [x] 7.3 Remove from `store.js` reconcile state: `seenAcc`, `unsettledConfirmCatchUp`, `aliveConfirmOffset`, `tombstoneConfirmOffset`, `parkedAliveIds`, `trashHygieneNextPage`, park/unpark helpers; drop the keys on first load
- [x] 7.4 `trash-hygiene.js`: Check Trash restarts at page 0 each click and keeps `pairedPending` across partial scans
- [x] 7.5 Remove confirm-specific caps from `wake-budget.js`; keep `SOFT_MAX_REQS_PER_WAKE` for drain
- [x] 7.6 Remove catch-up, postponed and parked copy from `options.js` Status; update `repair-pairs.js` apply to stop resetting confirm state
- [x] 7.7 Run lint and the full test suite; grep the tree for the removed symbol names to confirm nothing references them

## 8. Pair health and Repair (design D9)

- [x] 8.1 Add `src/lib/pair-health.js` computing live↔live, stale Edge id, stale Raindrop id, Edge-only URLs, Raindrop-only URLs, duplicate-URL groups per side, snapshot age and completeness
- [x] 8.2 Compute and store pair health after each completed reconcile finish and after Repair apply; expose through the status message
- [x] 8.3 Options → Status renders the counts and shows a Repair pairs shortcut when any stale-id count is non-zero
- [x] 8.4 Repair plan uses the §4 rebind pass for both sides and reports Edge-side rebinds separately from prunes
- [x] 8.5 Tests: health counts on a fixture with each category populated; Repair plan rebinds a ghost forward link and a stale Edge id

## 9. Rollout

- [x] 9.1 Take a Raindrop export and a copy of the Bookmarks file per `AGENTS.md` before loading the build on the primary profile
- [x] 9.2 Load the build, confirm the migration summary log line, and confirm Status shows zero stale-id pairs and an unchanged breaker count after the first reconcile finish
- [x] 9.3 Confirm `PAIRS_V1_BACKUP` is dropped after the next completed finish
- [x] 9.4 Update `docs/sync-engine-rewrite.md` "Known issues" and "Sequencing" to reflect what shipped, and update `AGENTS.md` if any rule wording changed
