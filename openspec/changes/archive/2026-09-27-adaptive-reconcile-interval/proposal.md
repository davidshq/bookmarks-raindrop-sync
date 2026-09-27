## Why

Bidirectional Raindrop→browser discoverability is capped by a fixed 15-minute reconcile cooldown. Users who want faster remote-delete/create detection have no control, and a blanket shorter interval would fight upload/drain traffic for Raindrop rate-limit budget. The cooldown should be configurable and stretch automatically when the extension is already busy with Raindrop work.

## What Changes

- Add a persisted settings field for the bidirectional **reconcile interval** (desired minimum gap between completed heartbeat reconcile cycles when the install is quiet).
- Expose that interval in Options (bidirectional-only), with a clear default matching today’s 15 minutes.
- Make heartbeat reconcile **traffic-aware**: when the durable queue still has Raindrop-bound work, skip starting a *new* reconcile cycle even if the configured interval has elapsed; when quiet, honor the configured (possibly aggressive) interval. Low rate-limit remaining continues to use the existing hard pause (`rateLimitedUntil`) rather than a separate soft-busy snapshot.
- Keep **Pull now** as an immediate force path (still respects the global rate-limit pause).
- In-progress reconcile cursors continue to advance on heartbeats regardless of the idle interval.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `extension-config`: Persist and expose bidirectional reconcile interval; document quiet-vs-busy help text.
- `bookmark-sync-engine`: Replace fixed cooldown with config-driven interval plus traffic-aware skip reasons.
- `bidirectional-sync`: Clarify that periodic reconcile cadence is user-configurable and may defer when competing Raindrop traffic is active.

## Impact

- `src/lib/constants.js` — default interval; remove or demote hard-coded `MIN_RECONCILE_INTERVAL_MS` to default/clamp helpers.
- `src/lib/store.js` — config normalize/clamp for `reconcileIntervalMinutes`.
- `src/lib/reconcile.js` / `src/lib/sync.js` — interval from config; queue-busy skip before listing.
- `src/options/*` — settings control (bidirectional-only).
- Verify scripts / README for the new setting and queue-busy deferral.
- No Raindrop API or webhook dependency; still poll-based. Hard rate-limit pause unchanged.
