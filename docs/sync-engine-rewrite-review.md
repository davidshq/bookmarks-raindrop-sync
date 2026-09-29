# Review: staged sync-engine rewrite (2026-09-28)

Scope: all staged changes on branch `darn-you-ai` (51 files, +4876/−1445).

**Verdict: P0 and P1 findings are fixed; P2 and P3 items remain.** Findings 1–5 (query-string identity, Edge-id-as-live, second-look complete, tombstone age, dead-occupant delete), 10–11 (heartbeat listing stall, Check Trash resume) and 14 are fixed in the codebase and removed from this list.

Baseline (as of the original review):

- `npm test`: 97/97 pass.
- `eslint .`: clean.
- `npm run test:integration`: was failing on finding 14 (fixed: `verify-integration.mjs` now passes the removed node).
- `prettier --check`: was failing on `test/helpers/fake-raindrop.mjs` (file now formats); other pre-existing unformatted files may remain.

Finding 7 was confirmed by reading the code; the rest come from the reviewers' reports.

> Note: during the review, live scripts ran against the real Raindrop account:
>
> - `test:integration` wrote under the `test-edge-raindrop-sync` collection and failed partway, so check that collection for leftovers.
> - `checklist --live` created and cleaned up `ERS-Verify-*` collections.
> - `smoke-bulk` read the real export, dry-run only.

## Medium

### 6. [P2] Trash-signal deletes stall when the snapshot is unusable

*Triage: It fails safe (the delete is deferred rather than wrong) and only happens while exports are failing.*

`job-processors.js:1005` throws "Presence snapshot unavailable" for both `trash` and `absent` signals. The spec says Trash deletes SHALL still run. The generic Error counts as a retry attempt, so legitimate deletes can dead-letter. `test/evidence.test.mjs:88` only checks the job is enqueued.

### 7. [P2] Migration drops pairs recorded while it runs

*Triage: It needs a bookmark created during the one-time migration export window, and the cost is one duplicate raindrop.*

In `pair-migration.js:41-49, 72-92`, the tree index and snapshot are taken outside the lock. The "dead on both sides → drop" rule runs without the `lastSeen* > snapshot.at` guard that `rebindPass` has. A pair created during the export window is deleted, which leads to a duplicate on the next cycle.

### 8. [P2] Repair apply can lose newer pairs

*Triage: It needs a pair recorded between a manual dry-run and apply, and the cost is a few lost pairs or duplicates.*

In `repair-pairs.js:323-327` with `store.js:458-470`, rebound `keptPairs` are not checked against pairs recorded after the dry-run. `rewritePairs` keys by raindrop id, so the last entry wins. This contradicts the "post-plan changes win" comment.

### 9. [P2] Repair prunes from an export it knows is incomplete

*Triage: An empty export is already refused, a truncated 200 body is rare, and the dry-run shows prune counts before apply.*

`repair-pairs.js:108-147, 212`: the planner ignores `snapshot.complete` and the shrink threshold. A truncated export prunes thousands of live pairs.

### 12. [P2] Every pair mutation rewrites the whole store

*Triage: This is performance only: about 3 MB is well under the 10 MB quota, and it does not affect correctness.*

`store.js:353-360` (`mutatePairs`) and `store.js:414-436` (`recordSynced`) read, scan and rewrite the full PAIRS item. That includes no-op `forgetSynced`.

- v2 records are about 3 MB for 5,800 pairs.
- Match existing performs about 5,000 full rewrites.
- There is no `unlimitedStorage` permission (10 MB limit).

### 13. [P2] Search fallback reads one 50-item page

*Triage: The fallback runs only without a URL-indexed snapshot, needs more than 50 full-text hits, and costs one duplicate raindrop.*

`job-processors.js:202`: an exact URL beyond the first 50 full-text hits counts as "none", and a duplicate is created. The fake's substring search cannot miss, so the fallback test passes regardless.

## Low / code smells

- **[P2] Incomplete finish counts as completed.** A refreshed but incomplete finish arms the cooldown and deletes `PAIRS_V1_BACKUP` (`reconcile-finish.js:154,177`). Nothing ever reads that backup back.

  *Triage: It throws away the only v1 pair backup, which is the rollback path.*

- **[P3] Silent loss in v1 → v2 conversion.** Reverse-only and duplicate-raindrop entries are dropped without logging (`store.js:309-316`).
- **[P3] Null bookmark ids are dropped.** `rewritePairs` drops records with `bookmarkId == null` (latent).
- **[P3] Unlocked write.** `dropLegacyReconcileState` does an unlocked read-modify-write that can revert a concurrent `setReconcileState` (`store.js:368`, `store.js:864`).
- **[P2] Migration can run concurrently.** It is called from startup, drain and reconcile, and each call may fetch its own export.

  *Triage: This widens the window for finding 7 and multiplies export calls.*

- **[P2] Restart loses the URL index.** The snapshot restored after a worker restart has no URL index, so the first create after any restart triggers a full export. The spec scenario "restart restores … without a new export" only half holds.

  *Triage: MV3 workers restart often, so this can mean an export on most creates.*

- **[P3] Misleading pair health.** It shows "0 live↔live" when there is no snapshot (`pair-health.js:164-167`).
- **[P3] Absence jobs removed, not held.** Absence jobs are removed rather than held while `migrationPartial` is set or the flag is off (`job-processors.js:996`). The spec says "blocked".
- **[P3] Unresolved Trash ids.** A paired Trash id whose record has no URL is never resolved, so safe-to-empty waits forever (`reconcile-finish.js:301-319`).
- **[P1] Upload after a renumber can cross pairs.** Until reconcile rebinds a pair whose old Edge id now holds an unrelated bookmark, an edit to that bookmark uploads onto the pair's raindrop (`processUpload` trusts `getRaindropId(bookmarkId)`). The URL alone cannot tell this apart from a real edit.

  *Triage: Needs an overlapping renumber plus an edit before the next reconcile; the cost is a raindrop overwritten with the other bookmark's link and title.*

- **[P2] Deletes an unsynced copy.** When the pair's bookmark id is stale, the Edge delete binds by URL to any unbound in-scope copy, including a never-synced one (`job-processors.js:1049-1057`).

  *Triage: This path deletes an Edge bookmark the user never synced.*

- **[P2] Ledger not enforced.** A job held by the breaker past the 7-day `edgeRemoved` TTL still deletes on `job.url` alone (`job-processors.js:910`).

  *Triage: A breaker-held job can delete on stale evidence.*

- **[P3] Migration errors unlogged.** `service-worker.js:66-74`: `handleClientError` never sees client errors from migration, so non-client errors go unlogged.
- **[P3] Contradictory docs.** AGENTS.md says a missing counterpart is not delete evidence; D5 and the delete-evidence spec make absence from a complete snapshot a delete signal. Reconcile the two.
- **[P3] Tasks vs rollout doc.** Tasks 9.2–9.4 are marked done while `docs/sync-engine-rewrite.md` still says the primary-profile rollout is pending.
- **[P3] Dead code:** `runTrashHygienePeek` always returns `handled: 0`, and `trashSafeButtonLabel(_state)` ignores its argument.
- **[P3] Repair progress in the wrong place.** The Status "Repair pairs" shortcut writes progress to the Manual Sync section.
- **[P3] `test:live` narrowed.** It no longer runs the logic suite.
- **[P2] Fake Raindrop fidelity** (`test/helpers/fake-raindrop.mjs`):

  *Triage: The fake lets the tests for finding 13 and list ordering pass whatever the code does.*

  - Substring URL search that cannot miss.
  - Lists returned oldest-first; the real API is newest-first.
  - No 50-per-page cap.
  - Deleting an item already in Trash is a no-op; the real API deletes it permanently.

## Missing tests

- [P2] A pair recorded during migration; migrating twice; the legacy DEDUP key.
- [P2] `mergeRepairPlan` with rebound `keptPairs`.
- [P2] Trash deletes executing with an unusable snapshot.
- [P2] The 7-day `edgeRemoved` ledger prune.

## Verified OK

- Options UI: no XSS (only `textContent` is used), every message the page sends has a handler, and no UI was lost.
- No assertions were dropped in the test ports, apart from the intended ones.
- The circuit breaker is applied to every `delete-edge` and `delete-raindrop` drain job.
- The v1 → v2 write is atomic, and absence deletes are gated during a partial migration.
- Trash paging stop condition is correct; a renumbered Edge id is resolved by URL before `removeNode`.
- **P0/P1 closed since review:** query-string URL identity (1); Edge id live only when URL matches (2); shrink/empty second-look cannot promote to complete (3); tombstone prune respects `at > snapshot.at` (4); delete rebinds when survivor’s paired bookmark is dead (5); heartbeat lists again after three presence-only wakes (10); Check Trash sweeps across clicks with a head rescan (11); `verify-integration` passes removed-node payload (14); smoke Repair button selector fixed; circuit breaker gating evidence-based Edge deletes is tested; pull-update refreshes the pair record (drifted records heal from the export) and never rewrites a bookmark whose URL no longer matches its pair.

## Recurring patterns

1. **Evidence without a timestamp check** (finding 7): every snapshot-based decision needs "was this record created after the evidence?" `rebindPass` has that guard; the migration drop does not.
2. **Weak signals still in play** (findings 6, unsynced-copy delete, ledger): "snapshot unavailable", "any unbound URL copy", and "job.url alone" are hints, not decisions.

## Suggested order

1. **P1 before or right after shipping:** the upload-after-renumber risk (needs a design).
2. **P2 soon:** first fake Raindrop fidelity, then 9, 7 with concurrent migration, 8, 6, 13, 12, restart URL index, incomplete finish, unsynced-copy delete, ledger.
3. **P3 when convenient:** the remaining low items and docs.
