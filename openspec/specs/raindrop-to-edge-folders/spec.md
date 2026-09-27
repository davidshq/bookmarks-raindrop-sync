# raindrop-to-edge-folders Specification

## Purpose

Control whether Raindrop collection paths may create or reshape Edge folders during bidirectional pull: existing-only skip, lazy create-on-pull, or full empty-collection mirroring under the configured root.

## Requirements

### Requirement: Raindrop-to-Edge folder mode
When sync mode is `bidirectional`, the system SHALL honor a configured Raindrop→Edge folder mode of `existing-only`, `create-as-needed`, or `mirror-all` (default `create-as-needed`). The mode SHALL control whether pull may create Edge folders and whether empty Raindrop collections under the root are mirrored as Edge folders. When sync mode is `one-way`, the mode SHALL have no effect.

#### Scenario: Default preserves create-as-needed
- **WHEN** the user has never set Raindrop→Edge folder mode
- **THEN** the effective mode is `create-as-needed`

#### Scenario: Existing-only skips missing paths
- **WHEN** bidirectional mode is on and folder mode is `existing-only`
- **AND** a raindrop under the root would require creating one or more Edge folders
- **THEN** the system does not create those folders
- **AND** the system does not create an Edge bookmark for that raindrop
- **AND** the system does not place the bookmark in a catch-all or `_Unfiled` folder

#### Scenario: Existing-only pulls into present folders
- **WHEN** bidirectional mode is on and folder mode is `existing-only`
- **AND** the mirrored Edge path for a raindrop already exists
- **AND** the path is not excluded
- **THEN** an Edge bookmark is created in that existing folder as today

#### Scenario: Create-as-needed creates folders on pull
- **WHEN** bidirectional mode is on and folder mode is `create-as-needed`
- **AND** a raindrop’s mirrored path is missing folders in Edge
- **THEN** the missing folders are created
- **AND** the Edge bookmark is placed in the deepest folder
- **AND** empty Raindrop collections with no items are not created in Edge solely for being empty

#### Scenario: Mirror-all creates empty collection folders
- **WHEN** bidirectional mode is on and folder mode is `mirror-all`
- **AND** a Raindrop collection exists under the configured root with no raindrops to pull
- **AND** the mirrored Edge path is not excluded
- **THEN** the corresponding Edge folder path is created (ensure-if-missing)
- **AND** no bookmark is created for the empty collection itself

#### Scenario: One-way ignores folder mode
- **WHEN** sync mode is `one-way`
- **THEN** Raindrop→Edge folder mode does not change upload or local folder behavior

### Requirement: Folder existence checks use root aliases
When evaluating whether a mirrored browser path already exists for Raindrop→browser folder modes (`existing-only`, `create-as-needed`, `mirror-all`), the system SHALL treat canonical Raindrop toolbar/other segment titles as matching the local top roots via known aliases.

#### Scenario: Existing-only matches Edge Favorites bar to Bookmarks bar
- **WHEN** bidirectional mode is on and folder mode is `existing-only`
- **AND** a raindrop’s path under the root is `Bookmarks bar/Work`
- **AND** the browser already has `Favorites bar/Work`
- **THEN** the path is treated as present
- **AND** the bookmark may be created in that existing folder without creating a differently spelled bar folder

### Requirement: Exclude still gates folder mirroring
Effective `exclude` on the Edge path a mirror would use SHALL prevent pull-create and empty-collection folder creation for that path in all Raindrop→Edge folder modes.

#### Scenario: Excluded path not created under mirror-all
- **WHEN** folder mode is `mirror-all` and the Edge path for a Raindrop collection resolves under an effective `exclude` policy
- **THEN** reconcile does not create Edge folders for that collection

### Requirement: No selected dropdown mode
The Raindrop→Edge folders setting SHALL remain limited to `existing-only`, `create-as-needed`, and `mirror-all`. Selective Raindrop-only opt-in SHALL be provided via the Folder policies expandable allowlist, not via an additional dropdown value.

#### Scenario: Dropdown unchanged
- **WHEN** the user opens Raindrop→Edge folders in Settings
- **THEN** only the three existing modes are offered
- **AND** selective Raindrop-only choice is available under Folder policies when bidirectional
