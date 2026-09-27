## MODIFIED Requirements

### Requirement: Periodic reconcile trigger
When sync mode is `bidirectional`, the engine SHALL run Raindrop reconciliation on the alarm heartbeat (and when explicitly requested) to discover new raindrops and remotely deleted raindrops under the configured root. The minimum gap between *settled completed* heartbeat reconcile cycles SHALL be the user-configured quiet-time interval (default 1 minute). A finished cycle is settled only when no unparked missing-raindrop confirm candidates remain deferred after that finish pass. Unsettled finishes SHALL NOT arm quiet-time cooldown; subsequent heartbeats MAY start a new cycle (subject to traffic-aware deferral and rate-limit pause) until a settled finish occurs. In-progress cursors always continue; manual "Pull now" bypasses the quiet-time interval. Heartbeat starts of a new cycle SHALL also honor traffic-aware deferral defined for this engine.

#### Scenario: Heartbeat reconcile
- **WHEN** bidirectional mode is on and the alarm heartbeat fires
- **AND** the quiet-time interval has elapsed since the last settled finish (or catch-up is unsettled)
- **AND** traffic-aware deferral does not apply
- **THEN** reconcile runs for the configured root tree subject to rate-limit backoff

#### Scenario: Configured quiet-time cooldown after settled finish
- **WHEN** a bidirectional reconcile cycle has completed successfully and settled
- **AND** the heartbeat fires again before the configured quiet-time interval elapses
- **AND** no in-progress cursor remains
- **THEN** the engine skips starting a new Raindrop listing pass with reason `cooldown`
- **AND** a user-triggered "Pull now" still runs immediately (subject to rate-limit pause)

#### Scenario: Unsettled finish skips cooldown
- **WHEN** a bidirectional reconcile cycle finishes with unparked missing-raindrop confirms still deferred
- **AND** the durable queue has no Raindrop-bound jobs
- **AND** the heartbeat fires again before the configured quiet-time interval would have elapsed from `lastRunAt`
- **THEN** the engine does not skip with reason `cooldown`
- **AND** it starts or continues reconcile subject to rate-limit pause

## ADDED Requirements

### Requirement: Honest deferred confirm messaging
When reconcile finish postpones unparked missing-raindrop confirm GETs because of the per-cycle confirm cap, the activity log SHALL state that work continues on a later cycle due to the confirm budget, and SHALL NOT attribute that postponement to Raindrop rate-limit exhaustion unless a rate-limit pause is actually active.

#### Scenario: Postpone log is not rate-limit blame
- **WHEN** finish defers N > 0 missing-raindrop confirms under the per-cycle confirm cap
- **AND** no Raindrop rate-limit pause is active
- **THEN** the activity log mentions postponed confirms and continuing next cycle
- **AND** the message does not claim “rate-limit budget”
