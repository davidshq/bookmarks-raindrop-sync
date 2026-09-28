## ADDED Requirements

### Requirement: Status surfaces Raindrop Trash safe-to-empty
When sync mode is `bidirectional`, the Options Status panel SHALL surface a durable trash-hygiene snapshot so the user can tell whether it is safe to empty Raindrop Trash. The panel SHALL distinguish at least: **safe to empty** (last trash peek completed a full Trash scan and found zero paired raindrops still needing enroll), **waiting** (paired items still needing enroll and/or the last peek was incomplete), and **unknown** (no trash peek yet). Safe-to-empty SHALL mean discovery debt only: it SHALL NOT require queued `delete-edge` jobs to have drained. Copy SHALL include when the last peek ran when a snapshot exists. When sync mode is `one-way`, Status SHALL NOT present this trash-safe control as actionable. The toolbar popup SHALL NOT be required to show trash-safe state.

#### Scenario: Safe after complete clear peek
- **WHEN** sync mode is bidirectional
- **AND** the last trash hygiene snapshot has `trashScanComplete` true and `trashPairedPending` 0
- **THEN** Options Status indicates it is safe to empty Raindrop Trash
- **AND** shows the last peek time

#### Scenario: Waiting when paired trash remains
- **WHEN** sync mode is bidirectional
- **AND** the last snapshot reports `trashPairedPending` greater than 0
- **THEN** Options Status indicates Trash sync is still waiting
- **AND** does not claim safe to empty

#### Scenario: Incomplete peek is not safe
- **WHEN** sync mode is bidirectional
- **AND** the last snapshot has `trashScanComplete` false
- **THEN** Options Status does not claim safe to empty
- **AND** indicates the Trash peek was partial or truncated

#### Scenario: Unknown before first peek
- **WHEN** sync mode is bidirectional
- **AND** no trash hygiene snapshot has been recorded
- **THEN** Options Status does not claim safe to empty
- **AND** indicates a Trash check has not run yet

#### Scenario: Hidden in one-way
- **WHEN** sync mode is one-way
- **THEN** Options Status does not present trash-safe as an actionable bidirectional control

### Requirement: Status Check Trash control
When sync mode is `bidirectional`, Options Status SHALL provide a **Check Trash** control that requests a Trash-only hygiene peek (list Raindrop Trash, enroll paired deletes as today, refresh the trash hygiene snapshot) without requiring a full Pull now. The control SHALL respect Raindrop rate-limit pause / wake budget and SHALL surface deferral or failure in Status. When sync mode is `one-way`, the control SHALL be hidden.

#### Scenario: Check Trash refreshes snapshot
- **WHEN** sync mode is bidirectional and the user activates Check Trash
- **AND** Raindrop is not rate-limit paused
- **THEN** the extension runs a Trash peek
- **AND** updates the trash hygiene snapshot
- **AND** Status reflects the new safe / waiting / partial state

#### Scenario: Check Trash deferred on rate limit
- **WHEN** sync mode is bidirectional and the user activates Check Trash
- **AND** Raindrop rate-limit pause is active
- **THEN** Status indicates the check was deferred or paused
- **AND** does not invent a false safe-to-empty result
