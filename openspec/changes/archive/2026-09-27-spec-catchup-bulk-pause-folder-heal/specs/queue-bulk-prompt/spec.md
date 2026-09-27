## MODIFIED Requirements

### Requirement: Detect bulk queue depth
The extension SHALL evaluate the durable sync queue size against a configured pending threshold defaulting to **150**. When the size is at or above the threshold and the user is not in an active snooze for that backlog, the engine SHALL set a durable bulk-prompt state indicating that user choice is needed. The clear watermark SHALL default to **half** the pending threshold (75 when threshold is 150).

#### Scenario: Queue crosses threshold
- **WHEN** the durable queue size reaches or exceeds 150
- **AND** no snooze is active for the current backlog
- **THEN** durable state records that a bulk backlog choice is needed

#### Scenario: Below threshold clears arming
- **WHEN** the durable queue size falls below half the pending threshold (75 at the default)
- **THEN** the engine may clear snooze/arming so a future spike can prompt again

### Requirement: Pause Raindrop drain while awaiting choice
While durable state indicates a bulk backlog choice is needed, the engine SHALL NOT process Raindrop-bound drain jobs and SHALL NOT run heartbeat Raindrop reconcile listing (skip reason `bulk_pause`). Live bookmark events MAY still enqueue jobs. The activity log SHALL record that drain is paused pending user choice (coalesced, not once per heartbeat spam).

#### Scenario: Drain skipped
- **WHEN** bulk-prompt state is needs_choice
- **AND** the heartbeat would drain the queue
- **THEN** drain does not complete Raindrop API jobs until the user resolves the prompt

#### Scenario: Reconcile skipped with bulk_pause
- **WHEN** bulk-prompt state is needs_choice
- **AND** the heartbeat would reconcile
- **THEN** reconcile listing does not run that tick
- **AND** status records reason `bulk_pause`

#### Scenario: Continue drip resumes drain
- **WHEN** the user chooses to continue dripping
- **THEN** needs_choice is cleared (with snooze as designed)
- **AND** subsequent heartbeats drain normally

### Requirement: Match from queue prompt
The user SHALL be able to run Match existing from export from the bulk-queue prompt. After Match completes successfully (including zero new pairs), the engine SHALL clear needs_choice appropriately and resume drain unless the user cancelled Match without choosing continue. After Match apply or Continue drip clears needs_choice, the engine SHALL refresh durable reconcile-skip state: if Raindrop-bound jobs remain, set reason `busy`; otherwise clear the skip so Status does not keep showing `bulk_pause`.

#### Scenario: Match then resume
- **WHEN** the user chooses Match from the queue prompt and Apply finishes
- **THEN** unambiguous pairs are recorded per export-bulk-sync
- **AND** drain is allowed to proceed afterward

#### Scenario: Stale bulk_pause cleared after Continue
- **WHEN** the user chooses Continue drip
- **AND** the durable queue still has Raindrop-bound jobs
- **THEN** needs_choice is cleared per snooze rules
- **AND** reconcile-skip reason becomes `busy` (not left as `bulk_pause`)

#### Scenario: Skip cleared when queue quiet after Match
- **WHEN** the user finishes Match from the queue prompt
- **AND** no Raindrop-bound jobs remain
- **THEN** reconcile-skip reason is cleared
