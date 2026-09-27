## MODIFIED Requirements

### Requirement: User delete propagates Raindrop to Edge
When sync mode is `bidirectional` and reconcile detects that a mapped raindrop was soft-deleted (present in Raindrop Trash) or otherwise no longer exists as a living item under the sync scope, the system SHALL remove the paired Edge bookmark, record a tombstone, and clear the pair. Soft-deletes SHALL be discoverable primarily by listing Trash (`collectionId=-99`) on reconcile finish; absence confirmed by capped per-id GET (or equivalent presence check) remains the fallback for permanent deletes.

#### Scenario: Raindrop soft-deleted remotely (Trash)
- **WHEN** bidirectional mode is on
- **AND** a previously mapped raindrop appears in Raindrop Trash during reconcile finish
- **THEN** the paired Edge bookmark is removed
- **AND** a tombstone is recorded
- **AND** the pair mapping is removed

#### Scenario: Raindrop deleted remotely
- **WHEN** bidirectional mode is on and a previously mapped raindrop is absent from Raindrop during reconcile
- **THEN** the paired Edge bookmark is removed
- **AND** a tombstone is recorded
- **AND** the pair mapping is removed
