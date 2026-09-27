## Context

Quiet-time cooldown today keys off `reconcile.lastRunAt` after every finished cycle. Finish may postpone thousands of missing-raindrop confirms (`MAX_ALIVE_CHECKS_PER_TICK`) and still stamp `lastRunAt`, so heartbeat sits on cooldown (default 15 minutes) with an empty queue. Architecture target: [`docs/sync-architecture-right-sizing.md`](../../../docs/sync-architecture-right-sizing.md) phases 2 + 5. Park-out-of-scope-alives (phase 1) is already implemented.

## Goals / Non-Goals

**Goals:**

- Arm quiet cooldown only after a **settled** finished cycle.
- Default quiet interval **1** minute for new / unset config.
- Honest activity-log and Status copy for deferred confirms vs Raindrop rate limits.
- Keep busy / rate_limited / bulk_pause gates unchanged.

**Non-Goals:**

- Header-driven spendable drain or removing fixed 25/55/8 primacy (phases 3–4).
- Replacing the busy mutex.
- Changing confirm GET count this change (parking already makes progress permanent).

## Decisions

### D1 — Settled = no deferred unparked confirm candidates after finish

**Choice:** After delete-confirm finish, if any unparked missing-raindrop candidates remain unchecked this pass (`deferred > 0`), mark reconcile state **unsettled** and do **not** update `lastSettledAt`. Always still set `lastRunAt` for diagnostics. When `deferred === 0`, clear unsettled and set `lastSettledAt = now`.

**Alternatives:** Treat any activity-log postpone as unsettled without a durable flag (rejected — Status/cooldown need durable state across SW restarts); include tombstone-prune deferrals (rejected for v1 — user pain is delete-confirm mountain).

### D2 — Cooldown gate uses `lastSettledAt`, not `lastRunAt`

**Choice:** Heartbeat `reconcile({ force: false })` skips with `cooldown` only when `!unsettled && lastSettledAt` is within `reconcileIntervalMs(config)`. Unsettled ⇒ no cooldown skip (in-progress / busy / rate-limit / bulk_pause still apply).

**Why:** Matches “cooldown means library looked settled.” Unsettled catch-up runs every heartbeat until deferred hits zero (subject to other gates).

### D3 — Default interval 1

**Choice:** `DEFAULT_RECONCILE_INTERVAL_MINUTES = 1`; Options select default `selected` on 1. Existing persisted values unchanged. Missing/invalid still normalize via clamp to default **1**.

### D4 — Skip reason set unchanged; copy + log honesty

**Choice:** No new `catch_up` skip reason (unsettled does not skip). Fix postpone log to say confirm budget / next heartbeat, not “rate-limit budget.” Cooldown Status copy may note it applies after a settled check. Help text: interval applies when idle **and** confirm catch-up is finished.

### D5 — Persist `unsettledConfirmCatchUp` + `lastSettledAt` on reconcile state

**Choice:** Fields on `KEY.RECONCILE` defaults. Migration: missing `lastSettledAt` → treat as settled using `lastRunAt` for one cycle (avoid stampeding every install into continuous reconcile on upgrade); missing flag → `false`.

**Upgrade nuance:** If we always treated null `lastSettledAt` as unsettled, every upgrade would reconcile every minute until one settled finish. Prefer: `lastSettledAt ??= lastRunAt` on read when both unset use null (no cooldown until first settle).

## Risks / Trade-offs

- **[Risk] Large deferred sets keep listing every minute** → Mitigation: park shrinks candidates; page/alive caps still bound per tick; rate-limit hard pause remains. Phase 3 later fills spendable deliberately.
- **[Risk] Users who liked default 15 get more polling** → Mitigation: presets still include 15/30/60; only unset default changes; help text clarifies.
- **[Risk] `lastSettledAt ??= lastRunAt` masks pre-upgrade deferred piles** → Mitigation: one cooldown then next finish sets unsettled correctly if deferred > 0; Pull now still works.
- **[Trade-off] Tombstone prune deferrals ignored for settled** → Acceptable; separate from user-visible postpone mountain.

## Migration Plan

1. Deploy code + default 1 + settled gate.
2. No storage wipe; new fields optional.
3. Rollback: restore `lastRunAt` cooldown + default 15 (deferred mountain returns).

## Open Questions

- None blocking. Phase 3/4 remain separate changes.
