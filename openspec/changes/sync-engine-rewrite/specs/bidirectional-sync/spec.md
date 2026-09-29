## MODIFIED Requirements

### Requirement: User delete propagates Edge to Raindrop
When sync mode is `bidirectional` and the user removes a mapped Edge bookmark, the system SHALL record the removal in the durable `edgeRemoved` ledger from the `onRemoved` node payload, enqueue a Raindrop delete, and at drain time apply the delete-evidence survival check: delete the paired raindrop, record a tombstone, and remove the pair record only when no other bookmark in the synced scope (mirror root plus active outside-root landing) carries the same URL. When the user removes a folder, Chromium fires a single `onRemoved` for the folder; the system SHALL walk `removeInfo.node` and apply the same rule to every paired URL bookmark in that tree. An `onRemoved` with no node payload SHALL NOT enqueue a Raindrop delete.

#### Scenario: User deletes mapped bookmark in Edge
- **WHEN** bidirectional mode is on and the user deletes an Edge bookmark that has a pair record
- **AND** `onRemoved` supplies the node payload
- **AND** no other bookmark in the synced scope carries the same URL
- **THEN** the paired raindrop is deleted via the Raindrop API
- **AND** a tombstone is recorded so reconcile does not recreate it
- **AND** the pair record and ledger entry are removed

#### Scenario: User deletes a folder of mapped bookmarks
- **WHEN** bidirectional mode is on and the user deletes an Edge folder
- **AND** `onRemoved` supplies the folder's `node` tree (Chromium recursive payload)
- **THEN** each paired URL bookmark under that tree is ledgered and enqueues a Raindrop delete
- **AND** survival checks, tombstones and pair clears apply per child as for a single bookmark delete

#### Scenario: User deletes a duplicate copy
- **WHEN** the user deletes the paired copy of a URL that also exists elsewhere in the synced scope
- **THEN** the pair record rebinds to the surviving copy
- **AND** no Raindrop delete runs

#### Scenario: Unmapped Edge delete
- **WHEN** the user deletes an Edge bookmark with no pair record
- **THEN** no Raindrop delete is attempted

### Requirement: User delete propagates Raindrop to Edge
When sync mode is `bidirectional` and reconcile finish observes a positive signal that a mapped raindrop is gone (present in Raindrop Trash, or absent from a complete presence snapshot), the system SHALL apply the delete-evidence survival check and, only when no other live raindrop carries the same URL, remove the paired Edge bookmark, record a tombstone, and remove the pair record. Soft-deletes SHALL be discovered by listing Trash (`collectionId=-99`) on reconcile finish; permanent deletes SHALL be discovered by absence from a complete snapshot. Per-id confirm GETs SHALL NOT be used for presence.

#### Scenario: Raindrop soft-deleted remotely (Trash)
- **WHEN** bidirectional mode is on
- **AND** a previously mapped raindrop appears in Raindrop Trash during reconcile finish
- **AND** no other live raindrop carries its URL
- **THEN** the paired Edge bookmark is removed
- **AND** a tombstone is recorded
- **AND** the pair record is removed

#### Scenario: Raindrop deleted remotely
- **WHEN** bidirectional mode is on and a previously mapped raindrop is absent from a complete presence snapshot
- **AND** no other live raindrop carries its URL
- **THEN** the paired Edge bookmark is removed
- **AND** a tombstone is recorded
- **AND** the pair record is removed

#### Scenario: Raindrop replaced by a copy under a new id
- **WHEN** a mapped raindrop id disappears and another raindrop with the same URL is present
- **THEN** the pair rebinds to the surviving raindrop
- **AND** the Edge bookmark is kept

### Requirement: Configurable quiet-time reconcile cadence
When sync mode is `bidirectional`, periodic Raindrop→Edge reconcile on the heartbeat SHALL use the user-configured quiet-time interval (default 1 minute) as the minimum gap between completed cycles and as the minimum age before a heartbeat refreshes the presence snapshot, and SHALL defer starting a new cycle while competing Raindrop traffic is active as defined by the bookmark-sync-engine traffic-aware deferral rules. Manual "Pull now" SHALL still trigger an immediate reconcile and snapshot refresh subject to the global rate-limit pause.

#### Scenario: Faster quiet polling when configured
- **WHEN** bidirectional mode is on and the user has set the reconcile interval to 1 minute
- **AND** the queue is idle
- **AND** a reconcile cycle completed at least one minute ago
- **THEN** the next heartbeat starts a new reconcile listing pass and refreshes the snapshot if it is at least one minute old

#### Scenario: Remote deletes wait while uploads drain
- **WHEN** bidirectional mode is on and raindrops were deleted remotely
- **AND** the durable queue still has upload jobs draining to Raindrop
- **THEN** heartbeat does not start a new reconcile listing until the queue is quiet (or the user triggers Pull now)

### Requirement: Reconcile slices share per-wake spendable budget
When sync mode is `bidirectional`, Raindrop listing pages, Trash listing pages, and the presence export request on a heartbeat or Pull-now wake SHALL consume the same per-wake header-driven spendable budget and soft wake cap as drain work on that wake (as specified by bookmark-sync-engine). The engine SHALL prefer completing due drain work before starting list slices when both compete for the same wake budget, and SHALL still allow Trash peek, snapshot refresh and list progress when spendable remains after drain even if Raindrop-bound queue jobs remain.

#### Scenario: Trash and listing stop on wake budget
- **WHEN** Trash listing or nested listing is in progress on a budgeted wake
- **AND** spendable or the soft wake cap is exhausted while remaining is still above reserve
- **THEN** the engine stops the current tick and resumes on a later wake
- **AND** does not set a Raindrop `rateLimitedUntil` pause solely for that self-cap stop

#### Scenario: Settled quiet cooldown still avoids burning quota
- **WHEN** the last reconcile finish completed and quiet-time cooldown applies
- **AND** the durable queue is idle
- **THEN** heartbeat does not start a full nested listing or an export solely to consume leftover spendable

#### Scenario: Leftover spendable funds Trash while queue has work
- **WHEN** the durable queue still contains Raindrop-bound jobs
- **AND** prefer-drain leaves spendable remaining on a heartbeat wake
- **AND** quiet-time cooldown does not apply
- **THEN** the engine may run Trash listing, a due snapshot refresh, and/or list slices on that leftover budget
- **AND** does not skip solely with reason `busy` for queue contention

### Requirement: Empty Trash only after discovery debt is clear
When sync mode is `bidirectional`, emptying Raindrop Trash before paired soft-deletes have been enrolled removes the fast soft-delete discovery signal. The system SHALL treat "safe to empty Trash" as discovery debt only: a complete Trash scan, started from page 0 on each check, with zero paired ids still needing enroll. Queued or in-flight `delete-edge` apply work SHALL NOT block safe-to-empty. Because permanent deletes are also discovered by snapshot absence, emptying Trash early delays but does not lose a delete.

#### Scenario: Safe to empty after enroll even if Edge delete pending
- **WHEN** bidirectional mode is on
- **AND** a complete Trash scan finds no paired ids still needing enroll
- **AND** one or more `delete-edge` jobs remain queued from that enroll
- **THEN** safe-to-empty MAY be true
- **AND** emptying Raindrop Trash does not prevent those jobs from completing Edge removal and tombstone recording

#### Scenario: Not safe while paired soft-deletes sit unseen in Trash
- **WHEN** bidirectional mode is on
- **AND** a paired raindrop is soft-deleted into Trash
- **AND** no complete Trash scan has yet enrolled that id
- **THEN** safe-to-empty MUST NOT be true

#### Scenario: Check Trash always rescans from page 0
- **WHEN** the user clicks Check Trash after an earlier partial scan
- **THEN** the scan restarts at page 0 and paired ids found on any earlier partial scan are not dropped
