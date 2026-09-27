## ADDED Requirements

### Requirement: Unpaired move rebinds existing raindrop by URL
When an upload job with move reason is drained for an unpaired Edge URL bookmark under a non-exclude policy, before creating a raindrop the engine SHALL search Raindrop for existing items matching the bookmark URL (using the same stable URL match keys as Match existing). When exactly one matching raindrop is claimable (or a stale reverse pair may be rebound), the engine SHALL record the pair and update that raindrop's Edge-owned fields including collection placement so the bookmark relocates to the new path. When multiple matching raindrops are claimable, the engine SHALL claim one (preferring the oldest by raindrop id), update placement, SHALL NOT create an additional raindrop, and SHALL log that extra copies remain. When no match exists, the engine SHALL create as for a first-time upload. When every match conflicts with a pair owned by a different live Edge bookmark, the engine SHALL NOT create a raindrop and SHALL drop the job after logging the conflict.

#### Scenario: Unpaired move relocates existing raindrop
- **WHEN** an unpaired Edge bookmark is drained after a parent-folder change
- **AND** Raindrop already has exactly one claimable raindrop for that URL
- **THEN** the engine records the bookmark id ↔ raindrop id pair
- **AND** updates that raindrop's collection to the destination path
- **AND** does not create a new raindrop

#### Scenario: Unpaired move with no Raindrop URL match creates
- **WHEN** an unpaired Edge bookmark is drained after a parent-folder change
- **AND** no Raindrop item matches the URL
- **THEN** a new raindrop is created in the destination collection
- **AND** the pair mapping is persisted

#### Scenario: Unpaired move with multiple URL matches does not create
- **WHEN** an unpaired Edge bookmark is drained after a parent-folder change
- **AND** Raindrop has more than one claimable raindrop for that URL
- **THEN** one raindrop is updated into the destination collection
- **AND** no additional raindrop is created
- **AND** Recent activity notes that extra copies remain

#### Scenario: Unpaired move conflict skips create
- **WHEN** an unpaired Edge bookmark is drained after a parent-folder change
- **AND** every URL match is already paired to a different live Edge bookmark
- **THEN** no raindrop is created
- **AND** the job is dropped without relocating a contested raindrop

## MODIFIED Requirements

### Requirement: Paired bookmark drain updates Edge-owned Raindrop fields
When an upload job is drained for a bookmark that already has a pair mapping, the engine SHALL resolve the bookmark's current Edge folder path to a Raindrop collection (ensure-if-missing under the same rules as create) and update the paired raindrop via a field-selective update of Edge-owned fields (`link`, `title`, and `collection` placement) from the live Edge node. The engine MUST NOT clear or overwrite Raindrop-only fields (tags, notes, highlights, covers, excerpts). When the bookmark is unpaired and the job is **not** a move (or move URL rebind found no claimable match), create behavior SHALL remain as today. While ensuring the path, the engine SHALL persist `edgeFolderId → raindropCollectionId` for folder segments along the bookmark's ancestor chain so later folder renames can resolve the collection without the old title.

#### Scenario: Paired bookmark moved to a new folder
- **WHEN** a paired Edge bookmark's upload job is drained after a parent-folder change
- **THEN** the paired raindrop's collection is updated to match the new Edge path
- **AND** Raindrop tags, notes, highlights, covers, and excerpts remain intact
- **AND** Recent activity records a move/placement update line

#### Scenario: Paired bookmark title or URL edited
- **WHEN** a paired Edge bookmark's upload job is drained after an `onChanged` title and/or URL edit
- **THEN** the paired raindrop's `title` and/or `link` are updated to match the live Edge node
- **AND** Raindrop-only fields remain intact
- **AND** Recent activity records an update line

#### Scenario: Unpaired non-move upload still creates
- **WHEN** an unpaired URL bookmark under a non-exclude policy is drained for a create or title/URL change (not a move rebind hit)
- **THEN** a Raindrop bookmark is created in the path-matching collection
- **AND** the pair mapping is persisted

#### Scenario: Already-correct fields are idempotent
- **WHEN** a paired bookmark is drained and its Raindrop Edge-owned fields already match the live Edge node
- **THEN** the update is still allowed as an idempotent write
- **AND** the job completes without creating a duplicate raindrop
