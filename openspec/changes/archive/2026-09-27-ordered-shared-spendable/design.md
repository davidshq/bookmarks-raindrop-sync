## Context

Phases 1–3 of [`docs/sync-architecture-right-sizing.md`](../../../docs/sync-architecture-right-sizing.md) shipped: park out-of-scope alives, settled-only cooldown (default 1 min), header-driven `WakeBudget` shared across drain → reconcile → drain on full wakes. Heartbeat still returns `skipped: true, reason: "busy"` when `hasRaindropBoundQueueWork()` before starting a *new* reconcile cycle. That mutex was intentional under fixed 25/55 caps; with shared spendable it now starves Trash/list while leftover quota sits unused.

MV3: prefer-drain ordering already lives in `tick()`; this change only removes the hard skip and retires Status semantics that treated queue depth as “listing deferred.”

## Goals / Non-Goals

**Goals:**

- Heartbeat may start or continue reconcile (Trash / list / confirm) when Raindrop-bound jobs remain, subject to spendable, wakeCap, cooldown, bulk_pause, and rate-limit pause.
- Prefer drain: first `drain({ budget })` runs before reconcile on the same `WakeBudget` so uploads win the first slice; leftover funds presence work; second drain clears jobs reconcile enqueued.
- Status: `busy` means in-process reentrancy only; queue depth is shown via pending counts, not a listing-deferral banner. After Match/Continue, clear `bulk_pause` without stamping `busy`.
- Verify scripts cover: queue + leftover spendable ⇒ Trash/list progress; no false `busy` skip for queue contention.

**Non-Goals:**

- Separate Trash-only entry outside `reconcile` / `finishReconcileCycle` (default quiet interval is already 1 min; spendable limits slices).
- Concurrent drain and reconcile in parallel (still sequential on one wake).
- Changing confirm-before-act, park, bulk pause gate, Pull-now force, or event-path short budget.
- Raising fixed historical caps as the primary throttle (already demoted in phase 3).

## Decisions

### D1 — Delete the queue-busy gate; keep cooldown / in-progress / bulk_pause

**Choice:** In `reconcileOnce`, remove the `!force && !inProgress && hasRaindropBoundQueueWork() → busy` early return. Keep:

1. In-process `reconciling` flag → `busy` (reentrancy)
2. `rateLimitedUntil` → `rate_limited`
3. Settled quiet cooldown when `!unsettledConfirmCatchUp` → `cooldown`
4. `bulk_pause` at tick level before calling reconcile
5. Shared `budget.shouldStop()` before starting a *new* cycle → return done without collection-index GETs (no new skip reason; `lastThrottle` covers self-cap). In-progress cursor and Pull now (`force`) may still enter.

**Why:** Ordering + shared spendable already prefer drain; the mutex was the remaining starve. Cooldown still prevents settled idle from burning nested list every wake when interval > 1. Without (5), prefer-drain that empties the wake budget would still burn ~2 collection GETs for no list/Trash progress.

**Alternatives:** Soft “presence-only while queue busy” mode (rejected for v1 — budget leftovers already size the slice); defer only when pending > N (rejected — arbitrary; spendable is the brake); hard-gate inside `RaindropClient.request` (rejected — blast radius on ensure/reclaim paths).

### D2 — Tick order unchanged

**Choice:** Keep `tick()`: create full `WakeBudget` → drain → (gates) → reconcile → drain. No new scheduler.

**Why:** Matches the memo’s target tick; minimal blast radius.

### D3 — Retire Status `busy` as queue-contention deferral

**Choice:**

- `formatReconcileSkipNotice` for `busy`: copy describes reconcile already running (reentrancy), not “queue still has Raindrop work.”
- `refreshReconcileSkipAfterBulkResume`: always `clearReconcileSkip()` after needs_choice clears (pending queue is visible elsewhere).
- Options guard that maps stale `bulk_pause` → `busy` when pending > 0: map to clear / null instead of inventing busy.
- Help text under reconcile interval: drop “busy sync queue defers listing”; say drain prefers spendable then leftover funds Trash/list.

**Alternatives:** Keep `busy` banner whenever pending > 0 even if listing ran (rejected — Status lie). New skip reason `drain_priority` (rejected — not a skip).

### D4 — `hasRaindropBoundQueueWork` stays as a helper

**Choice:** Keep the helper for bulk resume / diagnostics if useful; stop using it as a reconcile start gate. Callers that only stamped Status busy may drop the call.

### D5 — Pull now unchanged

**Choice:** `force: true` still bypasses cooldown; never needed the busy gate for Pull now. Rate-limit pause still honored.

## Risks / Trade-offs

- **[Risk] Listing competes with drain under load and slows Edge→Raindrop SLO** → Mitigation: prefer-drain first; spendable/wakeCap stop reconcile; soft page/confirm backstops remain.
- **[Risk] Tests and Status still expect `busy` for queued jobs** → Mitigation: update verify + Options copy in the same change; grep for queue-busy assumptions.
- **[Risk] Users miss the old “deferred for queue” explanation** → Mitigation: pending depth + drip ETA already on Status; self-cap vs rate-limit honesty from phase 3/5.

## Migration Plan

1. Spec deltas + code + verifies in one change.
2. Update right-sizing memo phase 4 → done.
3. No storage migration; durable `reconcileSkipReason: "busy"` from older builds clears on next successful tick or bulk resume refresh.

## Open Questions

None for v1 — presence-only-while-busy deferred unless field data shows list starving drain after this ships.
