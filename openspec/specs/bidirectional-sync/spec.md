# bidirectional-sync Specification

## Purpose

Opt-in two-way sync under the configured Raindrop root: Raindrop→Edge ingest, bidirectional user-delete propagation with tombstones, and metadata-safe Edge→Raindrop writes that never clobber Raindrop-only fields.

## Requirements

### Requirement: Opt-in bidirectional sync mode
The system SHALL support a global sync mode of `one-way` or `bidirectional`, defaulting to `one-way`. Bidirectional behavior defined in this capability SHALL apply only when the mode is `bidirectional`.

#### Scenario: Default remains one-way
- **WHEN** the user has never changed sync mode
- **THEN** the extension behaves as one-way Edge→Raindrop sync
- **AND** Raindrop→Edge ingest and bidirectional delete propagation are inactive

#### Scenario: User enables bidirectional
- **WHEN** the user sets sync mode to `bidirectional` and saves
- **THEN** subsequent drains perform Raindrop→Edge ingest and bidirectional delete propagation under the configured root

### Requirement: Raindrop-to-Edge ingest under mirror root
When sync mode is `bidirectional`, the system SHALL periodically reconcile raindrops in the configured root collection and its descendants, creating an Edge bookmark (URL and title) in the mirrored folder path for each raindrop that has no pair mapping and no active tombstone, then persist the pair.

#### Scenario: New raindrop appears in Raindrop
- **WHEN** bidirectional mode is on and a raindrop exists under the root tree with no pair mapping and no tombstone
- **AND** the raindrop is not a Raindrop file or document upload
- **THEN** an Edge bookmark is created with that raindrop's link and title in the corresponding mirrored folder
- **AND** a `bookmarkId ↔ raindropId` pair is persisted
- **AND** the create does not enqueue a duplicate Edge→Raindrop upload

#### Scenario: Paired raindrop title URL or collection changes
- **WHEN** bidirectional mode is on and a paired raindrop's title, link, or collection placement differs from the Edge bookmark
- **THEN** Edge is updated to match (same bookmark id)
- **AND** `onChanged`/`onMoved` from that update do not enqueue an Edge→Raindrop echo

#### Scenario: Mapped Raindrop collection rename updates Edge folder title
- **WHEN** bidirectional mode is on and a Raindrop collection mapped to an Edge folder has a different title than that folder
- **AND** the Edge folder is not a top root (parent is not absolute root `0`)
- **AND** the folder is not under an effective `exclude` policy
- **THEN** the Edge folder title is updated in place to match
- **AND** the resulting `onChanged` does not enqueue an Edge→Raindrop collection rename

#### Scenario: File uploads are not pulled into Edge
- **WHEN** a raindrop under the root has `type` of `file` or `document`
- **THEN** reconcile does not create an Edge bookmark for it

#### Scenario: Stale pull does not resurrect after delete
- **WHEN** a `pull-create` job is still queued after a tombstone is recorded for that raindrop
- **OR** a delete job for that raindrop is already queued
- **THEN** drain does not create an Edge bookmark for that pull

#### Scenario: Raindrop outside root is ignored
- **WHEN** a raindrop exists outside the configured root collection tree
- **THEN** it is not created in Edge by reconcile

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

### Requirement: Configurable quiet-time reconcile cadence
When sync mode is `bidirectional`, periodic Raindrop→Edge reconcile on the heartbeat SHALL use the user-configured quiet-time interval (default 1 minute) as the minimum gap between *settled* completed cycles, and SHALL defer starting a new cycle while competing Raindrop traffic is active as defined by the bookmark-sync-engine traffic-aware deferral rules. Quiet-time cooldown SHALL NOT apply after a finish that still has deferred unparked missing-raindrop confirms. Manual "Pull now" SHALL still trigger an immediate reconcile subject to the global rate-limit pause.

#### Scenario: Faster quiet polling when configured
- **WHEN** bidirectional mode is on and the user has set the reconcile interval to 1 minute
- **AND** the queue is idle
- **AND** a settled reconcile cycle completed at least one minute ago
- **THEN** the next heartbeat starts a new reconcile listing pass

#### Scenario: Catch-up continues without quiet nap
- **WHEN** bidirectional mode is on and a reconcile finish deferred unparked missing-raindrop confirms
- **AND** the durable queue is idle
- **THEN** the next heartbeat does not skip reconcile solely for quiet-time cooldown

#### Scenario: Remote deletes wait while uploads drain
- **WHEN** bidirectional mode is on and raindrops were deleted remotely
- **AND** the durable queue still has upload jobs draining to Raindrop
- **THEN** heartbeat does not start a new reconcile listing until the queue is quiet (or the user triggers Pull now)

### Requirement: Pull placement respects canonical root aliases
When sync mode is `bidirectional`, Raindrop→browser ingest and path existence checks SHALL use the same canonical toolbar/other alias rules as upload, so a raindrop under `Bookmarks bar/…` lands on the local toolbar root whether that root is titled `Bookmarks bar` or `Favorites bar`.

#### Scenario: Chrome and Edge share one Raindrop bar tree
- **WHEN** bidirectional mode is on
- **AND** a raindrop exists under `Bookmarks/Bookmarks bar/Work`
- **AND** the browser toolbar root is titled `Favorites bar`
- **THEN** pull creates or updates the bookmark under `Favorites bar/Work`
- **AND** does not create a parallel `Favorites bar/Bookmarks bar/Work` path

### Requirement: Pull respects Raindrop-to-Edge folder mode
When sync mode is `bidirectional`, Raindrop→Edge ingest SHALL apply the configured Raindrop→Edge folder mode when deciding whether to create Edge folders or skip a raindrop whose mirrored path is incomplete in Edge.

#### Scenario: Existing-only does not enqueue useful work for missing paths
- **WHEN** bidirectional mode is on and folder mode is `existing-only`
- **AND** a raindrop under the root has no pair and no tombstone
- **AND** its mirrored Edge folder path does not fully exist
- **THEN** reconcile/drain does not create an Edge bookmark for it
- **AND** no catch-all Edge folder is used

#### Scenario: Create-as-needed still ensures path on pull
- **WHEN** bidirectional mode is on and folder mode is `create-as-needed`
- **AND** a raindrop is pulled whose Edge path is missing folders
- **THEN** missing folders are created and the bookmark is placed under the mirrored path

#### Scenario: Mirror-all ensures empty collections under root
- **WHEN** bidirectional mode is on and folder mode is `mirror-all`
- **AND** reconcile runs
- **THEN** Edge folders are ensured for Raindrop collections under the root that have no items, subject to exclude rules

### Requirement: User delete propagates Edge to Raindrop
When sync mode is `bidirectional` and the user removes a mapped Edge bookmark, the system SHALL delete the paired raindrop in Raindrop after confirming the mapping, then record a tombstone and clear the pair. When the user removes a folder, Chromium fires a single `onRemoved` for the folder (not for each child); the system SHALL walk `removeInfo.node` and enqueue Raindrop deletes for every paired URL bookmark in that tree.

#### Scenario: User deletes mapped bookmark in Edge
- **WHEN** bidirectional mode is on and the user deletes an Edge bookmark that has a pair mapping
- **THEN** the paired raindrop is deleted via the Raindrop API
- **AND** a tombstone is recorded so reconcile does not recreate it
- **AND** the pair mapping is removed

#### Scenario: User deletes a folder of mapped bookmarks
- **WHEN** bidirectional mode is on and the user deletes an Edge folder
- **AND** `onRemoved` supplies the folder's `node` tree (Chromium recursive payload)
- **THEN** each paired URL bookmark under that tree enqueues a Raindrop delete
- **AND** tombstones and pair clears apply per child as for a single bookmark delete

#### Scenario: Unmapped Edge delete
- **WHEN** the user deletes an Edge bookmark with no pair mapping
- **THEN** no Raindrop delete is attempted

### Requirement: User delete propagates Raindrop to Edge
When sync mode is `bidirectional` and reconcile detects that a mapped raindrop was soft-deleted (present in Raindrop Trash) or otherwise no longer exists as a living item under the sync scope, the system SHALL remove the paired Edge bookmark, record a tombstone, and clear the pair. Soft-deletes SHALL be discoverable primarily by listing Trash (`collectionId=-99`) on reconcile finish; absence confirmed by capped per-id GET (or equivalent presence check) remains the fallback for permanent deletes.

#### Scenario: Raindrop soft-deleted remotely (Trash)
- **WHEN** bidirectional mode is on
- **AND** a previously mapped raindrop appears in Raindrop Trash during reconcile finish
- **THEN** the paired Edge bookmark is removed
- **AND** a tombstone is recorded
- **AND** the pair mapping is removed

#### Scenario: Raindrop deleted remotely
- **WHEN** bidirectional mode is on and a previously mapped raindrop is absent from Raindrop during reconcile
- **THEN** the paired Edge bookmark is removed
- **AND** a tombstone is recorded
- **AND** the pair mapping is removed

### Requirement: Out-of-scope living pairs are not remote deletes
When sync mode is `bidirectional`, a mapped raindrop that remains alive outside the sync scope (not under the configured sync root and not covered by the active outside-root allowlist) SHALL NOT be treated as a remote delete solely because it is absent from the scoped listing. After confirm GET establishes that out-of-scope living state, the system SHALL stop repeatedly treating that id as a missing-raindrop delete candidate while keeping the Edge bookmark and pair until Trash or a later absence confirm for a non-parked candidate applies.

#### Scenario: Cleared allowlist does not delete Edge for living outside-root pair
- **WHEN** a pair was established for a raindrop outside the sync root under an allowlist
- **AND** the allowlist no longer includes that collection
- **AND** the raindrop still exists outside the sync root
- **THEN** reconcile does not remove the Edge bookmark as a remote delete
- **AND** after confirm GET parks the id, quiet-time cycles do not keep re-confirming that same id forever

### Requirement: Policy-driven local cleanup does not delete Raindrop
When the extension removes an Edge bookmark because of `sync-and-delete` after a confirmed upload, that removal SHALL NOT cause a Raindrop delete, even if sync mode is `bidirectional`. The `edge-offload` tombstone SHALL be recorded before the Edge bookmark is removed, and the raindrop id SHALL be stored on the upload job before that removal. The pair mapping SHALL be cleared after the Edge remove. If a later drain finds the Edge bookmark already gone and the job carries that raindrop id, the engine SHALL still record the tombstone and clear the pair instead of dropping the job. Reconcile SHALL NOT pull that raindrop back into Edge.

#### Scenario: Sync-and-delete after upload in bidirectional mode
- **WHEN** bidirectional mode is on and a bookmark's effective policy is `sync-and-delete`
- **AND** its Raindrop create is confirmed and the extension removes the Edge bookmark
- **THEN** the Raindrop copy remains
- **AND** no Raindrop delete job is enqueued for that pair
- **AND** the pair mapping is cleared
- **AND** an `edge-offload` tombstone blocks Raindrop→Edge re-ingest of that raindrop

#### Scenario: Restart after Edge remove still tombstones
- **WHEN** an offload job has stored the raindrop id and the Edge bookmark is already gone
- **THEN** drain records the `edge-offload` tombstone and clears the pair
- **AND** it does not create another raindrop

### Requirement: Raindrop-rich metadata is never overwritten from Edge
Edge→Raindrop writes SHALL only set Edge-owned fields (`link`, `title`, `collection` placement, and optionally `pleaseParse` on create). The system MUST NOT send or clear Raindrop-only fields such as tags, notes, highlights, covers, or excerpts on create or update.

#### Scenario: Create does not supply empty rich fields
- **WHEN** the engine creates a raindrop from an Edge bookmark
- **THEN** the request body includes only Edge-owned fields (and create-time `pleaseParse` if used)
- **AND** it does not set tags, notes, highlights, or cover to empty values

#### Scenario: Update does not clobber rich fields
- **WHEN** the engine updates an existing paired raindrop from Edge changes
- **THEN** only changed Edge-owned fields are written
- **AND** existing Raindrop tags, notes, highlights, covers, and excerpts remain intact

### Requirement: Exclude folders stay untouched in bidirectional mode
Bookmarks and mirrored paths under an effective `exclude` policy SHALL NOT be uploaded, ingested, or delete-propagated while bidirectional mode is on.

#### Scenario: Excluded path skipped on pull
- **WHEN** a raindrop would mirror into an Edge folder whose effective policy is `exclude`
- **THEN** reconcile does not create an Edge bookmark for it

#### Scenario: Excluded path not delete-propagated from Raindrop
- **WHEN** a paired raindrop disappears and the paired Edge bookmark's effective policy is `exclude`
- **THEN** the Edge bookmark is not removed
- **AND** the pair is cleared so reconcile does not keep enqueueing Edge deletes

### Requirement: Allowlist gates Raindrop-only ingest
When the Raindrop collection allowlist is non-empty, Raindrop→Edge ingest for paths that do not already exist in Edge SHALL require allowlist membership (collection or ancestor under root). Allowlisted empty collections SHALL get Edge folders on reconcile subject to exclude. When the allowlist is empty, ingest SHALL follow the configured Raindrop→Edge folder mode only.

#### Scenario: Unallowlisted missing path skipped when allowlist active
- **WHEN** the allowlist is non-empty
- **AND** a raindrop under the root is not allowlisted
- **AND** its Edge path does not fully exist
- **THEN** reconcile/drain does not create an Edge bookmark for it

#### Scenario: Allowlisted empty ensured
- **WHEN** an allowlisted Raindrop collection under the root has no items
- **AND** the path is not excluded
- **THEN** reconcile ensures the corresponding Edge folder path



### Requirement: Edge folder moves and renames do not delete Raindrop
When the user moves a mapped Edge bookmark or folder (parent change only), or renames a mapped Edge folder, or edits a mapped bookmark's title/URL, the system SHALL update the corresponding Edge-owned Raindrop fields or collection title as defined by the bookmark-sync-engine requirements and SHALL NOT treat those actions as a user delete: no Raindrop delete, no delete-propagation tombstone for that action, and no Edge remove unless destination policy is `sync-and-delete` after a confirmed create/update (existing offload path with remove suppression).

#### Scenario: Bidirectional move updates placement only
- **WHEN** sync mode is `bidirectional` and the user moves a paired Edge bookmark to another non-exclude folder
- **THEN** the paired raindrop remains (same raindrop id)
- **AND** its collection placement is updated to the new path
- **AND** no `delete-raindrop` job is enqueued for the move

#### Scenario: Bidirectional folder rename updates collection title only
- **WHEN** sync mode is `bidirectional` and the user renames a mapped Edge folder
- **THEN** the Raindrop collection id remains the same
- **AND** its title is updated
- **AND** no Raindrop deletes are enqueued for bookmarks under that folder solely due to the rename

#### Scenario: Bidirectional title/URL edit updates fields only
- **WHEN** sync mode is `bidirectional` and the user edits a paired bookmark's title or URL
- **THEN** the paired raindrop remains (same raindrop id)
- **AND** only Edge-owned fields are written
- **AND** no `delete-raindrop` job is enqueued for the edit

#### Scenario: Offload after move or update still suppresses delete propagation
- **WHEN** bidirectional mode is on and a moved or updated bookmark's destination effective policy is `sync-and-delete`
- **AND** the Raindrop create or Edge-owned update is confirmed and the extension removes the Edge bookmark
- **THEN** no Raindrop delete is enqueued for that remove
- **AND** an `edge-offload` tombstone is recorded as for create-time offload

### Requirement: Reconcile slices share per-wake spendable budget
When sync mode is `bidirectional`, Raindrop listing pages, Trash listing pages, and missing-raindrop confirm GETs on a heartbeat or Pull-now wake SHALL consume the same per-wake header-driven spendable budget and soft wake cap as drain work on that wake (as specified by bookmark-sync-engine). The engine SHALL prefer completing due drain work before starting large list/confirm slices when both compete for the same wake budget, and SHALL still allow Trash peek and list/confirm progress when spendable remains after drain even if Raindrop-bound queue jobs remain. Confirm GETs SHALL NOT be primarily limited to a fixed historical count of 8 when spendable and wake cap remain.

#### Scenario: Confirm GETs follow spendable not magic eight
- **WHEN** bidirectional reconcile finish has many unparked missing-raindrop candidates
- **AND** the wake still has spendable remaining above reserve and is under the soft wake cap
- **THEN** the engine may run more than eight confirm GETs that wake subject to spendable and the soft confirm backstop
- **AND** it stops confirms when spendable or the wake cap is exhausted without inferring false Edge deletes for unchecked candidates

#### Scenario: Trash and confirms stop on wake budget
- **WHEN** Trash listing or confirm GETs are in progress on a budgeted wake
- **AND** spendable or the soft wake cap is exhausted while remaining is still above reserve
- **THEN** the engine stops the current tick and resumes on a later wake
- **AND** does not set a Raindrop `rateLimitedUntil` pause solely for that self-cap stop

#### Scenario: Settled quiet cooldown still avoids burning quota
- **WHEN** the last reconcile finish was settled and quiet-time cooldown applies
- **AND** the durable queue is idle
- **THEN** heartbeat does not start a full nested listing solely to consume leftover spendable

#### Scenario: Leftover spendable funds Trash while queue has work
- **WHEN** the durable queue still contains Raindrop-bound jobs
- **AND** prefer-drain leaves spendable remaining on a heartbeat wake
- **AND** quiet-time cooldown does not apply (interval elapsed or unsettled catch-up)
- **THEN** the engine may run Trash listing and/or list/confirm slices on that leftover budget
- **AND** does not skip solely with reason `busy` for queue contention
