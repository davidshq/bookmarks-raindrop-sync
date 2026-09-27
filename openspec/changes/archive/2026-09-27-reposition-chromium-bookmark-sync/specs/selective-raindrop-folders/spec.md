## ADDED Requirements

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
