## ADDED Requirements

### Requirement: Pair map update from export URL match
The engine SHALL allow the pair map (`bookmarkId ↔ raindropId`) to be updated by Match existing when an Edge bookmark URL unambiguously matches a raindrop id from Raindrop export CSV. Recording SHALL use the same durable pair storage as live sync. Import backfill SHALL continue to skip bookmark ids already present in the pair map, so Match-then-Import does not re-upload matched URLs.

#### Scenario: Recorded pair skips Import enqueue
- **WHEN** Match existing has recorded a pair for bookmark B and raindrop R
- **AND** the user runs Import to Raindrop
- **THEN** bookmark B is not enqueued for upload solely because it lacks a pair

#### Scenario: Conflicting existing pair not overwritten
- **WHEN** bookmark B is already paired to raindrop R1
- **AND** export URL match would associate B with a different raindrop R2
- **THEN** Match existing does not overwrite the existing pair
- **AND** the conflict is counted in the dry-run summary

### Requirement: Bulk candidate assessment for Import
The engine SHALL expose a local assessment of whether an Import would be a bulk candidate (unpaired would-queue count and pair coverage) without calling Raindrop, so the Options UI can prompt before enqueueing.

#### Scenario: Assessment counts unpaired
- **WHEN** bulk-candidate assessment runs for Import
- **THEN** it reports unpaired would-queue count, Edge scanned count, and paired count using the same exclude/already-paired rules as Import enqueue
