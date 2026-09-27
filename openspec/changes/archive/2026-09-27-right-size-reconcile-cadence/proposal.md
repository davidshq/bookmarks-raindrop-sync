## Why

Heartbeat treats every completed bidirectional reconcile as “quiet time,” then waits the configured interval (default **15 minutes**) before the next cycle — even when thousands of missing-raindrop confirms were deferred or catch-up is unfinished. Status shows “0 pending” + cooldown while unused Raindrop quota sits idle. That is a self-imposed cadence bug documented in [`docs/sync-architecture-right-sizing.md`](../../../docs/sync-architecture-right-sizing.md) (phases 2 + 5). Park-out-of-scope-alives stops forever-candidates regenerating; this change stops unfinished work looking like idle cooldown and shortens the settled default.

## What Changes

- Quiet-time cooldown arms only when a finished cycle is **settled** (no deferred unparked confirm work remaining after finish).
- Unsettled finish keeps heartbeat eligible every alarm tick (subject to busy / rate-limit / bulk_pause) until catch-up settles.
- Default `reconcileIntervalMinutes` becomes **1** (alarm floor); Options presets unchanged otherwise. **BREAKING** for installs that relied on implicit 15‑minute default without opening Settings (existing stored config values remain).
- Activity log no longer blames “rate-limit budget” for internal confirm caps; Status distinguishes unsettled catch-up from true quiet-time cooldown.
- Out of scope for this change: header-driven spendable drain (phase 3), replacing busy mutex (phase 4), raising primary job/alive caps.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `bookmark-sync-engine`: Settled-only quiet cooldown; honest deferred-confirm / Status skip copy; default quiet interval 1 minute.
- `bidirectional-sync`: Quiet cadence default 1 minute; cooldown only after settled cycles.
- `extension-config`: Default `reconcileIntervalMinutes` is 1; help/Status copy for settled idle vs catch-up.

## Impact

- `src/lib/constants.js` — `DEFAULT_RECONCILE_INTERVAL_MINUTES = 1`
- `src/lib/reconcile.js` / `reconcile-finish.js` / `store.js` — settled flag / lastSettledAt vs lastRunAt; cooldown gate
- `src/lib/store.js` Status skip reasons / copy; options HTML default selected option
- Verify scripts + `docs/sync-architecture-right-sizing.md` migration note
- Specs that still say default 15 minutes
