## MODIFIED Requirements

### Requirement: Crash-safe Raindrop and Edge creates
Before calling Raindrop `create` or Edge `bookmarks.create` for an unpaired sync job, the engine SHALL persist an intent marker on that durable job (`createAttemptedAt` for Edge→Raindrop upload, `pullCreateAttemptedAt` for Raindrop→Edge pull-create). Every Edge→Raindrop upload SHALL attempt to reclaim an existing raindrop by stable URL match keys before creating, regardless of job reason or marker: first from the presence snapshot, then via one Raindrop search when the snapshot is stale and cannot be refreshed within budget. When a claimable raindrop exists per the move-rebind claim rules, the engine SHALL bind to it and update Edge-owned fields and placement, and SHALL NOT create a second copy. Pull-create SHALL continue to reclaim an unpaired Edge bookmark under the resolved parent when `pullCreateAttemptedAt` is set. Move conflict (every match owned by another live bookmark) SHALL still drop a move job without creating; a plain create in conflict SHALL create, since two Edge bookmarks with the same URL map to two raindrops.

#### Scenario: Plain create with existing URL binds
- **WHEN** an upload job for a newly created bookmark has no pair and no marker
- **AND** the snapshot shows a claimable raindrop with the same urlKey
- **THEN** drain records the pair to that raindrop, updates its placement, and does not call Raindrop create

#### Scenario: Upload create interrupted after Raindrop POST
- **WHEN** an upload job has `createAttemptedAt` set and no pair mapping
- **AND** Raindrop already has a claimable item for the bookmark URL
- **THEN** drain records the pair to that raindrop and updates Edge-owned fields
- **AND** does not call Raindrop create again

#### Scenario: Stale snapshot falls back to one search
- **WHEN** the snapshot is older than the staleness threshold and the wake cannot afford an export
- **THEN** drain issues one `searchRaindrops(url)` before deciding to create

#### Scenario: Pull-create interrupted after Edge bookmark create
- **WHEN** a pull-create job has `pullCreateAttemptedAt` set and no pair mapping
- **AND** an unpaired Edge bookmark with a matching URL exists under the resolved parent
- **THEN** drain records the pair to that bookmark
- **AND** does not create another Edge bookmark for that raindrop

### Requirement: Deduplication of already-synced bookmarks
The engine SHALL maintain persisted pair records (see pair-records) and SHALL skip creating a Raindrop bookmark for any bookmark id present in the derived `bookmarkId → raindropId` index, or for any URL that reclaims an existing raindrop.

#### Scenario: Same bookmark drained twice
- **WHEN** a job for a bookmark id already present in the pair index is drained
- **THEN** no new Raindrop bookmark is created
- **AND** the job is treated as already satisfied

#### Scenario: Sync-and-keep bookmark on repeated heartbeat
- **WHEN** a bookmark in a `sync-and-keep` folder remains in Edge and the heartbeat re-encounters it
- **THEN** it is not re-uploaded because its bookmark id is already in the pair index

### Requirement: Trash listing fast path for remote deletes
When sync mode is `bidirectional` and a reconcile cycle reaches finish, the engine SHALL list raindrops in Raindrop Trash (`collectionId=-99`) and treat each trash item that still has a pair record as a Raindrop→Edge delete candidate, subject to the delete-evidence survival check and existing tombstone, exclude, and offload guards. Trash listing SHALL NOT enqueue pull-create or pull-update jobs. Trash listing SHALL use paginated list requests and SHALL honor the global rate-limit pause and proactive budget stop. Permanent deletes not visible in Trash SHALL be detected by absence from a complete presence snapshot, not by per-id confirm GETs.

#### Scenario: Paired raindrop found in Trash
- **WHEN** bidirectional reconcile finishes a cycle
- **AND** a mapped raindrop id appears in Trash listing
- **AND** no other live raindrop carries its URL
- **THEN** the engine enqueues a `delete-edge` job for that pair
- **AND** does not create or update an Edge bookmark from the trash item

#### Scenario: Unpaired trash item ignored
- **WHEN** Trash listing includes a raindrop with no pair record
- **THEN** the engine does not enqueue Edge work for that id

#### Scenario: Trash list respects rate-limit pause
- **WHEN** Trash listing is in progress and Raindrop responses report remaining budget at or below the reserve threshold
- **THEN** the engine stops the current tick and resumes later
- **AND** no false Edge deletes are inferred beyond trash ids already observed that tick

#### Scenario: Permanent delete detected by snapshot
- **WHEN** a mapped raindrop is permanently gone (not in Trash) and absent from a complete snapshot
- **AND** no other live raindrop carries its URL
- **THEN** the engine enqueues `delete-edge` without any per-id GET

### Requirement: Bidirectional pair map and tombstones
The engine SHALL persist bidirectional pair records (see pair-records) and tombstones for confirmed user deletes so reconcile does not resurrect deleted items. Extension-authored creates and policy-driven removes SHALL be suppressible so they do not enqueue opposing sync jobs.

#### Scenario: Tombstone blocks recreate
- **WHEN** a user delete has been confirmed and a tombstone exists for that pair
- **AND** reconcile lists the library
- **THEN** the deleted item is not recreated on the other side from stale presence

#### Scenario: Stale pull-create honors tombstone or pending delete
- **WHEN** a durable `pull-create` job is drained for a raindrop that already has a tombstone
- **OR** a `delete-raindrop` / `delete-edge` job for that raindrop is already queued
- **THEN** the engine drops the pull job without creating an Edge bookmark

#### Scenario: Tombstones for absent raindrops are pruned
- **WHEN** a reconcile cycle completes with a complete presence snapshot
- **AND** a tombstoned raindrop id is absent from that snapshot
- **THEN** that tombstone is removed from storage as a set difference, with no per-id GET
- **AND** tombstones for raindrops present in the snapshot (e.g. offload) are kept

#### Scenario: Extension-authored Edge create is suppressed
- **WHEN** reconcile creates an Edge bookmark from a raindrop
- **THEN** the resulting `onCreated` event does not enqueue a new Raindrop upload for that bookmark
- **AND** suppression is for that bookmark id (an in-flight one-shot URL match covers the event that fires before the id is known)
- **AND** a different bookmark with the same URL is still queued

#### Scenario: Raindrop field drift updates paired Edge bookmark
- **WHEN** bidirectional mode is on and a paired raindrop's title, link, or collection differs from the Edge bookmark
- **THEN** reconcile enqueues a `pull-update` job
- **AND** drain applies the Edge title/URL and/or parent folder to match
- **AND** enqueue and apply use the same pull-update plan (exclude, folder-mode, and allowlist gates)
- **AND** the resulting `onChanged`/`onMoved` events do not echo an Edge→Raindrop upload

#### Scenario: Pull-update placement create honors folder mode and allowlist
- **WHEN** a paired raindrop moves to a collection whose mirrored Edge path does not fully exist
- **AND** `existing-only` (or an active allowlist) would block creating that path for pull-create
- **THEN** drain does not create the missing Edge folders
- **AND** title/URL updates still apply when those fields differ

#### Scenario: Raindrop collection title drift renames mapped Edge folder
- **WHEN** bidirectional mode is on and a mapped Raindrop collection title differs from the Edge folder title
- **THEN** reconcile enqueues a `pull-rename-folder` job
- **AND** drain renames the Edge folder in place
- **AND** Edge top roots and excluded folders are not renamed
- **AND** the resulting `onChanged` does not echo an Edge→Raindrop `rename-collection`

### Requirement: Periodic reconcile trigger
When sync mode is `bidirectional`, the engine SHALL run Raindrop reconciliation on the alarm heartbeat (and when explicitly requested) to discover new raindrops, placement drift, and remotely deleted raindrops under the configured root. The minimum gap between completed heartbeat reconcile cycles SHALL be the user-configured quiet-time interval (default 1 minute). A cycle is complete when the nested listing finished and, if a presence refresh was due, the snapshot was refreshed. Completed cycles SHALL arm quiet-time cooldown. In-progress cursors always continue; manual "Pull now" bypasses the quiet-time interval. Heartbeat starts of a new cycle SHALL also honor traffic-aware deferral defined for this engine.

#### Scenario: Heartbeat reconcile
- **WHEN** bidirectional mode is on and the alarm heartbeat fires
- **AND** the quiet-time interval has elapsed since the last completed finish
- **AND** traffic-aware deferral does not apply
- **THEN** reconcile runs for the configured root tree subject to rate-limit backoff

#### Scenario: Configured quiet-time cooldown after completed finish
- **WHEN** a bidirectional reconcile cycle has completed
- **AND** the heartbeat fires again before the configured quiet-time interval elapses
- **AND** no in-progress cursor remains
- **THEN** the engine skips starting a new Raindrop listing pass with reason `cooldown`
- **AND** a user-triggered "Pull now" still runs immediately (subject to rate-limit pause)

#### Scenario: Interrupted listing resumes without cooldown
- **WHEN** a listing pass stopped on wake budget with a cursor persisted
- **AND** the heartbeat fires again
- **THEN** the engine continues from the cursor regardless of quiet-time cooldown

### Requirement: One-shot backfill of existing bookmarks
The extension SHALL provide a user-triggered backfill that walks the existing bookmark tree, enqueues each URL node per its resolved policy, and drains with rate-limit backoff. Backfill progress SHALL be persisted so the sweep resumes after a worker restart rather than restarting. Backfill SHALL refresh the presence snapshot once before enqueuing so every upload in the batch reclaims from the same snapshot.

#### Scenario: User runs backfill
- **WHEN** the user triggers "Import to Raindrop"
- **THEN** the presence snapshot is refreshed once
- **AND** every existing bookmark whose resolved policy is not `exclude` is enqueued for syncing

#### Scenario: Rate limit encountered during backfill
- **WHEN** the Raindrop API returns HTTP 429 during backfill
- **THEN** the engine sets a global pause until Retry-After / X-RateLimit-Reset
- **AND** defers all due jobs until that time
- **AND** does not drop the affected jobs

#### Scenario: Rate budget runs low before 429
- **WHEN** Raindrop responses report `X-RateLimit-Remaining` at or below the reserve threshold
- **THEN** the engine stops the current drain/reconcile tick and pauses until reset
- **AND** heartbeats skip Raindrop work until the pause ends

#### Scenario: Idle heartbeat does not re-list every minute
- **WHEN** a bidirectional reconcile cycle has completed successfully
- **AND** the heartbeat fires again within the configured reconcile cooldown
- **AND** no in-progress cursor remains
- **THEN** the engine skips starting a new Raindrop listing pass
- **AND** a user-triggered "Pull now" still runs immediately

#### Scenario: Manual reconcile skip reasons are distinct
- **WHEN** reconcile is skipped because another pass is in flight, a rate-limit pause is active, or heartbeat cooldown applies
- **THEN** the result includes a machine-readable `reason` (`busy`, `rate_limited`, or `cooldown`)
- **AND** the Options/popup UI surfaces a matching message instead of always saying "already running"

#### Scenario: Manual reconcile applies the global rate-limit gate
- **WHEN** a user-triggered "Pull now" hits HTTP 429 or a proactive rate-budget pause
- **THEN** the engine sets the same global Raindrop pause used by the heartbeat
- **AND** defers due queue jobs until that pause ends
- **AND** returns a `rate_limited` skip result (including `rateLimitedUntil` when known) to the Options/popup UI
- **AND** the Options/popup Pull now loop waits until that pause ends and continues the same pull (subject to a max wait count) instead of asking the user to click Pull now again

#### Scenario: Worker restarts during backfill
- **WHEN** the service worker restarts partway through a backfill
- **THEN** the sweep resumes from the persisted cursor rather than re-enqueuing already-processed bookmarks

## REMOVED Requirements

### Requirement: Park out-of-scope alive confirm candidates
**Reason**: Parking existed to stop per-id confirm GETs from re-probing living out-of-scope raindrops. Presence now comes from the export snapshot, which lists every live raindrop regardless of collection, so out-of-scope living pairs are simply present and never become delete candidates. No park state is needed.
**Migration**: `parkedAliveIds` and the park/unpark helpers are deleted from reconcile state; the field is dropped on the first load after upgrade. Out-of-scope living pairs keep their Edge bookmark and record exactly as parking did.
