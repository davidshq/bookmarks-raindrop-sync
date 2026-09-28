## MODIFIED Requirements

### Requirement: Traffic-aware heartbeat reconcile deferral
When sync mode is `bidirectional`, heartbeat SHALL share one per-wake spendable budget across prefer-drain then reconcile (Trash / list / confirm) then a second drain. The engine SHALL NOT skip starting a *new* Raindrop reconcile cycle solely because the durable queue still contains Raindrop-bound jobs. Settled quiet-time cooldown, in-progress cursor continue, bulk_pause, and the hard rate-limit pause (`rateLimitedUntil`) remain. Machine-readable skip reason `busy` SHALL mean in-process reentrancy (reconcile already running), not queue contention. A user-triggered "Pull now" SHALL bypass quiet-time cooldown (it SHALL still honor the global rate-limit pause).

#### Scenario: Queue work does not block leftover listing
- **WHEN** bidirectional mode is on and the quiet-time reconcile interval has elapsed (or unsettled confirm catch-up is active)
- **AND** no in-progress reconcile cursor remains
- **AND** the durable queue still contains at least one Raindrop-bound job
- **AND** the heartbeat fires without `force` after prefer-drain left spendable remaining
- **THEN** the engine starts or continues Raindrop Trash / list / confirm work on that leftover budget
- **AND** the result reason is not `busy` solely because of queue contention

#### Scenario: Quiet install honors configured interval
- **WHEN** bidirectional mode is on and the quiet-time reconcile interval has elapsed
- **AND** no in-progress reconcile cursor remains
- **AND** the last finish was settled (no unsettled confirm catch-up)
- **AND** the heartbeat fires without `force`
- **THEN** the engine starts a Raindrop listing pass for the configured root tree subject to spendable and wake cap

#### Scenario: In-progress cursor continues with queue work
- **WHEN** a reconcile cycle is mid-cursor across heartbeats
- **AND** Raindrop-bound jobs are also queued
- **THEN** the engine continues the in-progress listing/finish work on the next heartbeat subject to rate-limit pause and shared spendable

#### Scenario: Reentrancy still reports busy
- **WHEN** reconcile is already running in-process
- **AND** another reconcile entry is attempted
- **THEN** the result is skipped with reason `busy`

#### Scenario: Empty leftover budget skips new cycle index
- **WHEN** prefer-drain has exhausted the shared wake budget
- **AND** no in-progress reconcile cursor remains
- **AND** the heartbeat would start a new cycle without `force`
- **THEN** the engine does not fetch collection index for that cycle
- **AND** it does not invent a queue-contention `busy` skip reason

### Requirement: Heartbeat reconcile skip reasons include bulk_pause
When sync mode is `bidirectional`, heartbeat reconcile skip reasons SHALL include machine-readable `bulk_pause` in addition to `busy` (reentrancy only), `rate_limited`, and `cooldown`. The engine SHALL set `bulk_pause` when durable bulk-prompt state is `needs_choice` and SHALL skip starting or continuing Raindrop listing work on that heartbeat tick (after the drain pause already applies). A user-triggered "Pull now" SHALL NOT be the primary remediation for `bulk_pause`; Match or Continue drip on Status SHALL resolve the prompt.

#### Scenario: Bulk prompt stamps bulk_pause
- **WHEN** bulk-prompt state is `needs_choice`
- **AND** the heartbeat tick runs
- **THEN** the engine does not perform Raindrop reconcile listing that tick
- **AND** durable status records skip reason `bulk_pause`

#### Scenario: Skip reasons remain distinct
- **WHEN** Status refreshes after a deferred Raindrop check
- **THEN** `busy`, `cooldown`, `rate_limited`, and `bulk_pause` remain distinguishable machine-readable reasons
- **AND** the Options UI can surface matching copy for each
- **AND** `busy` is not used to mean durable queue contention
