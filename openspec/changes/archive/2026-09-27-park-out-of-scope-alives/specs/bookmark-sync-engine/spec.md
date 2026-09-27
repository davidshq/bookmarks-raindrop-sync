## ADDED Requirements

### Requirement: Park out-of-scope alive confirm candidates
When sync mode is `bidirectional` and a capped delete-confirm GET shows a mapped raindrop is still alive (non-trash) but its collection is outside the scoped listing—not under the sync root and not under an active outside-root allowlist—the engine SHALL park that raindrop id so it is excluded from future missing-raindrop confirm candidates. Parking SHALL keep the Edge bookmark and pair mapping. The engine SHALL unpark a raindrop id when it appears again in a completed scoped listing (`seen` set). Soft-deletes of parked pairs SHALL remain discoverable via Trash listing. Confirm GET SHALL still enqueue `delete-edge` when a non-parked candidate is confirmed absent or trashed.

#### Scenario: Alive outside scope is parked after confirm GET
- **WHEN** reconcile finishes a scoped listing
- **AND** a mapped raindrop is absent from that listing
- **AND** a confirm GET returns a living item whose collection is outside the sync root and outside the active allowlist (or allowlist is empty)
- **THEN** the engine parks that raindrop id
- **AND** does not enqueue `delete-edge` for it
- **AND** subsequent finish passes do not spend confirm-GET budget on that id while it remains parked

#### Scenario: Parked id unparks when listed again
- **WHEN** a parked raindrop id appears in a completed scoped listing
- **THEN** the engine removes it from the parked set
- **AND** it may become a delete-confirm candidate again if absent from a later listing

#### Scenario: Parked soft-delete still via Trash
- **WHEN** a parked raindrop id later appears in Raindrop Trash during reconcile finish
- **THEN** the engine still enqueues `delete-edge` for that pair

#### Scenario: In-scope alive miss is not parked
- **WHEN** a confirm GET returns a living item whose collection is under the sync root or under an active allowlist
- **AND** the id was absent from this cycle's listing
- **THEN** the engine does not park that id
- **AND** does not enqueue `delete-edge` from that alive confirm
