## ADDED Requirements

### Requirement: Folder maps enable Raindrop→Edge folder renames
When sync mode is `bidirectional`, Raindrop→Edge folder title updates SHALL depend on persisted `edgeFolderId → raindropCollectionId` mappings. The system SHALL learn those maps on pull-create and pull-update, and SHALL heal missing maps on reconcile finish for collections under the sync root that already correspond to Edge folders (as specified by bookmark-sync-engine), so title drift can enqueue in-place Edge folder renames without requiring a full re-pull of every bookmark.

#### Scenario: Healed map unlocks folder rename
- **WHEN** bidirectional mode is on
- **AND** a Raindrop collection title under the root differs from its mirrored Edge folder
- **AND** reconcile finish has recorded a folder→collection map for that pair (including via heal)
- **THEN** a `pull-rename-folder` job may be enqueued
- **AND** drain renames the Edge folder in place without echoing an Edge→Raindrop rename

#### Scenario: Unmapped folder without heal candidate stays put
- **WHEN** no safe heal candidate exists for a Raindrop collection
- **AND** no folder map is present
- **THEN** reconcile does not rename an arbitrary Edge folder to match that collection title
