## MODIFIED Requirements

### Requirement: Guided bulk Match on Import and Pull
When the user triggers Import to Raindrop or Pull now from **Options Manual Sync** and bulk-candidate heuristics fire, the Options UI SHALL prompt to Match from Raindrop export first, continue without matching, or cancel, then optionally dry-run and record pairs before continuing the live operation. Status for Match SHALL be shown separately from Import and Pull status lines. The compact action popup is not required to run this guided gate (see export-bulk-sync Options-scoped gate).

#### Scenario: Import interrupt
- **WHEN** the user clicks Import to Raindrop on Options Manual Sync and heuristics mark a bulk candidate
- **THEN** the UI asks before enqueueing Import
- **AND** choosing Match first runs the Match flow before Import

#### Scenario: Pull interrupt
- **WHEN** sync mode is bidirectional, the user clicks Pull now on Options Manual Sync, and heuristics mark a bulk candidate
- **THEN** the UI asks before starting Pull
- **AND** choosing Match first runs the Match flow before Pull

## ADDED Requirements

### Requirement: Status surfaces reconcile deferral reasons
When bidirectional mode is on, the Options Status panel SHALL surface durable heartbeat reconcile-skip reasons (`busy`, `cooldown`, `rate_limited`, `bulk_pause`) with distinct user-visible copy so a deferred Raindrop check does not look like a stuck or idle install. When reason is `bulk_pause`, copy SHALL point at Match or Continue drip on the bulk-queue notice. When reason is `busy` or `cooldown`, copy MAY mention Pull now. Status SHALL NOT keep showing `bulk_pause` after needs_choice has already been cleared (guard or refresh to `busy`/clear).

#### Scenario: Busy deferral visible
- **WHEN** Status refreshes and reconcileSkipReason is `busy`
- **THEN** the Status panel shows that Raindrop check is deferred because the sync queue still has Raindrop work

#### Scenario: Bulk pause copy points at banner actions
- **WHEN** Status refreshes and reconcileSkipReason is `bulk_pause`
- **THEN** the Status panel explains Raindrop check is paused awaiting Match or Continue drip

#### Scenario: Stale bulk_pause not shown after Continue
- **WHEN** the user has chosen Continue drip and needs_choice is cleared
- **AND** Status refreshes
- **THEN** the UI does not present `bulk_pause` as the current deferral reason
