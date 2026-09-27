## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Guided Match gate is Options-scoped
The ask → optional dry-run → Match-from-export gate before Import/Pull SHALL apply to the Options Manual Sync controls (and Match from the Status bulk-queue notice). The compact action popup MAY start Import or Pull without that guided Match prompt; queue-depth bulk-prompt pause SHALL still apply to drain/reconcile when pending crosses the threshold.

#### Scenario: Options Import is gated
- **WHEN** Options Manual Sync Import is a bulk candidate
- **THEN** the user is asked before enqueueing

#### Scenario: Popup Import may skip Match prompt
- **WHEN** the user clicks Import in the extension popup
- **THEN** backfill may start without the Options Match ask/dry-run chain
