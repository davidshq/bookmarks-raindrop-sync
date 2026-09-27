# canonical-bookmark-roots Specification

## Purpose

TBD — Canonical Chromium toolbar/other root titles in Raindrop, alias-aware pull placement, and one-time legacy tree migration.

## Requirements

### Requirement: Canonical Raindrop root segment titles
When uploading a browser bookmark path into Raindrop under the configured sync root, the engine SHALL rewrite the first path segment when it identifies a Chromium toolbar or “other bookmarks” top root, using canonical titles `Bookmarks bar` and `Other bookmarks` respectively. Nested user folder titles SHALL NOT be rewritten. Local browser folder titles SHALL NOT be renamed.

#### Scenario: Edge Favorites bar uploads as Bookmarks bar
- **WHEN** a bookmark under the local root titled `Favorites bar` is synced with root collection `Bookmarks`
- **THEN** Raindrop collections are ensured under `Bookmarks/Bookmarks bar/…`
- **AND** the local Favorites bar folder title is unchanged

#### Scenario: Chrome Bookmarks bar stays canonical
- **WHEN** a bookmark under the local root titled `Bookmarks bar` is synced with root collection `Bookmarks`
- **THEN** Raindrop collections are ensured under `Bookmarks/Bookmarks bar/…`

#### Scenario: Other favorites uploads as Other bookmarks
- **WHEN** a bookmark under the local root titled `Other favorites` is synced
- **THEN** its Raindrop path uses `Other bookmarks` as the first segment under the sync root

### Requirement: Alias-aware mirror placement on pull
When resolving a Raindrop-relative path into the local bookmark tree, the engine SHALL treat canonical titles and known aliases as the same top-root role so pull does not create a duplicate folder named `Bookmarks bar` beside an existing `Favorites bar` (or the reverse).

#### Scenario: Canonical bar path lands on Edge Favorites bar
- **WHEN** a raindrop path under the sync root begins with `Bookmarks bar`
- **AND** the browser’s toolbar root is titled `Favorites bar`
- **THEN** pull places the bookmark under that Favorites bar tree
- **AND** does not create a new top-level or nested folder solely to match the canonical spelling

#### Scenario: Alias equality for path existence
- **WHEN** folder mode is `existing-only`
- **AND** Raindrop path is `Bookmarks bar/Work`
- **AND** Edge already has `Favorites bar/Work`
- **THEN** the mirrored path is treated as already existing

### Requirement: Top-root alias drift does not rename browser roots
The engine SHALL NOT rename a browser top-level bookmark root when its title differs from the paired or mirrored Raindrop collection title only by a known toolbar/other alias (e.g. `Favorites bar` vs `Bookmarks bar`).

#### Scenario: Raindrop canonical bar does not rename Favorites bar
- **WHEN** bidirectional mode is on
- **AND** a Raindrop collection titled `Bookmarks bar` corresponds to the Edge top root `Favorites bar`
- **THEN** reconcile does not rename that Edge top root

### Requirement: One-time legacy Raindrop tree migration
The extension SHALL provide a one-shot migration that renames the legacy sync root collection `Edge` to `Bookmarks` and, under that root, renames direct children `Favorites bar` → `Bookmarks bar` and `Other favorites` → `Other bookmarks` when present, preserving Raindrop collection ids. After a successful migration it SHALL update stored `config.rootName` from `Edge` to `Bookmarks` when applicable, refresh or drop stale path→collection cache keys for old prefixes, and persist a flag so the migration does not run again.

#### Scenario: Legacy Edge tree migrates in place
- **WHEN** Raindrop has a top-level collection `Edge` with child `Favorites bar` and the migration has not yet completed
- **THEN** those collections are renamed to `Bookmarks` and `Bookmarks bar` respectively
- **AND** collection ids are unchanged
- **AND** subsequent startups skip the migration

#### Scenario: Already-canonical tree is a no-op
- **WHEN** the sync root is already `Bookmarks` with canonical bar/other children
- **AND** no legacy titles remain to rename
- **THEN** migration completes without renaming unrelated collections
