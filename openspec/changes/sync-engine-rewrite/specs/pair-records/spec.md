## ADDED Requirements

### Requirement: Pair is a record keyed by raindrop id
The engine SHALL persist each Edge↔Raindrop pair as a record keyed by raindrop id with fields `bookmarkId`, `urlKey` (first `urlMatchKeys(url)` at last sync), `url`, `collectionId`, `edgeParentId`, `edgePathAtSync`, `title`, `lastSeenEdgeAt`, `lastSeenRaindropAt`. The `bookmarkId → raindropId` and `urlKey → raindropId[]` indexes SHALL be derived from the records on load and after every mutation and MUST NOT be the persisted source of truth. Existing read helpers (`getRaindropId`, `getBookmarkIdForRaindrop`, `hasSynced`) SHALL keep their signatures and read the derived indexes.

#### Scenario: Record written on sync
- **WHEN** an upload or pull-create records a pair for a bookmark node
- **THEN** the stored record carries the node's url, urlKey, title, parent id and mirror path, the raindrop's collection id, and both last-seen timestamps

#### Scenario: Indexes rebuilt after mutation
- **WHEN** a record is added, rebound, or removed
- **THEN** `getRaindropId(bookmarkId)` and the urlKey index reflect the change on the next read without a separate index write

### Requirement: Stale Edge id rebinds by URL, never deletes
When a pair's `bookmarkId` is not present in the Edge tree, the engine SHALL search the tree for the record's `urlKey`, preferring a URL bookmark under `edgePathAtSync`, then any URL bookmark under the mirror root, excluding bookmarks already bound to another live pair. On a match it SHALL update `bookmarkId`, `edgeParentId`, `edgePathAtSync` and `lastSeenEdgeAt`, and log `Rebound: <title> (Edge id changed)`. A stale Edge id alone SHALL NOT enqueue any delete.

#### Scenario: Renumbered id rebinds under the same path
- **WHEN** Chromium reassigns bookmark ids and a pair's bookmark id is gone
- **AND** a bookmark with the same urlKey exists under the record's `edgePathAtSync`
- **THEN** the record rebinds to that bookmark id
- **AND** no `delete-raindrop` job is enqueued

#### Scenario: URL moved elsewhere in the mirror rebinds
- **WHEN** a pair's bookmark id is gone and no match exists under `edgePathAtSync`
- **AND** one bookmark with the same urlKey exists elsewhere under the mirror root
- **THEN** the record rebinds to it and updates placement fields

#### Scenario: Bound elsewhere is not claimed
- **WHEN** the only URL match in the tree is already bound to a different live pair
- **THEN** the stale record is not rebound to it
- **AND** the record remains a stale-Edge-id pair reported by pair health

### Requirement: Stale Raindrop id rebinds by URL, never deletes
When a pair's `raindropId` is absent from a complete presence snapshot, the engine SHALL look up the record's `urlKey` in the snapshot. If one or more other raindrops carry the URL, it SHALL rebind to the oldest id not bound to another live pair (the `pickMoveRebindCandidate` rule), re-key the record, and log the rebind. Only when no raindrop carries the URL is the pair a candidate for Raindrop-side-gone handling under delete-evidence.

#### Scenario: Trashed duplicate does not delete the original
- **WHEN** a pair points at a raindrop id that was trashed
- **AND** the snapshot shows another live raindrop with the same URL
- **THEN** the record rebinds to the surviving id
- **AND** the paired Edge bookmark is not removed

#### Scenario: No survivor becomes a candidate only
- **WHEN** a pair's raindrop id is absent from a complete snapshot and no raindrop carries its URL
- **THEN** the pair is handed to delete-evidence as a candidate
- **AND** no delete is enqueued by the rebind pass itself

### Requirement: One-time pair migration drops ghosts
On first load of a legacy id-pair map, the engine SHALL build records from the live Edge tree and a presence snapshot under the pair lock, applying the stale-id rebind rules to pairs whose bookmark id or raindrop id is missing. Pairs that cannot be resolved on either side SHALL be dropped and counted in a single log line. The legacy map SHALL be retained under a backup key until the next completed reconcile finish. If the snapshot cannot be fetched, migration SHALL complete from the tree only, set `migrationPartial`, and deletes SHALL be blocked until a later wake completes the Raindrop side.

#### Scenario: Legacy pair with both sides alive
- **WHEN** a legacy `(bookmarkId, raindropId)` entry has a live node and a raindrop id present in the snapshot
- **THEN** a record is created with url fields from the node and no log noise

#### Scenario: Legacy pair unresolved on both sides
- **WHEN** a legacy entry's bookmark id is not in the tree and its raindrop id is not in the snapshot
- **AND** no rebind by URL is possible because the record has no URL
- **THEN** the entry is dropped and included in the migration summary count

#### Scenario: Export unavailable at migration
- **WHEN** migration runs and the export fetch fails
- **THEN** records are built from the tree, `migrationPartial` is set, and no delete job executes until a complete snapshot is obtained
