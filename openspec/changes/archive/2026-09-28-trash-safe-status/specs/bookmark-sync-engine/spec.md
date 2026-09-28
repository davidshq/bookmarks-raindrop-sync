## ADDED Requirements

### Requirement: Trash listing updates trash hygiene snapshot
When sync mode is `bidirectional` and the engine lists Raindrop Trash for delete detection (reconcile finish or an explicit Check Trash peek), it SHALL persist a durable trash hygiene snapshot after that pass: whether the Trash scan completed within page and wake-budget caps, the count of paired trash ids still needing enroll at peek time, and the peek timestamp. A paired id needs enroll when it has a pair mapping, is not already tombstoned, and does not already have a queued `delete-edge` (or equivalent in-flight enroll) for that raindrop. Unpaired trash ids SHALL NOT increase the pending count. When the pass stops early because of the Trash page cap or exhausted wake budget before the last Trash page, the snapshot SHALL record the scan as incomplete. The snapshot SHALL NOT claim completeness solely because zero paired ids were seen on a truncated prefix of Trash.

#### Scenario: Complete scan with no paired pending
- **WHEN** a Trash list pass reaches the end of Trash within caps
- **AND** every paired trash id was already tombstoned or already had `delete-edge` queued (or none were paired)
- **THEN** the snapshot records scan complete and paired-pending 0

#### Scenario: Paired trash still needing enroll
- **WHEN** a Trash list pass observes a paired raindrop in Trash that is not tombstoned and has no queued `delete-edge`
- **THEN** the snapshot’s paired-pending count includes that id
- **AND** the engine still enqueues `delete-edge` per the trash fast path

#### Scenario: Truncated peek marked incomplete
- **WHEN** a Trash list pass stops because the Trash page cap or wake budget is exhausted before the last page
- **THEN** the snapshot records scan incomplete
- **AND** MUST NOT be treated as safe-to-empty by Status solely from that peek

#### Scenario: Check Trash uses same snapshot writer
- **WHEN** an explicit Check Trash peek lists Trash
- **THEN** it updates the same durable trash hygiene snapshot fields as reconcile finish
