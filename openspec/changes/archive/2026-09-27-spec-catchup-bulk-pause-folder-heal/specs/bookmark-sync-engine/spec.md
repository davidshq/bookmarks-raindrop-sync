## ADDED Requirements

### Requirement: Heartbeat reconcile skip reasons include bulk_pause
When sync mode is `bidirectional`, heartbeat reconcile skip reasons SHALL include machine-readable `bulk_pause` in addition to `busy`, `rate_limited`, and `cooldown`. The engine SHALL set `bulk_pause` when durable bulk-prompt state is `needs_choice` and SHALL skip starting or continuing Raindrop listing work on that heartbeat tick (after the drain pause already applies). A user-triggered "Pull now" SHALL NOT be the primary remediation for `bulk_pause`; Match or Continue drip on Status SHALL resolve the prompt.

#### Scenario: Bulk prompt stamps bulk_pause
- **WHEN** bulk-prompt state is `needs_choice`
- **AND** the heartbeat tick runs
- **THEN** the engine does not perform Raindrop reconcile listing that tick
- **AND** durable status records skip reason `bulk_pause`

#### Scenario: Skip reasons remain distinct
- **WHEN** Status refreshes after a deferred Raindrop check
- **THEN** `busy`, `cooldown`, `rate_limited`, and `bulk_pause` remain distinguishable machine-readable reasons
- **AND** the Options UI can surface matching copy for each

### Requirement: Rename jobs drain before path-mutating jobs
The drain loop SHALL process due `rename-collection` and `pull-rename-folder` jobs before due upload and `pull-update` / `pull-create` jobs so a pending child job does not ensure a Raindrop or Edge path under a new folder title before the in-place rename runs.

#### Scenario: Pull-rename before pull-update
- **WHEN** both a `pull-rename-folder` job and a `pull-update` job are due
- **THEN** the rename job is drained first

#### Scenario: Edge folder rename before upload
- **WHEN** both a `rename-collection` job and an upload job are due
- **THEN** the rename-collection job is drained first

### Requirement: Pull and reconcile learn folder→collection maps
The engine SHALL persist `edgeFolderId → raindropCollectionId` when pull-create or pull-update applies under a mirrored Edge folder path, and SHALL on bidirectional reconcile finish attempt to heal missing maps for Raindrop collections under the sync root that already have a corresponding Edge folder (exact mirror path, matching leaf title under the resolved parent, or a single unmapped sibling when the leaf title has drifted). Heal SHALL NOT bind Edge top roots, excluded folders, or the outside-root allowlist landing folder. After maps are present, collection title drift SHALL continue to enqueue `pull-rename-folder` as today.

#### Scenario: Pull-update refreshes folder map
- **WHEN** a `pull-update` job applies under an Edge folder
- **THEN** the engine records or refreshes that folder's `edgeFolderId → raindropCollectionId` mapping when the Raindrop collection id is known

#### Scenario: Finish heals exact path map
- **WHEN** bidirectional reconcile finishes a cycle
- **AND** a Raindrop collection under the root has no folder map
- **AND** the mirrored Edge path already exists
- **THEN** the engine records the folder→collection mapping without requiring a new bookmark pull

#### Scenario: Finish heals single drifted sibling
- **WHEN** the parent mirror path exists
- **AND** exactly one unmapped non-excluded child folder is a plausible match for a Raindrop collection whose title drifted
- **THEN** the engine may record the map and enqueue `pull-rename-folder` when titles differ

## MODIFIED Requirements

### Requirement: Drain respects bulk-prompt pause
The drain loop SHALL check bulk-prompt state and SHALL skip processing Raindrop-bound jobs while needs_choice is set. Heartbeat reconcile SHALL also honor that pause as specified by the `bulk_pause` skip-reason requirement (no Raindrop listing while awaiting Match or Continue).

#### Scenario: Heartbeat drain no-ops while waiting
- **WHEN** needs_choice is set
- **AND** drain runs
- **THEN** no upload/pull/delete Raindrop calls are made from that drain pass due to the pause

#### Scenario: Heartbeat reconcile also pauses
- **WHEN** needs_choice is set
- **AND** the heartbeat would otherwise reconcile
- **THEN** reconcile listing is skipped with reason `bulk_pause`
