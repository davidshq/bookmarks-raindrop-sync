# bookmark-sync-engine Specification

## Purpose

Capture newly created and existing Edge bookmarks and reliably mirror them into Raindrop through a durable, idempotent enqueue-then-drain pipeline that confirms each Raindrop write before applying any policy-driven local action. When bidirectional mode is enabled, the same pipeline also drains pull and delete jobs and runs periodic Raindrop reconciliation.

## Requirements

### Requirement: Live capture of newly created bookmarks
The extension SHALL register a `chrome.bookmarks.onCreated` listener that, for each newly created bookmark with a URL, appends a sync job to a durable queue in `chrome.storage.local`. The listener SHALL NOT perform network or deletion work directly.

#### Scenario: User creates a bookmark
- **WHEN** the user adds a new bookmark in Edge
- **THEN** a sync job referencing that bookmark's node id is appended to the durable queue
- **AND** the drain process is signaled to run

#### Scenario: A folder is created
- **WHEN** the `onCreated` event fires for a node with no URL (a folder)
- **THEN** no sync job is enqueued for the folder itself
- **AND** the folder's collection is created lazily when a bookmark inside it is later synced

### Requirement: Durable enqueue-then-drain pipeline
The extension SHALL persist the sync queue, retry metadata, and in-flight progress in `chrome.storage.local` so that no state is held in service-worker memory across events. A drain step SHALL process queued jobs idempotently and SHALL be triggered both by capture events and by a `chrome.alarms` heartbeat.

#### Scenario: Service worker is terminated mid-drain
- **WHEN** the MV3 service worker is terminated while a job is being processed
- **THEN** the job remains in the durable queue
- **AND** the next drain reprocesses it without duplicating an already-confirmed Raindrop write

#### Scenario: Heartbeat drains with no new activity
- **WHEN** the `chrome.alarms` heartbeat fires and the queue is non-empty
- **THEN** the drain step runs and processes pending jobs even though no new bookmark was created

#### Scenario: Queue is empty
- **WHEN** the drain runs and the queue is empty
- **THEN** it completes without making any Raindrop requests

### Requirement: Confirm-before-act ordering
The engine SHALL create the Raindrop bookmark and persist the `bookmarkId → raindropId` mapping BEFORE performing any policy-driven local action. No local deletion SHALL occur unless the corresponding Raindrop write has been confirmed.

#### Scenario: Raindrop create succeeds
- **WHEN** a job is drained and the Raindrop API confirms the bookmark was created
- **THEN** the `bookmarkId → raindropId` mapping is persisted
- **AND** only then is the resolved policy's local action applied

#### Scenario: Raindrop create fails
- **WHEN** the Raindrop API returns an error for a job
- **THEN** the bookmark is not removed from Edge
- **AND** the job remains queued for retry (or is dead-lettered after the maximum attempt count)

### Requirement: Folder mirroring into nested Raindrop collections
The engine SHALL recreate the browser bookmark folder path of each synced bookmark as nested Raindrop collections under a user-chosen root collection, creating any missing collection (ensure-if-missing) and caching `path → collectionId` in storage. Both Chromium top roots (toolbar and other) SHALL be preserved under the chosen root using **canonical** Raindrop titles `Bookmarks bar` and `Other bookmarks`, regardless of the local browser’s labels for those roots.

#### Scenario: Bookmark in a nested folder
- **WHEN** a bookmark located at `Favorites bar/Work/ProjectA` (Edge) is synced with root collection `Bookmarks`
- **THEN** the collections `Bookmarks`, `Bookmarks/Bookmarks bar`, `Bookmarks/Bookmarks bar/Work`, and `Bookmarks/Bookmarks bar/Work/ProjectA` exist (created if missing)
- **AND** the raindrop is placed in the `Bookmarks/Bookmarks bar/Work/ProjectA` collection

#### Scenario: Collection already exists
- **WHEN** a path's collection has already been resolved and cached
- **THEN** the cached `collectionId` is reused without an additional create or lookup request

#### Scenario: Both Chromium roots preserved under canonical titles
- **WHEN** bookmarks exist under both the local toolbar root and the local other-bookmarks root
- **THEN** they map to `Bookmarks/Bookmarks bar/…` and `Bookmarks/Other bookmarks/…` respectively (for default root name `Bookmarks`)

### Requirement: Deduplication of already-synced bookmarks
The engine SHALL maintain a persisted `bookmarkId → raindropId` map and SHALL skip creating a Raindrop bookmark for any bookmark id already present in the map.

#### Scenario: Same bookmark drained twice
- **WHEN** a job for a bookmark id already present in the pair map is drained
- **THEN** no new Raindrop bookmark is created
- **AND** the job is treated as already satisfied

#### Scenario: Sync-and-keep bookmark on repeated heartbeat
- **WHEN** a bookmark in a `sync-and-keep` folder remains in Edge and the heartbeat re-encounters it
- **THEN** it is not re-uploaded because its bookmark id is already in the pair map

### Requirement: One-shot backfill of existing bookmarks
The extension SHALL provide a user-triggered backfill that walks the existing bookmark tree, enqueues each URL node per its resolved policy, and drains with rate-limit backoff. Backfill progress SHALL be persisted so the sweep resumes after a worker restart rather than restarting.

#### Scenario: User runs backfill
- **WHEN** the user triggers "Import to Raindrop"
- **THEN** every existing bookmark whose resolved policy is not `exclude` is enqueued for syncing

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

#### Scenario: Delete-confirm GETs are capped per tick
- **WHEN** reconcile finishes a listing pass with many paired raindrops absent from the listing
- **THEN** at most a bounded number of `GET /raindrop/{id}` confirms run that tick (shared with tombstone-prune confirms)
- **AND** remaining candidates are left for a later tick (no false Edge deletes)
- **AND** a durable rotating offset ensures deferred candidates are checked on subsequent cycles

#### Scenario: Manual reconcile skip reasons are distinct
- **WHEN** reconcile is skipped because another pass is in flight, a rate-limit pause is active, or heartbeat cooldown applies
- **THEN** the result includes a machine-readable `reason` (`busy`, `rate_limited`, or `cooldown`)
- **AND** the Options/popup UI surfaces a matching message instead of always saying "already running"

#### Scenario: Manual reconcile applies the global rate-limit gate
- **WHEN** a user-triggered "Pull now" hits HTTP 429 or a proactive rate-budget pause
- **THEN** the engine sets the same global Raindrop pause used by the heartbeat
- **AND** defers due queue jobs until that pause ends
- **AND** returns a `rate_limited` skip result to the Options/popup UI

#### Scenario: Worker restarts during backfill
- **WHEN** the service worker restarts partway through a backfill
- **THEN** the sweep resumes from the persisted cursor rather than re-enqueuing already-processed bookmarks

### Requirement: Resilience to transient failures
The engine SHALL retry failed jobs with backoff and SHALL halt local deletions (while keeping jobs queued) when Raindrop authentication fails, surfacing the error to the status view.

#### Scenario: Offline period
- **WHEN** the network is unavailable during a drain
- **THEN** jobs remain queued and are retried on a later heartbeat once connectivity returns

#### Scenario: Invalid or expired token
- **WHEN** the Raindrop API rejects the request due to an invalid or expired token
- **THEN** no bookmarks are deleted from Edge
- **AND** the jobs remain queued
- **AND** the authentication error is shown in the status view

### Requirement: Mode-aware durable jobs for pull and delete
The sync engine SHALL support durable job kinds for bidirectional work (at minimum: Raindrop→Edge create, Edge→Raindrop user-delete, Raindrop→Edge delete) persisted in `chrome.storage.local`, drained idempotently with the same backoff and auth-halt behavior as upload jobs. These jobs SHALL be no-ops when sync mode is `one-way`.

#### Scenario: Pull job survives worker restart
- **WHEN** a Raindrop→Edge ingest job is queued and the service worker is terminated
- **THEN** the job remains in the durable queue
- **AND** the next drain processes it without duplicating an Edge bookmark for an already-recorded pair

#### Scenario: One-way mode ignores bidirectional jobs
- **WHEN** sync mode is `one-way` and a bidirectional job is encountered
- **THEN** the engine does not perform pull or cross-delete side effects for that job

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

### Requirement: Bidirectional pair map and tombstones
The engine SHALL persist bidirectional pair mappings (`bookmarkId ↔ raindropId`) and tombstones for confirmed user deletes so reconcile does not resurrect deleted items. Extension-authored creates and policy-driven removes SHALL be suppressible so they do not enqueue opposing sync jobs.

#### Scenario: Tombstone blocks recreate
- **WHEN** a user delete has been confirmed and a tombstone exists for that pair
- **AND** reconcile lists the library
- **THEN** the deleted item is not recreated on the other side from stale presence

#### Scenario: Stale pull-create honors tombstone or pending delete
- **WHEN** a durable `pull-create` job is drained for a raindrop that already has a tombstone
- **OR** a `delete-raindrop` / `delete-edge` job for that raindrop is already queued
- **THEN** the engine drops the pull job without creating an Edge bookmark

#### Scenario: Tombstones for absent raindrops are pruned
- **WHEN** a reconcile cycle completes
- **AND** a tombstoned raindrop id was not seen in the listing
- **AND** a confirm GET shows the raindrop is absent or trashed
- **THEN** that tombstone is removed from storage
- **AND** tombstones for raindrops still present in the listing (e.g. offload) are kept
- **AND** those confirm GETs share the same per-tick budget as delete-detection confirms

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
When sync mode is `bidirectional`, the engine SHALL run Raindrop reconciliation on the alarm heartbeat (and when explicitly requested) to discover new raindrops and remotely deleted raindrops under the configured root. The minimum gap between *completed* heartbeat reconcile cycles SHALL be the user-configured quiet-time interval (default 15 minutes). In-progress cursors always continue; manual "Pull now" bypasses the quiet-time interval. Heartbeat starts of a new cycle SHALL also honor traffic-aware deferral defined for this engine.

#### Scenario: Heartbeat reconcile
- **WHEN** bidirectional mode is on and the alarm heartbeat fires
- **AND** the quiet-time interval has elapsed
- **AND** traffic-aware deferral does not apply
- **THEN** reconcile runs for the configured root tree subject to rate-limit backoff

#### Scenario: Configured quiet-time cooldown
- **WHEN** a bidirectional reconcile cycle has completed successfully
- **AND** the heartbeat fires again before the configured quiet-time interval elapses
- **AND** no in-progress cursor remains
- **THEN** the engine skips starting a new Raindrop listing pass with reason `cooldown`
- **AND** a user-triggered "Pull now" still runs immediately (subject to rate-limit pause)

### Requirement: Traffic-aware heartbeat reconcile deferral
When sync mode is `bidirectional` and the heartbeat would start a *new* Raindrop reconcile cycle (no in-progress cursor), the engine SHALL skip starting that cycle when the durable queue still contains jobs that perform Raindrop API work. The skip result SHALL use machine-readable reason `busy`. In-progress reconcile cursors SHALL continue on subsequent heartbeats regardless of queue contention. A user-triggered "Pull now" SHALL NOT be deferred for queue contention (it SHALL still honor the global rate-limit pause). Low rate-limit remaining is handled by the existing hard pause (`rateLimitedUntil`), not a separate durable soft-busy snapshot.

#### Scenario: Queue busy defers new listing
- **WHEN** bidirectional mode is on and the quiet-time reconcile interval has elapsed
- **AND** no in-progress reconcile cursor remains
- **AND** the durable queue still contains at least one Raindrop-bound job
- **AND** the heartbeat fires without `force`
- **THEN** the engine skips starting a new Raindrop listing pass
- **AND** the result reason is `busy`

#### Scenario: Quiet install honors configured interval
- **WHEN** bidirectional mode is on and the quiet-time reconcile interval has elapsed
- **AND** no in-progress reconcile cursor remains
- **AND** the durable queue has no Raindrop-bound jobs
- **AND** the heartbeat fires without `force`
- **THEN** the engine starts a Raindrop listing pass for the configured root tree

#### Scenario: In-progress cursor ignores busy gate
- **WHEN** a reconcile cycle is mid-cursor across heartbeats
- **AND** Raindrop-bound jobs are also queued
- **THEN** the engine continues the in-progress listing/finish work on the next heartbeat subject to rate-limit pause

### Requirement: Live capture of Edge bookmark moves
The extension SHALL register a `chrome.bookmarks.onMoved` listener. When a URL bookmark's parent folder changes, the engine SHALL enqueue a durable upload job for that bookmark's id and signal drain. When a folder is moved, the engine SHALL walk the folder's live descendant tree, enqueue an upload job for each URL bookmark, and signal drain once. Same-parent moves (index-only reorders) SHALL NOT enqueue work. Folder nodes themselves SHALL NOT enqueue a job for the folder id.

#### Scenario: User moves a bookmark to another folder
- **WHEN** the user drags a URL bookmark from one Edge folder to another
- **THEN** an upload job for that bookmark's node id is appended to the durable queue
- **AND** the drain process is signaled to run

#### Scenario: User reorders within the same folder
- **WHEN** `onMoved` fires with the same `parentId` as `oldParentId`
- **THEN** no sync job is enqueued

#### Scenario: User moves a folder of bookmarks
- **WHEN** the user moves an Edge folder that contains URL bookmarks (including nested)
- **THEN** each descendant URL bookmark is enqueued for sync
- **AND** no job is enqueued solely for the folder node

#### Scenario: Move listener does not perform network work inline
- **WHEN** `onMoved` fires
- **THEN** the listener only enqueues durable jobs and signals drain
- **AND** it does not call the Raindrop API directly

### Requirement: Live capture of Edge bookmark title and URL changes
The extension SHALL register a `chrome.bookmarks.onChanged` listener. When a URL bookmark's title and/or URL changes, the engine SHALL enqueue a durable upload job for that bookmark's id and signal drain. The listener SHALL NOT perform Raindrop network work inline.

#### Scenario: User renames a bookmark
- **WHEN** the user changes the title of a URL bookmark in Edge
- **THEN** an upload job for that bookmark id is appended to the durable queue
- **AND** the drain process is signaled to run

#### Scenario: User edits a bookmark URL
- **WHEN** the user changes the URL of a bookmark in Edge
- **THEN** an upload job for that bookmark id is appended to the durable queue

### Requirement: Live capture of Edge folder renames
The extension SHALL handle `chrome.bookmarks.onChanged` for folder nodes (no URL). When a folder has a persisted `edgeFolderId → raindropCollectionId` mapping and its effective policy is not `exclude`, the engine SHALL enqueue a durable `rename-collection` (folder-rename) job for that folder id and signal drain. When no mapping exists, the engine SHALL NOT invent a Raindrop collection solely from the rename. Folder rename SHALL NOT enqueue upload jobs for descendant URL bookmarks solely because the folder title changed.

#### Scenario: User renames a previously synced folder
- **WHEN** the user changes the title of an Edge folder that has a folder→collection mapping
- **AND** the folder's effective policy is not `exclude`
- **THEN** a rename-collection job for that folder id is enqueued
- **AND** drain is signaled

#### Scenario: Rename of never-synced folder is a no-op
- **WHEN** the user renames an Edge folder with no folder→collection mapping
- **THEN** no Raindrop collection create or rename is performed for that event

#### Scenario: Rename under exclude is skipped
- **WHEN** the user renames a folder whose effective policy is `exclude`
- **THEN** no rename-collection job is processed against Raindrop (job not enqueued, or drained as a no-op drop)

### Requirement: Paired bookmark drain updates Edge-owned Raindrop fields
When an upload job is drained for a bookmark that already has a pair mapping, the engine SHALL resolve the bookmark's current Edge folder path to a Raindrop collection (ensure-if-missing under the same rules as create) and update the paired raindrop via a field-selective update of Edge-owned fields (`link`, `title`, and `collection` placement) from the live Edge node. The engine MUST NOT clear or overwrite Raindrop-only fields (tags, notes, highlights, covers, excerpts). When the bookmark is unpaired, create behavior SHALL remain as today. While ensuring the path, the engine SHALL persist `edgeFolderId → raindropCollectionId` for folder segments along the bookmark's ancestor chain so later folder renames can resolve the collection without the old title.

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

#### Scenario: Unpaired bookmark after move or change still creates
- **WHEN** an unpaired URL bookmark under a non-exclude policy is drained (including after a move into a syncable folder)
- **THEN** a Raindrop bookmark is created in the path-matching collection
- **AND** the pair mapping is persisted

#### Scenario: Already-correct fields are idempotent
- **WHEN** a paired bookmark is drained and its Raindrop Edge-owned fields already match the live Edge node
- **THEN** the update is still allowed as an idempotent write
- **AND** the job completes without creating a duplicate raindrop

### Requirement: Folder rename drain renames Raindrop collection in place
When a `rename-collection` job is drained, the engine SHALL load the Edge folder node and the persisted collection id for that folder id, then update the Raindrop collection title to the folder's current title via a field-selective collection update. The engine SHALL refresh path→collection cache entries so the old title path does not keep receiving ensures (rewrite prefix keys or drop the stale prefix and allow later ensure to repopulate). The collection id SHALL remain unchanged so existing raindrops do not need reassignment. On Raindrop 404, the engine SHALL clear the stale folder mapping and drop the job without creating a replacement collection from the rename alone.

#### Scenario: Synced folder renamed in Edge
- **WHEN** a rename-collection job drains for a mapped folder
- **THEN** the Raindrop collection title matches the new Edge folder title
- **AND** the Raindrop collection id is unchanged
- **AND** Recent activity records a folder rename line

#### Scenario: Stale folder mapping on rename
- **WHEN** Raindrop returns not-found for the mapped collection id during rename
- **THEN** the folder→collection mapping is cleared
- **AND** no new collection is created solely for the rename

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

### Requirement: Queue-depth bulk prompt arming
After enqueue or drain-related queue size changes, the sync engine SHALL arm durable bulk-prompt state when pending jobs are at or above the queue bulk threshold and snooze does not apply. Arming SHALL NOT require the user to trigger Import or Pull.

#### Scenario: Live create storm arms prompt
- **WHEN** many bookmarks are created in the browser and queued for upload
- **AND** pending reaches the queue bulk threshold
- **THEN** bulk-prompt needs_choice is set without an Import click

### Requirement: Drain respects bulk-prompt pause
The drain loop SHALL check bulk-prompt state and SHALL skip processing Raindrop-bound jobs while needs_choice is set.

#### Scenario: Heartbeat drain no-ops while waiting
- **WHEN** needs_choice is set
- **AND** drain runs
- **THEN** no upload/pull/delete Raindrop calls are made from that drain pass due to the pause
