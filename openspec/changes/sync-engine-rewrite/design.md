## Context

The engine today stores pairs as two id maps (`byBookmark`, `byRaindrop`) in `store.js`. Upload creates a raindrop unless the job is a move or a crash retry (`shouldReclaim` in `job-processors.js`). Remote-delete detection works by listing the sync root, unioning the seen ids into a durable `seenAcc`, then walking every paired raindrop not in that set through a rotating window of per-id `GET /raindrop/{id}` confirms, parking ids that are alive but out of scope, and enqueuing `delete-edge` when the GET says gone (`reconcile-finish.js`). Local deletes enqueue `delete-raindrop` directly from `onRemoved` (`live-handlers.js`).

The Sep 2026 incident showed that each of these fails under id churn. `docs/sync-engine-rewrite.md` is the memo; `AGENTS.md` carries the hard rules (never edit the Bookmarks file, never treat an Edge id as durable identity, a missing counterpart is not intent to delete).

Already in place and reused by this design: the export fetch and CSV parser (`raindrop.js`, `export-csv.js`), the Match existing claim rules (`match-existing.js`, `classifyPairClaim`), move rebind candidate selection (`move-rebind.js`, `pickMoveRebindCandidate`), the delete circuit breaker (`drain.js`, `store.js`, constants `DELETE_BREAKER_*`), and the Repair pairs dry-run/apply (`repair-pairs.js`).

Constraints: MV3 service worker (state must survive restarts; memory is a cache), Raindrop rate budget (per-wake spendable, reserve threshold), ~6k raindrops today, `chrome.storage.local` write soft-fail behavior.

## Goals / Non-Goals

**Goals:**
- No delete on either side without a positive signal and a failed survival check by URL.
- No create when a claimable raindrop with the same URL already exists.
- Stale ids on either side rebind by URL instead of triggering deletes or forks.
- Presence for delete detection, tombstone prune, rebind and reclaim comes from one export per interval, not per-id GETs.
- Remove the confirm-GET / catch-up / parking machinery and its Status copy.
- Pair health visible in Status; Repair pairs runs the same rebind logic the engine uses.
- Tests run under a real runner covering the six memo invariants.

**Non-Goals:**
- Changing the circuit breaker thresholds or UI (shipped).
- Changing collections mirroring, folder policies, allowlist, queue/backoff/dead-letter, canonical roots, or the Options UI structure.
- Using the export CSV for placement. Nested listing remains the placement source.
- Multi-profile or cross-browser pair sharing.
- Fixing the two known issues in the confirm-GET code in place. They disappear with it.

## Decisions

### D1. Pair store: records keyed by raindrop id, indexes derived in memory

`PAIRS` becomes `{ v: 2, byRaindrop: { [raindropId]: PairRecord } }`. `byBookmark` and `byUrlKey` are rebuilt on load and after each mutation, never persisted. Raindrop id is the key because it is stable while the raindrop lives and is what Trash, export and listings report. Bookmark id is a cached field.

Alternatives: keep two id maps and add a side table of URLs (rejected: two sources of truth, the same drift problem); key by urlKey (rejected: duplicates on either side make the key non-unique, and URL edits would re-key the record).

Existing read APIs (`getRaindropId`, `getBookmarkIdForRaindrop`, `hasSynced`, `getPairs`) keep their signatures and read the indexes, so call sites outside the store need no change in step one. `recordSynced(bookmarkId, raindropId, meta)` gains an optional third argument with url/title/placement; callers that already have the node pass it. `rewritePairs` continues to exist for Repair.

### D2. Migration is one-shot, runs under the pair lock, and drops ghosts

On first load of a v1 map: read the Edge tree once, take a presence snapshot (D4), and for each `(bookmarkId, raindropId)` build a record from the live node (url, title, parent, path). If the node is missing but the raindrop's URL is in the snapshot, look for that URL under the mirror and rebind; if the raindrop is missing but the node exists, look for the URL in the snapshot and rebind. Anything still unresolved is dropped and counted in one log line. The v1 map is kept under a `PAIRS_V1_BACKUP` key until the next successful reconcile finish, then deleted.

If the export cannot be fetched (offline, no token), migration builds records from the tree only, marks the store `migrationPartial: true`, and the next wake retries the Raindrop side before any delete runs. Deletes are blocked while `migrationPartial` is set.

### D3. Rebind rules live in one module and are used by upload, reconcile, and Repair

New `pair-rebind.js` exposes `rebindStaleEdgeId(record, tree)` and `rebindStaleRaindropId(record, snapshot, pairs)`. Both are pure over their inputs so they are testable without the extension runtime. Edge rebind prefers a URL match under `edgePathAtSync`, then anywhere under the mirror, and never claims a bookmark already bound to a live pair. Raindrop rebind uses `pickMoveRebindCandidate` semantics (oldest id wins, skip ids bound to other live bookmarks). `match-existing.js` and `repair-pairs.js` call the same functions so Match, Repair and the engine cannot disagree.

### D4. Presence snapshot: export CSV, refreshed by staleness, durable ids only

`presence.js` holds `{ at, ids: Set<string>, byUrlKey: Map<string, string[]>, complete: boolean }` in worker memory and persists `{ at, ids: string[] }` to storage (about 6k short strings, well under the quota). `complete` is true only when the export parsed without error. Refresh policy:

- Heartbeat: refresh when `now - at >= reconcileIntervalMinutes` and the wake has spendable for one request.
- On-demand (upload reclaim, delete survival check, Repair, migration): refresh if `now - at >= PRESENCE_STALE_MS` (10 minutes), else use as is.
- Pull now: always refresh.

A snapshot older than `PRESENCE_MAX_AGE_MS` (24 hours) is never treated as complete for delete decisions. The export request counts against the wake budget like any other request.

Alternative: keep confirm GETs under a flag during rollout. Rejected after weighing it: the two paths would need to agree on `seenAcc`, and the memo's known catch-up stall is in that code. Instead, rollout safety comes from the circuit breaker plus a `presenceDeletesEnabled` config flag (default on) that Status can turn off to fall back to Trash-only deletes.

### D5. Delete evidence: two signals, one survival check, per direction

Raindrop → Edge. A pair is a delete candidate only when (a) its raindrop id appears in Trash listing, or (b) its raindrop id is absent from a complete snapshot. Candidate then passes the survival check: if `byUrlKey` in the snapshot has any other id for the record's urlKey, rebind to it (D3) and stop. Only then enqueue `delete-edge`. `processDeleteEdge` repeats the check against the current snapshot at execution time so a stale queued job cannot delete after the URL reappears.

Edge → Raindrop. `handleBookmarkRemoved` requires `removeInfo.node` (or a walked folder payload) and writes `{ urlKey, url, title, at, bookmarkId }` to a durable `edgeRemoved` ledger, then enqueues `delete-raindrop` as today. `processDeleteRaindrop` performs the survival check: search the live tree for the record's urlKey under the synced scope, meaning the mirror root plus the outside-root landing zone (`Other favorites / Raindrop / …`, see `isOutsideRootLandingSegments` in `collections.js`) when an outside-root allowlist is active. Folders outside that scope are not consulted, so a copy in an unsynced folder does not keep the raindrop alive. If a copy survives, the removal was a duplicate: forget the pair for the removed bookmark id only, rebind the record to the surviving copy, and drop the job. If no copy survives, delete the raindrop, tombstone, and remove the ledger entry. Ledger entries older than 7 days are pruned.

A confirm GET that returns 404 is no longer a signal anywhere. `probeLivingRaindrop` and `raindropStillAlive` are deleted.

### D6. Reclaim on every create

`processUpload` drops the `shouldReclaim` gate. Before create: look up `urlMatchKeys(url)` in the snapshot (refresh per D4); if there is a claimable id per `pickMoveRebindCandidate`, bind and update placement. If the snapshot is stale and cannot be refreshed within budget, fall back to one `searchRaindrops(url)` as today. Only when both say none does it create. Conflict (every match owned by another live bookmark) keeps today's move behavior for `reason === "move"` and creates for a plain create, since two Edge bookmarks with the same URL legitimately map to two raindrops.

### D7. Tombstone prune and Trash hygiene move to set operations

Tombstone prune is `tombstones − snapshot.ids` when the snapshot is complete; no GETs. Check Trash "safe to empty" restarts from page 0 on every click, which removes the resume-past-end bug by construction.

### D8. What is deleted

From `store.js` reconcile state: `seenAcc`, `unsettledConfirmCatchUp`, `aliveConfirmOffset`, `tombstoneConfirmOffset`, `parkedAliveIds`, `trashHygieneNextPage`, and the park/unpark functions. From `reconcile-finish.js`: `runConfirmCatchUp`, `finishConfirmGets`, `rotateConfirmWindow`, `seenAccWithLive`, `finishDeleteDetection`, `finishTombstonePrune` (replaced by a few lines), `probeLivingRaindrop`, `raindropStillAlive`. From `reconcile.js`: the confirm-only wake branch and the `seenAcc` union. From `wake-budget.js`: confirm-specific caps. From `options.js`: catch-up / postponed / parked Status copy. `SOFT_MAX_REQS_PER_WAKE` stays for drain.

"Settled" reconcile finish simplifies to: listing complete and, if a snapshot refresh was due, refreshed. Quiet-time cooldown then always arms after a completed finish.

### D9. Pair health in Status

`pairHealth(pairs, tree, snapshot)` in `pair-health.js` returns counts: liveLive, staleEdgeId, staleRaindropId, edgeOnlyUrls, raindropOnlyUrls, duplicateUrlGroupsEdge, duplicateUrlGroupsRaindrop, snapshotAgeMs, complete. Options → Status renders it on each status poll from the last computed values (the worker computes after each reconcile finish and stores the result; the page never fetches the export itself). **Repair pairs** keeps its dry-run/apply shape but its plan is now the D3 rebind pass plus the existing prune/tombstone/drop-jobs steps, and it no longer resets confirm state because that state no longer exists.

### D10. Tests under `node:test`

`scripts/verify-*.mjs` become `test/*.test.mjs` run by `node --test`. The store, presence, rebind, evidence, and reclaim modules take their I/O as injected functions (tree reader, snapshot, client) so each memo invariant is a unit test with fixtures. The existing live checklist keeps a `--live` entry point for manual runs.

## Risks / Trade-offs

- [Export CSV is one large response; a partial or malformed body could read as "everything absent"] → `complete` is false on any parse error or row count below 50% of the previous snapshot; incomplete snapshots never drive deletes; the breaker is the last line.
- [Export lacks collection, so out-of-scope raindrops look "present"] → That is the intended semantics for presence. Placement drift is still handled by the nested listing. Out-of-scope living pairs are simply not deletes, which matches the current parking outcome without the state.
- [Migration on a large map at worker start could exceed one wake] → Migration runs under the pair lock with the tree read once and no per-item requests; ~6k records is milliseconds. If the export fails, the partial path (D2) blocks deletes until it completes.
- [Two Edge bookmarks with the same URL] → Records are keyed by raindrop id, so both can exist. Survival check on Edge → Raindrop treats a surviving copy as "duplicate removed" and forgets only the removed copy's pair. The pair-health dupe count surfaces these.
- [`onRemoved` without a node payload (older Chromium)] → No ledger entry, no delete. The pair is left intact and Repair or the next stale-id rebind handles it. Logged once per wake.
- [Extra request per genuinely new bookmark when the snapshot is stale] → Bounded by D4 staleness; during Import the snapshot is refreshed once and reused for the whole batch.
- [Users relying on Status catch-up copy] → Replaced by pair-health counts and snapshot age, which are more informative.
- [Rollback] → `PAIRS_V1_BACKUP` allows reverting the store for one reconcile cycle; `presenceDeletesEnabled=false` disables absence-based deletes without a code change.

## Migration Plan

1. Ship D1–D4 and D9 read paths with deletes still gated by the breaker and `presenceDeletesEnabled` defaulting on. Migration runs on first load; log line reports kept / rebound / dropped counts.
2. Ship D5–D7 and delete the confirm-GET code (D8) in the same release; there is no meaningful intermediate state where both paths run.
3. Before the release on the primary profile: take a Raindrop export and a copy of the Bookmarks file per `AGENTS.md`.
4. After the first reconcile finish: verify Status pair health shows zero stale-id pairs and the breaker count is unchanged, then the v1 backup key is dropped.

## Resolved Questions

- **Staleness threshold.** `PRESENCE_STALE_MS` is a fixed 10-minute constant for the first release, not derived from the reconcile interval. One number is easier to reason about in logs, and the cost of a wrong value is an extra export request or a rare missed reclaim, both caught by existing guards. Revisit only if exports show up more often than heartbeats.
- **Edge-side survival scope.** The survival search covers the synced scope: the mirror root plus the outside-root landing zone when an outside-root allowlist is active. Whole-tree search was rejected because it would bind a pair to a bookmark the engine otherwise ignores. Mirror-only was rejected because allowlisted outside-root landings are synced folders and a copy there is a real survivor.
