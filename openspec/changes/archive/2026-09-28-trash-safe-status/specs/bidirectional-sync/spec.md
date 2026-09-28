## ADDED Requirements

### Requirement: Empty Trash only after discovery debt is clear
When sync mode is `bidirectional`, emptying Raindrop Trash before paired soft-deletes have been enrolled removes the primary soft-delete discovery signal. The system SHALL treat “safe to empty Trash” as discovery debt only: a complete Trash scan with zero paired ids still needing enroll. Queued or in-flight `delete-edge` apply work SHALL NOT block safe-to-empty. The product Status surface for this signal is defined by extension-config; this requirement establishes the bidirectional meaning of that signal relative to Trash and delete detection.

#### Scenario: Safe to empty after enroll even if Edge delete pending
- **WHEN** bidirectional mode is on
- **AND** a complete Trash peek finds no paired ids still needing enroll
- **AND** one or more `delete-edge` jobs remain queued from that enroll
- **THEN** safe-to-empty MAY be true
- **AND** emptying Raindrop Trash does not prevent those jobs from completing Edge removal and tombstone recording

#### Scenario: Not safe while paired soft-deletes sit unseen in Trash
- **WHEN** bidirectional mode is on
- **AND** a paired raindrop is soft-deleted into Trash
- **AND** no complete Trash peek has yet enrolled that id
- **THEN** safe-to-empty MUST NOT be true
- **AND** emptying Trash before enrollment forces reliance on the slower confirm-GET fallback for that delete
