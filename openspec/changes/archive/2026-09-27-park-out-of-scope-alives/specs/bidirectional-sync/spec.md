## ADDED Requirements

### Requirement: Out-of-scope living pairs are not remote deletes
When sync mode is `bidirectional`, a mapped raindrop that remains alive outside the sync scope (not under the configured sync root and not covered by the active outside-root allowlist) SHALL NOT be treated as a remote delete solely because it is absent from the scoped listing. After confirm GET establishes that out-of-scope living state, the system SHALL stop repeatedly treating that id as a missing-raindrop delete candidate while keeping the Edge bookmark and pair until Trash or a later absence confirm for a non-parked candidate applies.

#### Scenario: Cleared allowlist does not delete Edge for living outside-root pair
- **WHEN** a pair was established for a raindrop outside the sync root under an allowlist
- **AND** the allowlist no longer includes that collection
- **AND** the raindrop still exists outside the sync root
- **THEN** reconcile does not remove the Edge bookmark as a remote delete
- **AND** after confirm GET parks the id, quiet-time cycles do not keep re-confirming that same id forever
