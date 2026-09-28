## 1. Engine: drop queue-busy gate

- [x] 1.1 Remove `hasRaindropBoundQueueWork()` early-return that skips new reconcile cycles with `busy` in `reconcile.js`; keep reentrancy / rate-limit / settled cooldown gates
- [x] 1.2 Update module comments so heartbeat is described as prefer-drain + leftover spendable (not traffic-busy mutex)
- [x] 1.3 Change `refreshReconcileSkipAfterBulkResume` in `sync.js` to always clear reconcile skip after needs_choice clears (no stamp `busy` for remaining jobs)

## 2. Status and Options copy

- [x] 2.1 Update `formatReconcileSkipNotice` `busy` copy to reentrancy (“already running”), not queue contention
- [x] 2.2 Update Options Status guard that maps stale `bulk_pause` → clear skip (not invent `busy` when pending > 0)
- [x] 2.3 Update reconcile-interval help text: drain prefers queue; leftover funds Trash/list (drop “busy queue defers listing”)

## 3. Verification and docs

- [x] 3.1 Update `verify-checklist.mjs` / `verify-bidirectional-logic.mjs`: replace queue-busy deferral expectations with leftover-spendable listing; expect clear skip (not `busy`) after Continue with jobs remaining
- [x] 3.2 Update `docs/sync-architecture-right-sizing.md` migration table: phase 4 done
- [x] 3.3 Run verify scripts and fix regressions

## 4. Leftover-budget gate (review follow-up)

- [x] 4.1 Before starting a *new* heartbeat cycle, if shared `WakeBudget.shouldStop()`, return without `buildCollectionIndex` (keep in-progress / Pull now)
- [x] 4.2 Verify empty leftover budget skips collection-index GETs
