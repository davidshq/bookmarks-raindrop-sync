## ADDED Requirements

### Requirement: Detect bulk queue depth
The extension SHALL evaluate the durable sync queue size against a configured pending threshold (default at least 150). When the size is at or above the threshold and the user is not in an active snooze for that backlog, the engine SHALL set a durable bulk-prompt state indicating that user choice is needed.

#### Scenario: Queue crosses threshold
- **WHEN** the durable queue size reaches or exceeds the pending threshold
- **AND** no snooze is active for the current backlog
- **THEN** durable state records that a bulk backlog choice is needed

#### Scenario: Below threshold clears arming
- **WHEN** the durable queue size falls below half the pending threshold (or the documented clear watermark)
- **THEN** the engine may clear snooze/arming so a future spike can prompt again

### Requirement: Pause Raindrop drain while awaiting choice
While durable state indicates a bulk backlog choice is needed, the engine SHALL NOT process Raindrop-bound drain jobs. Live bookmark events MAY still enqueue jobs. The activity log SHALL record that drain is paused pending user choice (coalesced, not once per heartbeat spam).

#### Scenario: Drain skipped
- **WHEN** bulk-prompt state is needs_choice
- **AND** the heartbeat would drain the queue
- **THEN** drain does not complete Raindrop API jobs until the user resolves the prompt

#### Scenario: Continue drip resumes drain
- **WHEN** the user chooses to continue dripping
- **THEN** needs_choice is cleared (with snooze as designed)
- **AND** subsequent heartbeats drain normally

### Requirement: Match from queue prompt
The user SHALL be able to run Match existing from export from the bulk-queue prompt. After Match completes successfully (including zero new pairs), the engine SHALL clear needs_choice appropriately and resume drain unless the user cancelled Match without choosing continue.

#### Scenario: Match then resume
- **WHEN** the user chooses Match from the queue prompt and Apply finishes
- **THEN** unambiguous pairs are recorded per export-bulk-sync
- **AND** drain is allowed to proceed afterward

### Requirement: Follow-on bulk file transfer out of scope
This capability SHALL NOT require implementing Edge↔Raindrop file-based bulk transfer. Documentation MAY describe file bulk transfer as a future enhancement.

#### Scenario: v1 ships without file bulk
- **WHEN** this change is implemented
- **THEN** users can Match or continue drip from the queue prompt without a file-import path
