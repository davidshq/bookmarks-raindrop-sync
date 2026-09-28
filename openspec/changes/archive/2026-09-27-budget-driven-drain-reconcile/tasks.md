## 1. Wake budget primitives

- [x] 1.1 Add constants: `BOOTSTRAP_REQS`, `SOFT_MAX_REQS_PER_WAKE`, `SOFT_MAX_MS_PER_WAKE`, soft confirm/page backstops; document that `MAX_JOBS_PER_DRAIN*` / `MAX_ALIVE_CHECKS_PER_TICK` are fairness backstops under spendable
- [x] 1.2 Add `src/lib/wake-budget.js` (or equivalent): create from persisted/observed remaining, `canSpend` / `noteSpent` / `shouldStop`, hydrate + sync with `RaindropClient` headers after each response
- [x] 1.3 Persist rate window (`rateRemaining`, `rateResetAt`, `rateObservedAt`) and `lastThrottle` (`wake_cap` | `bootstrap` | null) via `store.js`; stale reset → bootstrap
- [x] 1.4 Expose read helpers on `RaindropClient` for remaining/reset; optional hydrate-from-window; keep `throwIfShouldPause` / 429 → `rateLimitedUntil`

## 2. Budgeted drain and reconcile

- [x] 2.1 Thread a shared `WakeBudget` through `tick()` / `reconcileNow()`: create once, pass to first drain → reconcile → second drain; persist window as headers update
- [x] 2.2 Update `drain.js` to stop on `!budget.canSpend` / wakeCap / reserve; demote `drainJobsCap` to soft backstop; honest “wake cap” log (not rate-limit) when self-capped
- [x] 2.3 Live-handler / opportunistic `drain()` uses short synthetic budget; full wake budget only on heartbeat / Pull now / explicit full drain entry
- [x] 2.4 Update `reconcile.js` list paging to consume shared budget (+ soft page backstop)
- [x] 2.5 Update `reconcile-finish.js` Trash pages + confirm GETs to consume shared budget; raise/remove primary role of `MAX_ALIVE_CHECKS_PER_TICK = 8`; keep postpone log honest
- [x] 2.6 On self-cap stop: set `lastThrottle`, do **not** set `rateLimitedUntil`; on real pause: clear or override with `rate_limited` as today

## 3. Status honesty

- [x] 3.1 `formatReconcileSkipNotice` / rate-limit banner: `rate_limited` copy stays Raindrop-pause-only
- [x] 3.2 Options Status + popup surface self-cap (`lastThrottle`) distinctly when no `rateLimitedUntil`
- [x] 3.3 Clear stale `lastThrottle` when a later wake runs useful work or a real rate-limit pause begins

## 4. Docs and verification

- [x] 4.1 Extend verify scripts for bootstrap, spendable drain beyond old 25 when remaining high, confirm > 8 under spendable, self-cap ≠ `rateLimitedUntil`, persisted window after “restart”
- [x] 4.2 Update `docs/sync-architecture-right-sizing.md` migration table: phase 3 (+ remaining phase 5 Status) done; note phase 4 still open
- [x] 4.3 Update README / inline comments that still describe fixed 25/55/8 as the primary throttle
