# ops-hardening Specification

## Purpose

Operational hardening for the personal sideload install: dead-letter exhausted jobs, storage quota visibility, and CI gates on lint/offline tests.

## Requirements

### Requirement: Dead-letter after max attempts
The sync engine SHALL move a queued job into a durable dead-letter list when transient retries exceed a configured maximum attempt count. Auth failures that halt deletions and global rate-limit pauses SHALL NOT dead-letter jobs solely for those reasons. Dead-lettered jobs SHALL NOT consume the per-drain job budget until the user retries them.

#### Scenario: Poison job exhausts retries
- **WHEN** a due job fails with a non-auth, non-rate-limit error and its attempt count reaches the maximum
- **THEN** the job is removed from the active queue
- **AND** it is appended to the dead-letter list with the last error and timestamp
- **AND** the activity log records that the job was dead-lettered

#### Scenario: Rate limit does not dead-letter
- **WHEN** a job fails because of a Raindrop rate limit
- **THEN** the job remains in the active queue deferred until the pause ends
- **AND** it is not moved to the dead-letter list

### Requirement: Dead-letter recovery in Options
The Options Status section SHALL show the count of dead-lettered jobs and SHALL provide actions to retry all dead-lettered jobs (re-enqueue with attempts reset) or clear the dead-letter list.

#### Scenario: User retries dead-lettered jobs
- **WHEN** the user chooses Retry dead-lettered jobs and at least one dead-letter entry exists
- **THEN** each entry is re-enqueued on the active queue with attempts reset to zero
- **AND** the dead-letter list is emptied for those retried entries

#### Scenario: User clears dead-letter list
- **WHEN** the user chooses Clear dead-lettered jobs
- **THEN** the dead-letter list is emptied
- **AND** those jobs are not re-enqueued

### Requirement: Storage usage visible and writes soft-fail
The extension SHALL report approximate `chrome.storage.local` byte usage in Options Status. When a durable storage write fails (including quota errors), the engine SHALL record the failure in status `lastError` and the activity log and SHALL NOT crash the service worker.

#### Scenario: Status shows storage usage
- **WHEN** the user opens Options Status (or it refreshes)
- **THEN** used bytes and the local storage quota (or a documented fallback) are displayed

#### Scenario: Storage write fails
- **WHEN** `chrome.storage.local.set` rejects or throws
- **THEN** `lastError` is set to a storage-failure message
- **AND** an error is appended to the activity log
- **AND** the service worker continues running

### Requirement: Delete circuit breaker

Executed deletes (Raindrop→Edge `delete-edge` removals and Edge→Raindrop `delete-raindrop` calls) SHALL be counted in a rolling 24-hour window persisted in status. When the count reaches `max(DELETE_BREAKER_MIN, DELETE_BREAKER_PAIR_FRACTION × live pairs)`, drain SHALL leave further delete jobs queued (not deferred, not dead-lettered), set `deletionsHalted` with a reason naming the breaker, log once, and keep processing non-delete jobs. Options → Status SHALL show the held count with **Allow these deletes** (reset the window and drain) and **Discard pending deletes** (drop delete jobs, keep pairs). Drain completion SHALL NOT clear `deletionsHalted` while the breaker is tripped.

#### Scenario: Slow bleed trips the breaker
- **WHEN** 51 `delete-edge` jobs for live paired bookmarks drain across several wakes with a small pair map
- **THEN** 50 bookmarks are removed, one job stays queued, status reports the breaker, and uploads still run

#### Scenario: Allow releases held deletes
- **WHEN** the user allows deletes
- **THEN** the window resets, the held job runs on the next drain, and `deletionsHalted` clears

### Requirement: Repair pairs

Options → Manual Sync SHALL offer **Repair pairs**: a dry-run that fetches the Raindrop export once and, without any Edge or Raindrop write, computes (a) pairs to keep (both ids alive), (b) pairs to prune (browser id absent from the tree and/or raindrop id absent from the export), (c) URL rebinds using the Match existing claim rules, (d) tombstones to clear because the raindrop is alive, and (e) queued delete jobs to drop. Apply SHALL replace the pair map with kept + rebound pairs, clear those tombstones, drop delete jobs, reset reconcile presence state (`seenAcc`, catch-up, parked ids, cursors) and reset the delete breaker. Match existing SHALL treat a forward link to a raindrop id absent from the export as stale (rebind), not as a conflict.

#### Scenario: Ghost forward link rebinds to the surviving raindrop
- **WHEN** a live bookmark is paired to a raindrop id that no longer exists and the export has the same URL under another id
- **THEN** the plan prunes the dead pair and rebinds the bookmark to the surviving id with zero conflicts

### Requirement: Continuous integration for lint and offline tests
The repository SHALL run ESLint and the offline verify scripts (`npm test`) on pushes and pull requests via CI so regressions are caught without a live Raindrop token.

#### Scenario: Pull request validation
- **WHEN** a pull request is opened or updated
- **THEN** CI runs lint and `npm test`
- **AND** the check fails if either step fails
