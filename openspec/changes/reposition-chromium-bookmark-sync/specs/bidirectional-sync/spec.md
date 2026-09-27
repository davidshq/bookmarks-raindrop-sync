## ADDED Requirements

### Requirement: Pull placement respects canonical root aliases
When sync mode is `bidirectional`, Raindrop→browser ingest and path existence checks SHALL use the same canonical toolbar/other alias rules as upload, so a raindrop under `Bookmarks bar/…` lands on the local toolbar root whether that root is titled `Bookmarks bar` or `Favorites bar`.

#### Scenario: Chrome and Edge share one Raindrop bar tree
- **WHEN** bidirectional mode is on
- **AND** a raindrop exists under `Bookmarks/Bookmarks bar/Work`
- **AND** the browser toolbar root is titled `Favorites bar`
- **THEN** pull creates or updates the bookmark under `Favorites bar/Work`
- **AND** does not create a parallel `Favorites bar/Bookmarks bar/Work` path
