## ADDED Requirements

### Requirement: Status distinguishes Raindrop pause from self-cap
The Options Status panel (and compact popup where rate-limit state is shown) SHALL distinguish a global Raindrop rate-limit pause (`rateLimitedUntil` / skip reason `rate_limited`) from a prior wake that stopped only because the soft wake cap or bootstrap budget was exhausted. Self-cap copy SHALL NOT claim the Raindrop API rate limit was exhausted. When `rateLimitedUntil` is active, rate-limit copy remains authoritative over any stale self-cap note.

#### Scenario: Self-cap note visible without rate-limit banner
- **WHEN** Status refreshes after a wake stopped for wake cap or bootstrap
- **AND** `rateLimitedUntil` is not active
- **THEN** Status indicates a self/wake budget stop (or equivalent)
- **AND** does not present it as a Raindrop rate-limit pause

#### Scenario: Active rate limit overrides self-cap note
- **WHEN** `rateLimitedUntil` is in the future
- **THEN** Status shows the rate-limit pause
- **AND** does not prefer self-cap wording over the pause

## MODIFIED Requirements

### Requirement: Status surfaces reconcile deferral reasons
When bidirectional mode is on, the Options Status panel SHALL surface durable heartbeat reconcile-skip reasons (`busy`, `cooldown`, `rate_limited`, `bulk_pause`) with distinct user-visible copy so a deferred Raindrop check does not look like a stuck or idle install. When reason is `bulk_pause`, copy SHALL point at Match or Continue drip on the bulk-queue notice. When reason is `busy` or `cooldown`, copy MAY mention Pull now. When reason is `rate_limited`, copy SHALL refer to a Raindrop rate-limit pause (not a self wake-cap stop). Cooldown copy SHALL describe quiet-time wait after a settled Raindrop check (not unfinished confirm catch-up). Status SHALL NOT keep showing `bulk_pause` after needs_choice has already been cleared (guard or refresh to `busy`/clear). Status SHALL NOT present quiet-time cooldown as the explanation while durable unsettled confirm catch-up is active (catch-up MUST continue on heartbeat instead of arming cooldown).

#### Scenario: Busy deferral visible
- **WHEN** Status refreshes and reconcileSkipReason is `busy`
- **THEN** the Status panel shows that Raindrop check is deferred because the sync queue still has Raindrop work

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
