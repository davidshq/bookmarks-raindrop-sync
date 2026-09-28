## MODIFIED Requirements

### Requirement: Bidirectional reconcile interval setting
When sync mode is `bidirectional`, the extension SHALL let the user choose a quiet-time Raindrop reconcile interval in minutes from a fixed set of presets (at minimum including 1, 5, 15, 30, and 60), defaulting to 1, and SHALL persist the choice with the rest of settings. The control SHALL be hidden in one-way mode. Help text SHALL state that the interval applies when confirm catch-up is settled, and that heartbeat prefers draining the sync queue then uses leftover Raindrop budget for Trash / list work (not that any queued Raindrop job hard-defers all listing). Invalid or missing stored values SHALL normalize to the default (1) and values outside the allowed range SHALL be clamped.

#### Scenario: Save reconcile interval with bidirectional
- **WHEN** sync mode is `bidirectional` and the user selects a reconcile interval preset and saves settings
- **THEN** the interval minutes are persisted
- **AND** subsequent heartbeat reconcile uses that quiet-time interval

#### Scenario: Control hidden in one-way
- **WHEN** sync mode is `one-way`
- **THEN** the options UI does not show the reconcile interval control

#### Scenario: Default one minute
- **WHEN** the user has never set a reconcile interval
- **THEN** the effective stored/default interval is 1 minute

#### Scenario: Help text explains adaptive polling
- **WHEN** bidirectional mode is selected and the user views the reconcile interval control
- **THEN** the UI explains that frequent polling applies when idle and settled
- **AND** that drain prefers the sync queue and leftover budget funds Trash / list (not a hard listing deferral for any queued job)

### Requirement: Status surfaces reconcile deferral reasons
When bidirectional mode is on, the Options Status panel SHALL surface durable heartbeat reconcile-skip reasons (`busy`, `cooldown`, `rate_limited`, `bulk_pause`) with distinct user-visible copy so a deferred Raindrop check does not look like a stuck or idle install. When reason is `bulk_pause`, copy SHALL point at Match or Continue drip on the bulk-queue notice. When reason is `busy`, copy SHALL describe reconcile already running (reentrancy), not durable queue contention. When reason is `cooldown`, copy MAY mention Pull now and SHALL describe quiet-time wait after a settled Raindrop check (not unfinished confirm catch-up). When reason is `rate_limited`, copy SHALL refer to a Raindrop rate-limit pause (not a self wake-cap stop). Status SHALL NOT keep showing `bulk_pause` after needs_choice has already been cleared (guard or refresh SHALL clear the skip). Status SHALL NOT present quiet-time cooldown as the explanation while durable unsettled confirm catch-up is active (catch-up MUST continue on heartbeat instead of arming cooldown).

#### Scenario: Busy means reentrancy
- **WHEN** Status refreshes and reconcileSkipReason is `busy`
- **THEN** the Status panel shows that a Raindrop check is already running
- **AND** does not claim the sync queue alone deferred listing

#### Scenario: Bulk pause copy points at banner actions
- **WHEN** Status refreshes and reconcileSkipReason is `bulk_pause`
- **THEN** the Status panel points the user at Match or Continue drip on the bulk-queue notice

#### Scenario: Cooldown copy is settled quiet-time
- **WHEN** Status refreshes and reconcileSkipReason is `cooldown`
- **THEN** the copy indicates quiet-time wait after a settled check (or equivalent)
- **AND** does not imply unfinished missing-raindrop confirm catch-up

#### Scenario: Rate-limited copy is Raindrop pause
- **WHEN** Status refreshes and reconcileSkipReason is `rate_limited`
- **THEN** the copy indicates a Raindrop rate-limit pause
- **AND** does not describe a self wake-cap stop as that pause

#### Scenario: Stale bulk_pause not shown after Continue
- **WHEN** the user has chosen Continue drip and needs_choice is cleared
- **AND** Status refreshes
- **THEN** the UI does not present `bulk_pause` as the current deferral reason
