## ADDED Requirements

### Requirement: Guided bulk Match on Import and Pull
When the user triggers Import to Raindrop or Pull now and bulk-candidate heuristics fire, the Options UI SHALL prompt to Match from Raindrop export first, continue without matching, or cancel, then optionally dry-run and record pairs before continuing the live operation. Status for Match SHALL be shown separately from Import and Pull status lines.

#### Scenario: Import interrupt
- **WHEN** the user clicks Import to Raindrop and heuristics mark a bulk candidate
- **THEN** the UI asks before enqueueing Import
- **AND** choosing Match first runs the Match flow before Import

#### Scenario: Pull interrupt
- **WHEN** sync mode is bidirectional, the user clicks Pull now, and heuristics mark a bulk candidate
- **THEN** the UI asks before starting Pull
- **AND** choosing Match first runs the Match flow before Pull

### Requirement: Power-user Match existing control
The Manual Sync panel MAY provide a Match existing from export control for users who want to run Match without starting Import/Pull. Help text SHALL state that Match records pairs only and that large Import/Pull operations may prompt automatically.

#### Scenario: Manual Match available
- **WHEN** the user views Manual Sync
- **THEN** a Match existing control is available
- **AND** help text states it records pairs only

### Requirement: No temporary Other favorites repair in Options
The Options Manual Sync panel SHALL NOT include a one-shot Other favorites repair button that removes or moves top-level Other favorites using a hardwired personal folder map.

#### Scenario: Repair control absent
- **WHEN** the user opens the Manual Sync panel
- **THEN** no Other favorites live-repair control is offered
