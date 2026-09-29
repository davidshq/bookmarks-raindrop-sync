## ADDED Requirements

### Requirement: Raindrop export is the presence oracle
The engine SHALL obtain Raindrop presence from `GET /raindrops/0/export.csv` and hold a snapshot `{ at, ids, byUrlKey, complete }` in worker memory with a durable `{ at, ids }` form for service-worker restarts. `complete` SHALL be true only when the CSV parsed without error and its row count is at least half of the previous complete snapshot's row count. Delete detection, tombstone prune, stale-id rebind, and create reclaim SHALL consult the snapshot and MUST NOT issue per-id `GET /raindrop/{id}` requests to establish presence.

#### Scenario: Snapshot built from export
- **WHEN** the engine refreshes presence
- **THEN** one export request runs, the id set and urlKey index are rebuilt, and `at` is set to the fetch time

#### Scenario: Malformed export is not complete
- **WHEN** the export body fails to parse or shrinks below half of the previous complete snapshot
- **THEN** the snapshot is stored with `complete: false`
- **AND** no absence-based delete uses it

#### Scenario: Worker restart restores ids
- **WHEN** the service worker restarts within the staleness window
- **THEN** the durable id set is loaded and treated as the current snapshot without a new export request

### Requirement: Refresh cadence
The engine SHALL refresh the snapshot on a heartbeat when its age is at least the configured reconcile interval and the wake has spendable for one request; on demand (reclaim, survival check, Repair, migration) when its age is at least `PRESENCE_STALE_MS` (a fixed constant, 10 minutes, independent of the reconcile interval setting); and always on Pull now. A snapshot older than `PRESENCE_MAX_AGE_MS` SHALL be treated as not complete for delete decisions. The export request SHALL count against the per-wake spendable budget.

#### Scenario: Fresh snapshot reused on demand
- **WHEN** an upload needs presence and the snapshot is younger than `PRESENCE_STALE_MS`
- **THEN** no export request is made and the existing snapshot answers

#### Scenario: Aged-out snapshot blocks deletes
- **WHEN** the snapshot is older than `PRESENCE_MAX_AGE_MS` and cannot be refreshed this wake
- **THEN** absence-based delete candidates are not enqueued
- **AND** Trash-listed candidates still are

#### Scenario: Pull now refreshes
- **WHEN** the user triggers Pull now
- **THEN** the snapshot is refreshed before delete detection runs

### Requirement: Placement still comes from nested listing
The snapshot SHALL NOT be used to infer collection placement. Placement drift detection SHALL continue to use the nested collection listing.

#### Scenario: Collection move detected by listing
- **WHEN** a raindrop moves to another collection and the snapshot is fresh
- **THEN** the pull-update for the move is produced by the nested listing, not the snapshot
