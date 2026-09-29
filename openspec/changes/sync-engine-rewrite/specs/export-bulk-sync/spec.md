## MODIFIED Requirements

### Requirement: Bulk lane uses Raindrop export as a snapshot oracle
The extension SHALL fetch Raindrop `export.csv` (collection `0` = all except Trash) to obtain raindrop id and url presence, and SHALL share that snapshot between the bulk Match lane and the engine's presence-snapshot capability. The export SHALL be treated as lacking collection path and MUST NOT be used to claim folder placement.

#### Scenario: Export fetch for Match
- **WHEN** the user proceeds with Match existing from Raindrop export
- **THEN** the extension refreshes the presence snapshot with one export request
- **AND** builds a URL→raindropId index from the CSV id and url columns

#### Scenario: Heartbeat refreshes presence on cadence
- **WHEN** the extension runs its normal heartbeat reconcile
- **AND** the presence snapshot is at least the reconcile interval old
- **THEN** it refreshes the snapshot with one export request, and otherwise reuses the existing snapshot
