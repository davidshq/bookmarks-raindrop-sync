## ADDED Requirements

### Requirement: Chromium product identity
The extension’s user-visible name and description SHALL identify it as a Chromium bookmarks ↔ Raindrop sync product (Bookmarks ↔ Raindrop Sync), not as an Edge-only or Linux-sync-workaround extension. Options and popup copy SHALL refer to browser / local bookmarks rather than implying Edge exclusivity.

#### Scenario: Manifest name is browser-neutral
- **WHEN** the extension is loaded in a Chromium browser
- **THEN** the extension name presented to the user is Bookmarks ↔ Raindrop Sync (or an equivalent bookmarks ↔ Raindrop label)
- **AND** the description does not claim Edge-only support

## MODIFIED Requirements

### Requirement: Root collection name configuration
The extension SHALL let the user set the name of the root Raindrop collection under which the browser bookmark tree is mirrored, defaulting to `Bookmarks`.

#### Scenario: Default root name
- **WHEN** the user has not changed the root collection name
- **THEN** mirrored collections are created under a root named `Bookmarks`

#### Scenario: Custom root name
- **WHEN** the user sets the root collection name to a custom value
- **THEN** the browser bookmark tree is mirrored under a collection of that name
