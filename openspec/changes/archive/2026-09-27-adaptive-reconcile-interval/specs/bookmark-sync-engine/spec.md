## ADDED Requirements

### Requirement: Traffic-aware heartbeat reconcile deferral
When sync mode is `bidirectional` and the heartbeat would start a *new* Raindrop reconcile cycle (no in-progress cursor), the engine SHALL skip starting that cycle when the durable queue still contains jobs that perform Raindrop API work. The skip result SHALL use machine-readable reason `busy`. In-progress reconcile cursors SHALL continue on subsequent heartbeats regardless of queue contention. A user-triggered "Pull now" SHALL NOT be deferred for queue contention (it SHALL still honor the global rate-limit pause). Low rate-limit remaining is handled by the existing hard pause (`rateLimitedUntil`), not a separate durable soft-busy snapshot.

#### Scenario: Queue busy defers new listing
- **WHEN** bidirectional mode is on and the quiet-time reconcile interval has elapsed
- **AND** no in-progress reconcile cursor remains
- **AND** the durable queue still contains at least one Raindrop-bound job
- **AND** the heartbeat fires without `force`
- **THEN** the engine skips starting a new Raindrop listing pass
- **AND** the result reason is `busy`

#### Scenario: Quiet install honors configured interval
- **WHEN** bidirectional mode is on and the quiet-time reconcile interval has elapsed
- **AND** no in-progress reconcile cursor remains
- **AND** the durable queue has no Raindrop-bound jobs
- **AND** the heartbeat fires without `force`
- **THEN** the engine starts a Raindrop listing pass for the configured root tree

#### Scenario: In-progress cursor ignores busy gate
- **WHEN** a reconcile cycle is mid-cursor across heartbeats
- **AND** Raindrop-bound jobs are also queued
- **THEN** the engine continues the in-progress listing/finish work on the next heartbeat subject to rate-limit pause

## MODIFIED Requirements

### Requirement: Periodic reconcile trigger
When sync mode is `bidirectional`, the engine SHALL run Raindrop reconciliation on the alarm heartbeat (and when explicitly requested) to discover new raindrops and remotely deleted raindrops under the configured root. The minimum gap between *completed* heartbeat reconcile cycles SHALL be the user-configured quiet-time interval (default 15 minutes). In-progress cursors always continue; manual "Pull now" bypasses the quiet-time interval. Heartbeat starts of a new cycle SHALL also honor traffic-aware deferral defined for this engine.

#### Scenario: Heartbeat reconcile
- **WHEN** bidirectional mode is on and the alarm heartbeat fires
- **AND** the quiet-time interval has elapsed
- **AND** traffic-aware deferral does not apply
- **THEN** reconcile runs for the configured root tree subject to rate-limit backoff

#### Scenario: Configured quiet-time cooldown
- **WHEN** a bidirectional reconcile cycle has completed successfully
- **AND** the heartbeat fires again before the configured quiet-time interval elapses
- **AND** no in-progress cursor remains
- **THEN** the engine skips starting a new Raindrop listing pass with reason `cooldown`
- **AND** a user-triggered "Pull now" still runs immediately (subject to rate-limit pause)
