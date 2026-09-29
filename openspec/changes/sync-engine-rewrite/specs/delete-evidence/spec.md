## ADDED Requirements

### Requirement: Deletes require a positive signal and a failed survival check
A delete in either direction SHALL execute only when a positive signal exists for that pair and the record's URL does not survive elsewhere on the source side. Absence of a paired counterpart, including a per-id GET that returns 404, SHALL NOT by itself be a positive signal. The survival check SHALL be repeated at job execution time against current state, not only at enqueue time.

#### Scenario: 404 alone is not evidence
- **WHEN** a raindrop id is missing but the snapshot is not complete
- **THEN** no `delete-edge` job is enqueued for that pair

#### Scenario: Survival check at execution
- **WHEN** a `delete-edge` job was enqueued and the URL reappears in the snapshot under another id before drain
- **THEN** drain rebinds the pair to the surviving id and drops the job without removing the Edge bookmark

### Requirement: Raindrop to Edge evidence
The positive signal for Raindrop→Edge SHALL be either the raindrop id appearing in a Trash listing or the raindrop id being absent from a complete presence snapshot. Before enqueue and again at execution, the engine SHALL look up the record's urlKey in the snapshot; if any other live raindrop carries the URL, it SHALL rebind instead of deleting. Only when no raindrop carries the URL SHALL it enqueue `delete-edge`, then remove the Edge bookmark, record a tombstone, and remove the record. The `presenceDeletesEnabled` config flag SHALL, when false, disable the absence signal while keeping the Trash signal.

#### Scenario: Trashed with no survivor
- **WHEN** a paired raindrop appears in Trash and no other raindrop carries its URL
- **THEN** `delete-edge` is enqueued and the Edge bookmark is removed on drain

#### Scenario: Absent from complete snapshot with no survivor
- **WHEN** a paired raindrop id is absent from a complete snapshot and no other raindrop carries its URL
- **THEN** `delete-edge` is enqueued

#### Scenario: Absent but URL survives
- **WHEN** a paired raindrop id is absent from a complete snapshot
- **AND** another live raindrop carries the same urlKey
- **THEN** the pair rebinds to the survivor and no delete is enqueued

#### Scenario: Presence deletes disabled
- **WHEN** `presenceDeletesEnabled` is false
- **THEN** absence from the snapshot never enqueues `delete-edge`
- **AND** Trash-listed pairs still do

### Requirement: Edge to Raindrop evidence
The positive signal for Edge→Raindrop SHALL be a `chrome.bookmarks.onRemoved` event carrying a node payload (or a folder payload walked to URL nodes) for a paired bookmark, recorded in a durable `edgeRemoved` ledger as `{ urlKey, url, title, at, bookmarkId }`. At execution the engine SHALL search the synced scope for the record's urlKey, where synced scope is the mirror root plus the outside-root landing zone when an outside-root allowlist is active; folders outside that scope SHALL NOT count as survivors. If a copy survives, the removal SHALL be treated as a duplicate: the pair record rebinds to the surviving copy, the ledger entry is removed, and the job is dropped without a Raindrop delete. If no copy survives, the raindrop SHALL be deleted, a tombstone recorded, and the record and ledger entry removed. Ledger entries older than 7 days SHALL be pruned. An `onRemoved` without a node payload SHALL NOT enqueue a delete.

#### Scenario: Removed with payload and no survivor
- **WHEN** the user deletes a paired bookmark and `onRemoved` supplies its node
- **AND** no other bookmark in the synced scope has the same urlKey
- **THEN** the raindrop is deleted and a tombstone recorded

#### Scenario: Duplicate copy removed
- **WHEN** the user deletes one of two Edge bookmarks with the same URL and the removed one is the paired copy
- **THEN** the record rebinds to the remaining copy
- **AND** the raindrop is not deleted

#### Scenario: Copy in an unsynced folder is not a survivor
- **WHEN** the user deletes the paired copy and the only other bookmark with that URL lives outside the mirror and outside any active outside-root landing
- **THEN** the raindrop is deleted and a tombstone recorded

#### Scenario: Copy in the outside-root landing is a survivor
- **WHEN** an outside-root allowlist is active and the only other bookmark with that URL lives under the outside-root landing zone
- **THEN** the record rebinds to that copy and the raindrop is not deleted

#### Scenario: Removed without payload
- **WHEN** `onRemoved` fires without a node payload for a paired bookmark id
- **THEN** no `delete-raindrop` job is enqueued
- **AND** the pair remains for the stale-Edge-id rebind pass

### Requirement: Migration and incomplete state block deletes
While `migrationPartial` is set or no complete snapshot exists, absence-based deletes SHALL NOT execute. Trash-signal and ledger-signal deletes SHALL still require their survival checks and SHALL run.

#### Scenario: Partial migration holds absence deletes
- **WHEN** migration completed from the tree only
- **THEN** reconcile finish enqueues no absence-based `delete-edge` until a complete snapshot is obtained
