## ADDED Requirements

### Requirement: Folder existence checks use root aliases
When evaluating whether a mirrored browser path already exists for Raindrop→browser folder modes (`existing-only`, `create-as-needed`, `mirror-all`), the system SHALL treat canonical Raindrop toolbar/other segment titles as matching the local top roots via known aliases.

#### Scenario: Existing-only matches Edge Favorites bar to Bookmarks bar
- **WHEN** bidirectional mode is on and folder mode is `existing-only`
- **AND** a raindrop’s path under the root is `Bookmarks bar/Work`
- **AND** the browser already has `Favorites bar/Work`
- **THEN** the path is treated as present
- **AND** the bookmark may be created in that existing folder without creating a differently spelled bar folder
