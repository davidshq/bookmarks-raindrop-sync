## 1. Settled cooldown gate

- [x] 1.1 Add `unsettledConfirmCatchUp` + `lastSettledAt` on reconcile state defaults; read path seeds `lastSettledAt` from `lastRunAt` when missing
- [x] 1.2 Finish delete-confirm sets unsettled + skips `lastSettledAt` when deferred > 0; clears unsettled and sets `lastSettledAt` when deferred === 0
- [x] 1.3 Heartbeat cooldown uses `lastSettledAt` and skips cooldown when `unsettledConfirmCatchUp`

## 2. Defaults and UI copy

- [x] 2.1 `DEFAULT_RECONCILE_INTERVAL_MINUTES = 1`; Options select default on 1; update help text for settled idle
- [x] 2.2 Fix postpone activity-log wording (no “rate-limit budget”); adjust cooldown Status copy for settled quiet-time

## 3. Docs and verification

- [x] 3.1 Note phase 2+5 landed in `docs/sync-architecture-right-sizing.md`
- [x] 3.2 Add verify coverage: unsettled finish does not cooldown-skip; settled finish does; default interval is 1; postpone log text
- [x] 3.3 Run relevant verify scripts
