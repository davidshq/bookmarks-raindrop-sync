## MODIFIED Requirements

### Requirement: Reconcile slices share per-wake spendable budget
When sync mode is `bidirectional`, Raindrop listing pages, Trash listing pages, and missing-raindrop confirm GETs on a heartbeat or Pull-now wake SHALL consume the same per-wake header-driven spendable budget and soft wake cap as drain work on that wake (as specified by bookmark-sync-engine). The engine SHALL prefer completing due drain work before starting large list/confirm slices when both compete for the same wake budget, and SHALL still allow Trash peek and list/confirm progress when spendable remains after drain even if Raindrop-bound queue jobs remain. Confirm GETs SHALL NOT be primarily limited to a fixed historical count of 8 when spendable and wake cap remain.

#### Scenario: Confirm GETs follow spendable not magic eight
- **WHEN** bidirectional reconcile finish has many unparked missing-raindrop candidates
- **AND** the wake still has spendable remaining above reserve and is under the soft wake cap
- **THEN** the engine may run more than eight confirm GETs that wake subject to spendable and the soft confirm backstop
- **AND** it stops confirms when spendable or the wake cap is exhausted without inferring false Edge deletes for unchecked candidates

#### Scenario: Trash and confirms stop on wake budget
- **WHEN** Trash listing or confirm GETs are in progress on a budgeted wake
- **AND** spendable or the soft wake cap is exhausted while remaining is still above reserve
- **THEN** the engine stops the current tick and resumes on a later wake
- **AND** does not set a Raindrop `rateLimitedUntil` pause solely for that self-cap stop

#### Scenario: Settled quiet cooldown still avoids burning quota
- **WHEN** the last reconcile finish was settled and quiet-time cooldown applies
- **AND** the durable queue is idle
- **THEN** heartbeat does not start a full nested listing solely to consume leftover spendable

#### Scenario: Leftover spendable funds Trash while queue has work
- **WHEN** the durable queue still contains Raindrop-bound jobs
- **AND** prefer-drain leaves spendable remaining on a heartbeat wake
- **AND** quiet-time cooldown does not apply (interval elapsed or unsettled catch-up)
- **THEN** the engine may run Trash listing and/or list/confirm slices on that leftover budget
- **AND** does not skip solely with reason `busy` for queue contention
