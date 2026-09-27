# selective-raindrop-folders Specification

## Purpose

Opt-in allowlist for Raindrop-only collections under the configured root when bidirectional sync is on: Folder policies UI to choose which missing/empty Raindrop collections to sync, with empty allowlist preserving existing Raindrop→Edge folder modes.

## Requirements

### Requirement: Raindrop-only collections expandable
When sync mode is `bidirectional`, the Folder policies section SHALL include a collapsed expandable control labeled to the effect of “Choose Raindrop-only collections to sync”. Expanding it SHALL list Raindrop collections under the configured root that are not fully present in Edge (including empty collections), with controls to opt each collection into sync. The control SHALL NOT appear when sync mode is `one-way`. The Raindrop→Edge folders Settings dropdown SHALL NOT gain a separate “selected” mode for this purpose.

#### Scenario: Expandable under folder policies
- **WHEN** sync mode is `bidirectional` and the user views Folder policies
- **THEN** a collapsed section offers choosing Raindrop-only collections to sync
- **AND** expanding it shows Raindrop-only (and empty) collections under the root with Sync controls

#### Scenario: Hidden in one-way
- **WHEN** sync mode is `one-way`
- **THEN** the Raindrop-only collections expandable is not shown

### Requirement: Raindrop collection allowlist
The system SHALL persist an allowlist of Raindrop collection ids under the configured root. New collections SHALL default to not allowlisted. A collection SHALL be allowed when its id or an ancestor under the root is allowlisted. Allowlist edits in the options UI SHALL be held as a draft with folder-policy overrides until the user saves folder policies.

#### Scenario: Opt-in default
- **WHEN** a Raindrop collection under the root is not on the allowlist
- **THEN** it is not treated as opted-in for Raindrop-only Edge creation

#### Scenario: Parent covers descendants
- **WHEN** a parent collection is allowlisted
- **THEN** descendant collections are treated as allowed via that parent

#### Scenario: Draft until folder-policies save
- **WHEN** the user checks a Raindrop-only collection but has not saved folder policies
- **THEN** the persisted allowlist is unchanged
- **AND** sync continues to use the last saved allowlist

### Requirement: Allowlist gates Raindrop-only sync when active
When the persisted allowlist is non-empty, the system SHALL create Edge folders / pull raindrops for Raindrop-only paths only if allowlisted (no catch-all). When the mirrored Edge path already fully exists, pull SHALL still be allowed without an allowlist entry (subject to exclude). When the allowlist is empty, existing Raindrop→Edge folder mode behavior (`existing-only` / `create-as-needed` / `mirror-all`) SHALL apply unchanged.

#### Scenario: Non-empty allowlist skips unchecked Raindrop-only
- **WHEN** the allowlist contains at least one collection
- **AND** a raindrop’s collection is not allowlisted
- **AND** the mirrored Edge path does not fully exist
- **THEN** reconcile/drain does not create an Edge bookmark or folders for it

#### Scenario: Allowlisted collection syncs
- **WHEN** a collection is allowlisted and not excluded
- **THEN** reconcile may create its Edge folder path (including when empty)
- **AND** raindrops under that subtree may be pulled with folder creation as needed

#### Scenario: Empty allowlist preserves mode behavior
- **WHEN** the allowlist is empty and folder mode is `create-as-needed`
- **THEN** pull creates missing folders for Raindrop paths under the root as today

#### Scenario: Edge-existing bypass
- **WHEN** the mirrored Edge path already fully exists
- **THEN** pull may proceed even if the collection is not allowlisted

### Requirement: Outside-root allowlist landing uses local other root
Allowlisted Raindrop collections outside the sync root SHALL continue to land under the browser’s **other bookmarks** top root in a folder named `Raindrop` (then the collection path). Detection of the other-bookmarks root SHALL be alias-aware (`Other favorites`, `Other bookmarks`, or the top root matching `/other/i`), not Edge-title-specific.

#### Scenario: Outside-root pull on Edge
- **WHEN** an allowlisted collection outside the sync root is pulled
- **AND** the browser’s other root is titled `Other favorites`
- **THEN** its Edge folders are created under `Other favorites/Raindrop/…`

#### Scenario: Outside-root pull on Chrome
- **WHEN** an allowlisted collection outside the sync root is pulled
- **AND** the browser’s other root is titled `Other bookmarks`
- **THEN** its folders are created under `Other bookmarks/Raindrop/…`
