## ADDED Requirements

### Requirement: Bulk lane uses Raindrop export as a snapshot oracle
The extension SHALL provide a bulk lane that fetches Raindrop `export.csv` (collection `0` = all except Trash) to obtain raindrop id and url presence. The bulk lane SHALL NOT replace the live heartbeat reconcile path. The bulk lane SHALL treat export as lacking collection path and MUST NOT claim folder placement from CSV alone.

#### Scenario: Export fetch for Match
- **WHEN** the user proceeds with Match existing from Raindrop export
- **THEN** the extension requests Raindrop export CSV once for presence
- **AND** builds a URL→raindropId index from the CSV id and url columns

#### Scenario: Heartbeat unchanged
- **WHEN** the extension runs its normal heartbeat drain/reconcile
- **THEN** it does not download export CSV as part of that heartbeat

### Requirement: Local heuristics detect bulk candidates
The extension SHALL evaluate local heuristics (Edge bookmarks, pair map, folder policy) before starting Import or Pull to decide whether to suggest Match existing. Heuristics SHALL NOT require downloading export.csv. Import SHALL be treated as a bulk candidate when the count of bookmarks that would be queued is at or above a documented unpaired threshold, or when Edge URL count is large and pair coverage is low. Pull SHALL be treated as a bulk candidate in bidirectional mode when Edge URL count is large and pair coverage is low.

#### Scenario: Large unpaired Import suggests bulk
- **WHEN** the user starts Import to Raindrop
- **AND** the number of unpaired non-excluded bookmarks is at or above the unpaired threshold
- **THEN** the extension prompts before enqueueing Import

#### Scenario: Low pair coverage suggests bulk
- **WHEN** the user starts Import or Pull
- **AND** Edge has a large URL count with low pair coverage per the documented thresholds
- **THEN** the extension prompts before continuing that live operation

#### Scenario: Small Import skips prompt
- **WHEN** the user starts Import
- **AND** heuristics do not mark a bulk candidate
- **THEN** Import proceeds without a Match prompt

### Requirement: Guided ask, optional dry-run, then apply
When heuristics mark a bulk candidate, the extension SHALL ask the user to Match from export first, continue the live operation without matching, or cancel. If the user chooses Match first, the extension SHALL ask whether to show a dry-run summary before applying. Dry-run SHALL report at least: would pair, already paired, ambiguous, conflicts, Edge-only, Raindrop-only. Apply SHALL record unambiguous pairs only and SHALL NOT delete, move, or create bookmarks/raindrops. After a successful Match path (or user skip), the extension SHALL continue the original Import or Pull unless the user cancelled.

#### Scenario: User matches then Import continues
- **WHEN** Import is a bulk candidate and the user chooses Match first and confirms Apply after optional dry-run
- **THEN** unambiguous pairs are recorded
- **AND** Import enqueue runs afterward

#### Scenario: User continues without matching
- **WHEN** Import is a bulk candidate and the user declines Match and confirms continue
- **THEN** Import runs without recording pairs from export

#### Scenario: User cancels
- **WHEN** Import is a bulk candidate and the user cancels the prompt chain
- **THEN** Import is not started

#### Scenario: Dry-run skipped
- **WHEN** the user chooses Match first and declines dry-run
- **THEN** the extension records pairs without requiring a dry-run confirm step
- **AND** still does not delete or move bookmarks

### Requirement: Match existing records pairs by URL
Match existing SHALL compare Edge bookmark URLs to the export URL index using stable URL match keys and record the pair map for unambiguous matches. A raindrop whose reverse pair points at a bookmark id that is not present in the current Edge tree SHALL NOT be treated as a conflict solely for that reason (stale id / rebind).

#### Scenario: Unambiguous match records pair
- **WHEN** Apply finds exactly one Edge bookmark and one export raindrop for a URL match key
- **AND** the Edge bookmark is not already paired to a different raindrop id
- **THEN** the extension records the bookmark id ↔ raindrop id pair

#### Scenario: Stale reverse pair rebinds
- **WHEN** export matches a live Edge bookmark by URL
- **AND** the pair map’s reverse entry for that raindrop points at a bookmark id no longer in the Edge tree
- **THEN** Match existing may record the pair to the live bookmark id

#### Scenario: Ambiguous URL skipped
- **WHEN** more than one Edge bookmark or more than one export raindrop shares the same match key
- **THEN** the extension does not record a pair for that key

### Requirement: Temporary Other-favorites repair is not product bulk sync
The extension MUST NOT expose the temporary hardwired Other-favorites repair control as the bulk lane.

#### Scenario: No Other-favorites repair control
- **WHEN** the user opens Options Manual Sync
- **THEN** there is no one-shot Other favorites repair control that removes or moves loose Other favorites via a hardwired folder map
