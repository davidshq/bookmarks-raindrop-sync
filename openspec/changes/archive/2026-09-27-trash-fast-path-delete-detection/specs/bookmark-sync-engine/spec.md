## ADDED Requirements

### Requirement: Trash listing fast path for remote deletes
When sync mode is `bidirectional` and a reconcile cycle reaches finish (scoped listing complete for that cycle), the engine SHALL list raindrops in Raindrop Trash (`collectionId=-99`) and enqueue a Raindrop→Edge delete job for each trash item that still has a pair mapping (subject to existing tombstone, exclude, and offload guards). Trash listing SHALL NOT enqueue pull-create or pull-update jobs. Trash listing SHALL use paginated list requests (not one GET per id) and SHALL honor the global rate-limit pause / proactive budget stop. Capped per-id confirm GETs for raindrops absent from the scoped listing SHALL remain as a fallback for permanent deletes and other cases Trash does not cover; ids already handled via Trash in the same finish pass SHALL NOT require a confirm GET.

#### Scenario: Paired raindrop found in Trash
- **WHEN** bidirectional reconcile finishes a cycle
- **AND** a mapped raindrop id appears in Trash listing
- **THEN** the engine enqueues a `delete-edge` job for that pair
- **AND** does not create or update an Edge bookmark from the trash item

#### Scenario: Unpaired trash item ignored
- **WHEN** Trash listing includes a raindrop with no pair mapping
- **THEN** the engine does not enqueue Edge work for that id

#### Scenario: Trash list respects rate-limit pause
- **WHEN** Trash listing is in progress and Raindrop responses report remaining budget at or below the reserve threshold
- **THEN** the engine stops the current tick and resumes later
- **AND** no false Edge deletes are inferred beyond trash ids already observed that tick

#### Scenario: Confirm GET fallback still covers permanent deletes
- **WHEN** a mapped raindrop is permanently gone (not in Trash and not in the scoped listing)
- **THEN** the existing capped confirm-GET path may still detect absence and enqueue `delete-edge`
- **AND** Trash listing alone is not required to have observed that id
