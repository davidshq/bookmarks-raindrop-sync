## MODIFIED Requirements

### Requirement: Match from queue prompt
The user SHALL be able to run Match existing from export from the bulk-queue prompt. After Match completes successfully (including zero new pairs), the engine SHALL clear needs_choice appropriately and resume drain unless the user cancelled Match without choosing continue. After Match apply or Continue drip clears needs_choice, the engine SHALL refresh durable reconcile-skip state by clearing a stale `bulk_pause` skip (SHALL NOT stamp reason `busy` solely because Raindrop-bound jobs remain).

#### Scenario: Match then resume
- **WHEN** the user chooses Match from the queue prompt and Apply finishes
- **THEN** unambiguous pairs are recorded per export-bulk-sync
- **AND** drain is allowed to proceed afterward

#### Scenario: Stale bulk_pause cleared after Continue
- **WHEN** the user chooses Continue drip
- **AND** the durable queue still has Raindrop-bound jobs
- **THEN** needs_choice is cleared per snooze rules
- **AND** reconcile-skip reason is cleared (not left as `bulk_pause` and not set to `busy` for queue contention)

#### Scenario: Skip cleared when queue quiet after Match
- **WHEN** the user finishes Match from the queue prompt
- **AND** no Raindrop-bound jobs remain
- **THEN** reconcile-skip reason is cleared
