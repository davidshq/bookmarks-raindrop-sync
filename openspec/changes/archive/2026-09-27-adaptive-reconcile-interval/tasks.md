## 1. Config + constants

- [x] 1.1 Add `reconcileIntervalMinutes` to `DEFAULT_CONFIG` (default 15) plus min/max/default constants; replace hard-coded `MIN_RECONCILE_INTERVAL_MS` with `reconcileIntervalMs(config)` helper
- [x] 1.2 Clamp/normalize `reconcileIntervalMinutes` in `normalizeConfig` / `setConfig` path
- [x] 1.3 Document the new config field on `KEY.CONFIG` comment and in README settings section

## 2. Durable rate-limit snapshot

- [x] 2.1–2.3 ~~Extend status with soft-busy snapshot~~ **Dropped (pragmatic):** hard `rateLimitedUntil` already covers low remaining; no second durable soft gate.

## 3. Traffic-aware reconcile gate

- [x] 3.1 In `reconcile({ force: false })`, after in-progress check: skip with `busy` when queue has Raindrop-bound jobs
- [x] 3.2 Use configured `reconcileIntervalMs` for the cooldown check (reason `cooldown`)
- [x] 3.3 Keep `force: true` (Pull now) bypassing interval and queue-busy; still respect hard `rateLimitedUntil`
- [x] 3.4 Add verify-script cases: quiet honors short interval; queued upload defers; in-progress continues

## 4. Options UI

- [x] 4.1 Add bidirectional-only reconcile interval `<select>` presets (1/2/5/15/30/60) with adaptive-polling help text
- [x] 4.2 Load/save the field with settings; hide in one-way; toggle with sync-mode UI
- [x] 4.3 Wire popup/Options pull skip messaging if heartbeat `busy` needs a distinct string (reuse existing busy copy if adequate)

## 5. Docs + smoke

- [x] 5.1 Update README bidirectional section for configurable interval + queue-busy deferral
- [x] 5.2 Run verify scripts / checklist affected by config and reconcile skip reasons
