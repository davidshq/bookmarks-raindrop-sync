## ADDED Requirements

### Requirement: Queue-depth bulk prompt arming
After enqueue or drain-related queue size changes, the sync engine SHALL arm durable bulk-prompt state when pending jobs are at or above the queue bulk threshold and snooze does not apply. Arming SHALL NOT require the user to trigger Import or Pull.

#### Scenario: Live create storm arms prompt
- **WHEN** many bookmarks are created in the browser and queued for upload
- **AND** pending reaches the queue bulk threshold
- **THEN** bulk-prompt needs_choice is set without an Import click

### Requirement: Drain respects bulk-prompt pause
The drain loop SHALL check bulk-prompt state and SHALL skip processing Raindrop-bound jobs while needs_choice is set.

#### Scenario: Heartbeat drain no-ops while waiting
- **WHEN** needs_choice is set
- **AND** drain runs
- **THEN** no upload/pull/delete Raindrop calls are made from that drain pass due to the pause
