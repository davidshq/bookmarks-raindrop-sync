## MODIFIED Requirements

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
