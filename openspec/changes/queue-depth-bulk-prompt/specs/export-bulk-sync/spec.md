## ADDED Requirements

### Requirement: Match existing invokable from queue bulk prompt
Match existing from Raindrop export SHALL be runnable as the remediation action from the queue-depth bulk prompt, using the same record-pairs-only semantics as Manual Sync / Import gates (no deletes, moves, or raindrop creates).

#### Scenario: Queue prompt triggers Match
- **WHEN** the user chooses Match from the Status bulk-queue notice
- **THEN** Match existing runs with the same pair-recording rules as the export-bulk-sync Match flow
