# export-bulk-sync Specification

## Purpose

Provide a guided bulk lane that uses Raindrop `export.csv` as a snapshot URL↔id oracle to record unambiguous pairs (Match existing) before large Import/Pull or queue-depth remediation — without replacing live heartbeat sync or claiming folder placement from CSV alone.

## Requirements

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
The extension SHALL evaluate local heuristics (browser bookmarks, pair map, folder policy) before Options starts Import or Pull to decide whether to suggest Match existing. Heuristics SHALL NOT require downloading export.csv. Import SHALL be treated as a bulk candidate when the count of bookmarks that would be queued is at or above **200**, or when scanned Edge URL count (`edgeScanned`, including excluded) is at or above **100** and pair coverage is below **0.3**. Pair coverage SHALL be `paired / (unpaired + paired)` over **in-scope** (non-excluded) URLs from the same walk as Import enqueue — not `paired / edgeScanned`. Pull SHALL be treated as a bulk candidate in bidirectional mode when `edgeScanned` ≥ **100** and pair coverage &lt; **0.3** (not the unpaired Import threshold alone).

#### Scenario: Large unpaired Import suggests bulk
- **WHEN** the user starts Import to Raindrop from Options Manual Sync
- **AND** the number of unpaired non-excluded bookmarks is at or above 200
- **THEN** the extension prompts before enqueueing Import

#### Scenario: Low pair coverage suggests bulk
- **WHEN** the user starts Import or Pull from Options Manual Sync
- **AND** `edgeScanned` is at least 100 and in-scope pair coverage is below 30%
- **THEN** the extension prompts before continuing that live operation

#### Scenario: Small Import skips prompt
- **WHEN** the user starts Import from Options Manual Sync
- **AND** heuristics do not mark a bulk candidate
- **THEN** Import proceeds without a Match prompt

#### Scenario: Pull ignores unpaired-only threshold
- **WHEN** sync mode is bidirectional and the user starts Pull from Options Manual Sync
- **AND** unpaired count is high but `edgeScanned` is below 100
- **THEN** Pull is not treated as a bulk candidate solely for the Import unpaired threshold

#### Scenario: Coverage ignores excluded URLs
- **WHEN** many Edge URLs are under effective `exclude` and `edgeScanned` is large
- **AND** in-scope paired/(unpaired+paired) is at or above 0.3 with unpaired below 200
- **THEN** Import is not treated as a bulk candidate solely because excluded URLs inflate `edgeScanned`

### Requirement: Guided Match gate is Options-scoped
The ask → optional dry-run → Match-from-export gate before Import/Pull SHALL apply to the Options Manual Sync controls (and Match from the Status bulk-queue notice). The compact action popup MAY start Import or Pull without that guided Match prompt; queue-depth bulk-prompt pause SHALL still apply to drain/reconcile when pending crosses the threshold.

#### Scenario: Options Import is gated
- **WHEN** Options Manual Sync Import is a bulk candidate
- **THEN** the user is asked before enqueueing

#### Scenario: Popup Import may skip Match prompt
- **WHEN** the user clicks Import in the extension popup
- **THEN** backfill may start without the Options Match ask/dry-run chain

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

### Requirement: Match existing invokable from queue bulk prompt
Match existing from Raindrop export SHALL be runnable as the remediation action from the queue-depth bulk prompt, using the same record-pairs-only semantics as Manual Sync / Import gates (no deletes, moves, or raindrop creates).

#### Scenario: Queue prompt triggers Match
- **WHEN** the user chooses Match from the Status bulk-queue notice
- **THEN** Match existing runs with the same pair-recording rules as the export-bulk-sync Match flow
