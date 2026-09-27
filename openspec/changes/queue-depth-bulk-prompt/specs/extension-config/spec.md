## ADDED Requirements

### Requirement: Status bulk-queue notice
When durable bulk-prompt state indicates a choice is needed, the Options Status panel SHALL show a notice that includes the approximate pending job count and short explanation that an external import or large backlog may take a long time if left to drip. The notice SHALL offer actions to Match from Raindrop export and to continue dripping (dismiss/snooze). The notice SHALL be visible without requiring the user to open Manual Sync or click Import/Pull.

#### Scenario: Status shows notice
- **WHEN** the user opens Options Status and needs_choice is set
- **THEN** a bulk-queue notice is visible with Match and Continue actions

#### Scenario: Continue hides notice
- **WHEN** the user chooses Continue drip
- **THEN** the notice is dismissed per snooze rules
- **AND** Status no longer shows needs_choice for that backlog

#### Scenario: Match from Status
- **WHEN** the user chooses Match from the Status notice
- **THEN** the Match existing flow runs (optional dry-run per existing Match UX)
- **AND** Status reflects success or failure of that flow
