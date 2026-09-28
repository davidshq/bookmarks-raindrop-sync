# extension-config Specification

## Purpose

Provide the configuration and status surfaces of the extension via a tabbed options page (Status, Settings, Manual Sync, Folder policies): Raindrop credentials, root collection naming, sync mode (one-way or bidirectional), global and per-folder policy settings, pruning, the import and pull triggers, and a sync status/log display.

## Requirements

### Requirement: Options page tabs
The options UI SHALL present four top-level tabs and SHALL show only the selected tab’s panel at a time: **Status** (pending queue with Edge→Raindrop / Raindrop→Edge breakdown, dead-lettered count and controls, last activity, local storage usage, recent activity, long-term archive export/clear), **Settings** (token, root name, sync mode and mode-dependent defaults, prune, long-term log toggle, save settings), **Manual Sync** (Import to Raindrop / sync-to-Raindrop action, and Pull from Raindrop when bidirectional), and **Folder policies** (Edge tree overrides draft and Raindrop-only allowlist). The Status tab SHALL be the default when Options opens with no hash. Hash fragments `#settings`, `#sync`, and `#folders` SHALL open the matching tab.

#### Scenario: Switch to Settings
- **WHEN** the user activates the Settings tab
- **THEN** only the Settings panel is visible
- **AND** Status, Manual Sync, and Folder policies panels are hidden

#### Scenario: Open Manual Sync via hash
- **WHEN** the options page loads with `#sync`
- **THEN** the Manual Sync tab is selected and its panel is shown

### Requirement: Raindrop test-token configuration
The extension SHALL provide a configuration field to enter and store a Raindrop personal test token in `chrome.storage`, and SHALL use it as the bearer credential for Raindrop API requests. The token SHALL NOT be displayed in plain text once saved beyond what is needed to confirm it is set.

#### Scenario: User saves a token
- **WHEN** the user enters a Raindrop test token and saves
- **THEN** the token is persisted in extension storage
- **AND** subsequent Raindrop requests authenticate with it

#### Scenario: No token configured
- **WHEN** no token is configured and a sync is attempted
- **THEN** the sync does not proceed
- **AND** the status view indicates that a token is required

### Requirement: Root collection name configuration
The extension SHALL let the user set the name of the root Raindrop collection under which the browser bookmark tree is mirrored, defaulting to `Bookmarks`.

#### Scenario: Default root name
- **WHEN** the user has not changed the root collection name
- **THEN** mirrored collections are created under a root named `Bookmarks`

#### Scenario: Custom root name
- **WHEN** the user sets the root collection name to a custom value
- **THEN** the browser bookmark tree is mirrored under a collection of that name

### Requirement: Chromium product identity
The extension’s user-visible name and description SHALL identify it as a Chromium bookmarks ↔ Raindrop sync product (Bookmarks ↔ Raindrop Sync), not as an Edge-only or Linux-sync-workaround extension. Options and popup copy SHALL refer to browser / local bookmarks rather than implying Edge exclusivity.

#### Scenario: Manifest name is browser-neutral
- **WHEN** the extension is loaded in a Chromium browser
- **THEN** the extension name presented to the user is Bookmarks ↔ Raindrop Sync (or an equivalent bookmarks ↔ Raindrop label)
- **AND** the description does not claim Edge-only support

### Requirement: Global default policy configuration
The extension SHALL let the user choose the global default policy from `sync-and-delete`, `sync-and-keep`, and `exclude` when sync mode is `one-way`, defaulting to `sync-and-delete`. When sync mode is `bidirectional`, the options UI SHALL NOT present a global delete-vs-keep choice; saving bidirectional mode SHALL persist the global default as `sync-and-keep` (keep both sides). Per-folder overrides of `sync-and-delete` (offload) and `exclude` SHALL remain available in both modes.

#### Scenario: Change global default in one-way
- **WHEN** sync mode is `one-way` and the user sets the global default policy to `sync-and-keep`
- **THEN** bookmarks with no ancestor override resolve to `sync-and-keep`

#### Scenario: Bidirectional implies keep-both globally
- **WHEN** the user selects Bidirectional Sync and saves
- **THEN** the global default policy is persisted as `sync-and-keep`
- **AND** the options UI explains that folder policies can still offload or exclude subtrees

#### Scenario: One-way after-upload control hidden in bidirectional
- **WHEN** sync mode is `bidirectional`
- **THEN** the options UI does not offer a global “delete from Edge after upload” control

### Requirement: Per-folder policy editor
The extension SHALL present the Edge folder tree and let the user assign an explicit policy override to any folder. Edits in the editor SHALL be held as a local draft and SHALL NOT be persisted or take effect for sync until the user explicitly applies them. Overrides SHALL be stored keyed by folder node id and displayed alongside the folder's path. The editor SHALL allow discarding unsaved draft changes.

The Folder policies panel SHALL present Apply and Discard on a sticky draft bar that remains visible while the user scrolls the folder tree and Raindrop-only section. The primary action SHALL be labeled **Apply folder policies** (not “Save”) so it is distinct from Settings’ Save settings control. Apply/Discard SHALL stay disabled while the draft matches the last persisted overrides and allowlist.

The Edge tree SHALL render as a collapsible hierarchy. Depth-0 roots (e.g. Favorites bar, Other favorites) SHALL start expanded. Folders with child folders at depth ≥ 1 SHALL start collapsed so their descendants are hidden until expanded. The editor SHALL provide per-folder expand/collapse controls for parents, and Expand all / Collapse all controls. Those parent controls SHALL be disclosure buttons (not an ARIA tree widget) so keyboard users reach each control and its policy select by tabbing. Collapse all SHALL restore the default expansion rule (roots expanded; deeper parents collapsed). Parents with hidden descendants SHALL show a count affordance indicating nested folders. Expansion state NEED NOT persist across Options page reloads. Policy draft/apply/discard behavior SHALL remain unchanged by expand/collapse.

#### Scenario: Assign an override
- **WHEN** the user selects a folder in the editor and assigns it `exclude`, then applies
- **THEN** an override keyed by that folder's node id is persisted
- **AND** the folder's path and chosen policy are shown in the editor

#### Scenario: Draft does not apply until Apply
- **WHEN** the user changes a folder's policy in the editor but has not applied
- **THEN** the persisted overrides are unchanged
- **AND** sync continues to resolve policies from the last applied overrides

#### Scenario: Discard draft
- **WHEN** the user has unsaved folder-policy edits and discards them
- **THEN** the editor reverts to the last applied overrides
- **AND** nothing is written to storage

#### Scenario: Sticky draft bar stays reachable
- **WHEN** the user is on Folder policies and scrolls through a long Edge tree
- **THEN** Apply folder policies and Discard remain visible in the sticky draft bar

#### Scenario: Remove an override
- **WHEN** the user clears a folder's override and applies
- **THEN** that folder reverts to nearest-ancestor / global-default resolution

#### Scenario: Nested folders collapsed by default
- **WHEN** the Folder policies Edge tree loads with nested folders under Other favorites (e.g. Hello, Goodbye, Disney that themselves have children)
- **THEN** Favorites bar and Other favorites are expanded
- **AND** those nested parent folders are collapsed
- **AND** their child folders are not visible until the user expands the parent

#### Scenario: Expand and collapse a folder
- **WHEN** the user expands a collapsed parent folder
- **THEN** its direct child folders become visible
- **WHEN** the user collapses that folder again
- **THEN** its descendants are hidden again

#### Scenario: Expand all and collapse all
- **WHEN** the user chooses Expand all
- **THEN** all parent folders in the Edge tree are expanded
- **WHEN** the user chooses Collapse all
- **THEN** depth-0 roots remain expanded and deeper parents are collapsed

### Requirement: Folder policy tree filter
The Folder policies Edge tree SHALL offer a text filter over folder title and path. While a filter is active, matching folders SHALL remain visible and their ancestor folders SHALL be expanded so matches are reachable. Clearing the filter SHALL restore the default expansion rule.

#### Scenario: Filter reveals nested match
- **WHEN** the user filters for a deeply nested folder name that is under a collapsed parent
- **THEN** the matching folder is shown
- **AND** ancestor folders along its path are expanded

#### Scenario: Clear filter restores defaults
- **WHEN** the user clears the folder filter
- **THEN** the tree returns to roots expanded and deeper parents collapsed

### Requirement: Empty-folder prune toggle
The extension SHALL expose a toggle controlling whether empty Edge folders are pruned after deletion, defaulting to off (leave folders).

#### Scenario: Toggle pruning
- **WHEN** the user enables the empty-folder prune toggle
- **THEN** subsequent deletions that empty a folder cause that folder to be removed

### Requirement: Backfill trigger
The extension SHALL provide an "Import to Raindrop" control that starts a backfill sweep of existing unsynced bookmarks. The control MAY be run at any time. The control's help text SHALL state that this uploads existing unsynced Edge bookmarks, may be run anytime, and does not pull from Raindrop. Progress for this control SHALL be shown separately from the pull control. The Manual Sync panel SHALL show a "Last push" timestamp updated when the Import sweep finishes enqueueing (not when queued uploads later drain), parallel to "Last pull" for reconcile.

#### Scenario: User triggers backfill
- **WHEN** the user clicks "Import to Raindrop"
- **THEN** the backfill sweep begins enqueuing existing bookmarks per their resolved policies

#### Scenario: Last push timestamp after import enqueue
- **WHEN** Import to Raindrop finishes enqueueing
- **THEN** the Manual Sync panel's "Last push" timestamp reflects that run

### Requirement: Sync status and log display
The extension SHALL display sync status, including pending queue size with a breakdown of how many jobs are Edge→Raindrop versus Raindrop→Edge when the queue is non-empty, dead-lettered job count (with Retry / Clear when non-empty), approximate `chrome.storage.local` usage, recent sync activity (up to 500 entries retained in local storage), and any errors such as authentication failures, storage write failures, or rate-limit backoff. The status view SHALL offer controls for an opt-in long-term activity archive (enable with settings, export, clear) as specified by the activity-log-archive capability.

When a new activity line has the same level and message as the newest recent-log entry, the extension SHALL update that entry instead of inserting another. The updated entry SHALL set `at` to the latest occurrence and SHALL record kept occurrence times in `ats` (oldest first, including the latest), capped so older times beyond the cap are dropped. A first occurrence SHALL omit `ats`. A line that does not match the newest entry SHALL be inserted as a new row. The status view SHALL show the latest time and, when `ats` has more than one time, a repeat count. It SHALL NOT require a control to expand the time list. Entries recorded before coalescing (no `ats`) SHALL still render as a single line.

#### Scenario: Pending work shown
- **WHEN** jobs are queued and being processed
- **THEN** the status view reflects the pending count and recent activity

#### Scenario: Pending direction breakdown
- **WHEN** the durable queue contains both Edge→Raindrop jobs (upload, delete-raindrop, rename-collection) and Raindrop→Edge jobs (pull-create, pull-update, pull-rename-folder, delete-edge)
- **THEN** Status (and the compact popup) show the total pending count plus separate Edge→Raindrop and Raindrop→Edge counts
- **AND** when pending is zero, the direction breakdown is omitted

#### Scenario: Error surfaced
- **WHEN** a Raindrop authentication error occurs
- **THEN** the error is shown in the status view
- **AND** the view indicates that deletions are halted until it is resolved

#### Scenario: Recent activity retention
- **WHEN** more than 500 activity lines have been recorded
- **THEN** the recent activity list retained for the status view keeps the newest 500 entries

#### Scenario: Storage usage and dead-letter controls
- **WHEN** Status refreshes
- **THEN** used bytes and quota are shown
- **AND** if dead-lettered jobs exist, Retry and Clear actions are offered

#### Scenario: Consecutive identical lines coalesce
- **WHEN** the same level and message are logged again and that pair is already the newest recent-log entry
- **THEN** the recent log still has one entry for that run
- **AND** `at` is the latest time
- **AND** `ats` lists the kept occurrence times oldest first

#### Scenario: Different message starts a new row
- **WHEN** a different message is logged between two identical lines
- **THEN** the later identical line is a separate recent-log entry

#### Scenario: Status shows repeat count
- **WHEN** the status view renders an entry whose `ats` length is greater than 1
- **THEN** the row shows the latest time, the message, and a repeat count equal to `ats.length`

### Requirement: Sync mode configuration
The extension SHALL let the user choose sync mode from `one-way` and `bidirectional`, defaulting to `one-way`, and SHALL persist the choice in extension storage.

#### Scenario: Save bidirectional mode
- **WHEN** the user selects Bidirectional Sync and saves
- **THEN** the sync mode is persisted as `bidirectional`
- **AND** subsequent engine behavior uses bidirectional rules

#### Scenario: Default one-way
- **WHEN** the user has not set a sync mode
- **THEN** the effective mode is `one-way`

### Requirement: Bidirectional warning and status
When bidirectional mode is selected, the options UI SHALL present a short warning that user deletes propagate both ways, note that the global default is keep-both, and point to folder Offload/Exclude for exceptions. The status view SHALL surface reconcile activity (pulls, remote deletes) and related errors.

#### Scenario: Warning shown
- **WHEN** the user views sync mode settings and bidirectional is selected or focused
- **THEN** a warning explains that deleting a bookmark in Edge or Raindrop deletes the paired item in the other system
- **AND** the UI indicates offload is a per-folder exception, not the global bidirectional default

#### Scenario: Reconcile activity in status
- **WHEN** bidirectional reconcile pulls or deletes items
- **THEN** the status or log view reflects that activity

### Requirement: Manual reconcile control
When bidirectional mode is enabled, the extension SHALL provide a "Pull now" control that triggers an immediate Raindrop reconcile. The control SHALL be hidden in one-way mode. Its help text SHALL state that this brings Raindrop changes into Edge, can remove Edge bookmarks whose Raindrop copy is gone, and does not upload existing Edge bookmarks. Progress for this control SHALL be shown separately from the import control. When a Pull now loop receives a `rate_limited` skip, it SHALL wait until the global Raindrop pause ends (using `rateLimitedUntil` when provided), show resuming progress copy, and continue that same pull without requiring another click, subject to a bounded max wait count after which copy MAY note that heartbeat continues.

#### Scenario: User runs reconcile
- **WHEN** sync mode is `bidirectional` and the user triggers "Pull now"
- **THEN** a reconcile pass is scheduled/started for the configured root tree

#### Scenario: Pull now waits out a rate-limit pause
- **WHEN** sync mode is `bidirectional` and Pull now receives `rate_limited` with a future `rateLimitedUntil`
- **THEN** the Manual Sync / popup progress shows that pull will resume after the pause
- **AND** the same Pull now loop continues after the wait without requiring another click

#### Scenario: Pull control hidden in one-way
- **WHEN** sync mode is `one-way`
- **THEN** the options UI does not show the pull control

### Requirement: Raindrop-to-Edge folders configuration
The extension SHALL let the user choose Raindrop→Edge folder mode from `existing-only`, `create-as-needed`, and `mirror-all` when sync mode is `bidirectional`, defaulting to `create-as-needed`, and SHALL persist the choice in extension storage with the rest of settings. When sync mode is `one-way`, the options UI SHALL NOT present this control.

#### Scenario: Save folder mode with bidirectional
- **WHEN** sync mode is `bidirectional` and the user selects a Raindrop→Edge folders value and saves settings
- **THEN** the folder mode is persisted
- **AND** subsequent bidirectional reconcile/pull uses that mode

#### Scenario: Control hidden in one-way
- **WHEN** sync mode is `one-way`
- **THEN** the options UI does not show the Raindrop→Edge folders control

#### Scenario: Default create-as-needed
- **WHEN** the user has never set Raindrop→Edge folder mode
- **THEN** the effective stored/default mode is `create-as-needed`

#### Scenario: Help text explains skip vs create vs mirror
- **WHEN** bidirectional mode is selected and the user views Raindrop→Edge folders
- **THEN** the UI explains that existing-only skips unmatched raindrops without a catch-all folder
- **AND** explains that create-as-needed creates folders when pulling bookmarks
- **AND** explains that mirror-all also creates folders for empty Raindrop collections under the root

### Requirement: Bidirectional reconcile interval setting
When sync mode is `bidirectional`, the extension SHALL let the user choose a quiet-time Raindrop reconcile interval in minutes from a fixed set of presets (at minimum including 1, 5, 15, 30, and 60), defaulting to 1, and SHALL persist the choice with the rest of settings. The control SHALL be hidden in one-way mode. Help text SHALL state that the interval applies when confirm catch-up is settled, and that heartbeat prefers draining the sync queue then uses leftover Raindrop budget for Trash / list work (not that any queued Raindrop job hard-defers all listing). Invalid or missing stored values SHALL normalize to the default (1) and values outside the allowed range SHALL be clamped.

#### Scenario: Save reconcile interval with bidirectional
- **WHEN** sync mode is `bidirectional` and the user selects a reconcile interval preset and saves settings
- **THEN** the interval minutes are persisted
- **AND** subsequent heartbeat reconcile uses that quiet-time interval

#### Scenario: Control hidden in one-way
- **WHEN** sync mode is `one-way`
- **THEN** the options UI does not show the reconcile interval control

#### Scenario: Default one minute
- **WHEN** the user has never set a reconcile interval
- **THEN** the effective stored/default interval is 1 minute

#### Scenario: Help text explains adaptive polling
- **WHEN** bidirectional mode is selected and the user views the reconcile interval control
- **THEN** the UI explains that frequent polling applies when idle and settled
- **AND** that drain prefers the sync queue and leftover budget funds Trash / list (not a hard listing deferral for any queued job)

### Requirement: Folder policies host Raindrop-only picker
The extension SHALL place the Raindrop-only collections chooser as an expandable section at the bottom of Folder policies when bidirectional mode is on, and SHALL persist allowlist drafts via the folder-policies apply/discard flow. Help text SHALL clarify that the Edge tree above is Edge-only and the expandable is for Raindrop-only opt-in, and that changes take effect with **Apply folder policies**.

#### Scenario: Apply allowlist with folder policies
- **WHEN** the user changes Raindrop-only checkboxes and applies folder policies
- **THEN** the allowlist is persisted with overrides

#### Scenario: Discard reverts allowlist draft
- **WHEN** the user discards folder-policy changes
- **THEN** Raindrop-only checkbox draft reverts to the last applied allowlist

### Requirement: Guided bulk Match on Import and Pull
When the user triggers Import to Raindrop or Pull now from **Options Manual Sync** and bulk-candidate heuristics fire, the Options UI SHALL prompt to Match from Raindrop export first, continue without matching, or cancel, then optionally dry-run and record pairs before continuing the live operation. Status for Match SHALL be shown separately from Import and Pull status lines. The compact action popup is not required to run this guided gate (see export-bulk-sync Options-scoped gate).

#### Scenario: Import interrupt
- **WHEN** the user clicks Import to Raindrop on Options Manual Sync and heuristics mark a bulk candidate
- **THEN** the UI asks before enqueueing Import
- **AND** choosing Match first runs the Match flow before Import

#### Scenario: Pull interrupt
- **WHEN** sync mode is bidirectional, the user clicks Pull now on Options Manual Sync, and heuristics mark a bulk candidate
- **THEN** the UI asks before starting Pull
- **AND** choosing Match first runs the Match flow before Pull

### Requirement: Power-user Match existing control
The Manual Sync panel MAY provide a Match existing from export control for users who want to run Match without starting Import/Pull. Help text SHALL state that Match records pairs only and that large Import/Pull operations may prompt automatically.

#### Scenario: Manual Match available
- **WHEN** the user views Manual Sync
- **THEN** a Match existing control is available
- **AND** help text states it records pairs only

### Requirement: No temporary Other favorites repair in Options
The Options Manual Sync panel SHALL NOT include a one-shot Other favorites repair button that removes or moves top-level Other favorites using a hardwired personal folder map.

#### Scenario: Repair control absent
- **WHEN** the user opens the Manual Sync panel
- **THEN** no Other favorites live-repair control is offered

### Requirement: Status bulk-queue notice
When durable bulk-prompt state indicates a choice is needed, the Options Status panel SHALL show a notice that includes the approximate pending job count and short explanation that an external import or large backlog may take a long time if left to drip. The notice SHALL offer actions to Match from Raindrop export and to continue dripping (dismiss/snooze). The notice SHALL be visible without requiring the user to open Manual Sync or click Import/Pull.

#### Scenario: Status shows notice
- **WHEN** the user opens Options Status and needs_choice is set
- **THEN** a bulk-queue notice is visible with Match and Continue actions

#### Scenario: Continue hides notice
- **WHEN** the user chooses Continue drip
- **THEN** the notice is dismissed per snooze rules
- **AND** Status no longer shows needs_choice for that backlog

#### Scenario: Match from Status
- **WHEN** the user chooses Match from the Status notice
- **THEN** the Match existing flow runs (optional dry-run per existing Match UX)
- **AND** Status reflects success or failure of that flow

### Requirement: Status surfaces reconcile deferral reasons
When bidirectional mode is on, the Options Status panel SHALL surface durable heartbeat reconcile-skip reasons (`busy`, `cooldown`, `rate_limited`, `bulk_pause`) with distinct user-visible copy so a deferred Raindrop check does not look like a stuck or idle install. When reason is `bulk_pause`, copy SHALL point at Match or Continue drip on the bulk-queue notice. When reason is `busy`, copy SHALL describe reconcile already running (reentrancy), not durable queue contention. When reason is `cooldown`, copy MAY mention Pull now and SHALL describe quiet-time wait after a settled Raindrop check (not unfinished confirm catch-up). When reason is `rate_limited`, copy SHALL refer to a Raindrop rate-limit pause (not a self wake-cap stop). Status SHALL NOT keep showing `bulk_pause` after needs_choice has already been cleared (guard or refresh SHALL clear the skip). Status SHALL NOT present quiet-time cooldown as the explanation while durable unsettled confirm catch-up is active (catch-up MUST continue on heartbeat instead of arming cooldown).

#### Scenario: Busy means reentrancy
- **WHEN** Status refreshes and reconcileSkipReason is `busy`
- **THEN** the Status panel shows that a Raindrop check is already running
- **AND** does not claim the sync queue alone deferred listing

#### Scenario: Bulk pause copy points at banner actions
- **WHEN** Status refreshes and reconcileSkipReason is `bulk_pause`
- **THEN** the Status panel points the user at Match or Continue drip on the bulk-queue notice

#### Scenario: Cooldown copy is settled quiet-time
- **WHEN** Status refreshes and reconcileSkipReason is `cooldown`
- **THEN** the copy indicates quiet-time wait after a settled check (or equivalent)
- **AND** does not imply unfinished missing-raindrop confirm catch-up

#### Scenario: Rate-limited copy is Raindrop pause
- **WHEN** Status refreshes and reconcileSkipReason is `rate_limited`
- **THEN** the copy indicates a Raindrop rate-limit pause
- **AND** does not describe a self wake-cap stop as that pause

#### Scenario: Stale bulk_pause not shown after Continue
- **WHEN** the user has chosen Continue drip and needs_choice is cleared
- **AND** Status refreshes
- **THEN** the UI does not present `bulk_pause` as the current deferral reason

### Requirement: Status distinguishes Raindrop pause from self-cap
The Options Status panel (and compact popup where rate-limit state is shown) SHALL distinguish a global Raindrop rate-limit pause (`rateLimitedUntil` / skip reason `rate_limited`) from a prior wake that stopped only because the soft wake cap or bootstrap budget was exhausted. Self-cap copy SHALL NOT claim the Raindrop API rate limit was exhausted. When `rateLimitedUntil` is active, rate-limit copy remains authoritative over any stale self-cap note.

#### Scenario: Self-cap note visible without rate-limit banner
- **WHEN** Status refreshes after a wake stopped for wake cap or bootstrap
- **AND** `rateLimitedUntil` is not active
- **THEN** Status indicates a self/wake budget stop (or equivalent)
- **AND** does not present it as a Raindrop rate-limit pause

#### Scenario: Active rate limit overrides self-cap note
- **WHEN** `rateLimitedUntil` is in the future
- **THEN** Status shows the rate-limit pause
- **AND** does not prefer self-cap wording over the pause

### Requirement: Status surfaces Raindrop Trash safe-to-empty
When sync mode is `bidirectional`, the Options Status panel SHALL surface a durable trash-hygiene snapshot so the user can tell whether it is safe to empty Raindrop Trash. The panel SHALL distinguish at least: **safe to empty** (last trash peek completed a full Trash scan and found zero paired raindrops still needing enroll), **waiting** (paired items still needing enroll and/or the last peek was incomplete), and **unknown** (no trash peek yet). Safe-to-empty SHALL mean discovery debt only: it SHALL NOT require queued `delete-edge` jobs to have drained. Copy SHALL include when the last peek ran when a snapshot exists. When sync mode is `one-way`, Status SHALL NOT present this trash-safe control as actionable. The toolbar popup SHALL NOT be required to show trash-safe state.

#### Scenario: Safe after complete clear peek
- **WHEN** sync mode is bidirectional
- **AND** the last trash hygiene snapshot has `trashScanComplete` true and `trashPairedPending` 0
- **THEN** Options Status indicates it is safe to empty Raindrop Trash
- **AND** shows the last peek time

#### Scenario: Waiting when paired trash remains
- **WHEN** sync mode is bidirectional
- **AND** the last snapshot reports `trashPairedPending` greater than 0
- **THEN** Options Status indicates Trash sync is still waiting
- **AND** does not claim safe to empty

#### Scenario: Incomplete peek is not safe
- **WHEN** sync mode is bidirectional
- **AND** the last snapshot has `trashScanComplete` false
- **THEN** Options Status does not claim safe to empty
- **AND** indicates the Trash peek was partial or truncated

#### Scenario: Unknown before first peek
- **WHEN** sync mode is bidirectional
- **AND** no trash hygiene snapshot has been recorded
- **THEN** Options Status does not claim safe to empty
- **AND** indicates a Trash check has not run yet

#### Scenario: Hidden in one-way
- **WHEN** sync mode is one-way
- **THEN** Options Status does not present trash-safe as an actionable bidirectional control

### Requirement: Status Check Trash control
When sync mode is `bidirectional`, Options Status SHALL provide a **Check Trash** control that requests a Trash-only hygiene peek (list Raindrop Trash, enroll paired deletes as today, refresh the trash hygiene snapshot) without requiring a full Pull now. The control SHALL respect Raindrop rate-limit pause / wake budget and SHALL surface deferral or failure in Status. When sync mode is `one-way`, the control SHALL be hidden.

#### Scenario: Check Trash refreshes snapshot
- **WHEN** sync mode is bidirectional and the user activates Check Trash
- **AND** Raindrop is not rate-limit paused
- **THEN** the extension runs a Trash peek
- **AND** updates the trash hygiene snapshot
- **AND** Status reflects the new safe / waiting / partial state

#### Scenario: Check Trash deferred on rate limit
- **WHEN** sync mode is bidirectional and the user activates Check Trash
- **AND** Raindrop rate-limit pause is active
- **THEN** Status indicates the check was deferred or paused
- **AND** does not invent a false safe-to-empty result
