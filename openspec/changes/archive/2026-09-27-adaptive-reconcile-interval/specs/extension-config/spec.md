## ADDED Requirements

### Requirement: Bidirectional reconcile interval setting
When sync mode is `bidirectional`, the extension SHALL let the user choose a quiet-time Raindrop reconcile interval in minutes from a fixed set of presets (at minimum including 1, 5, 15, 30, and 60), defaulting to 15, and SHALL persist the choice with the rest of settings. The control SHALL be hidden in one-way mode. Help text SHALL state that the interval applies when the sync queue is idle and that polling waits while other Raindrop work is still queued. Invalid or missing stored values SHALL normalize to the default (15) and values outside the allowed range SHALL be clamped.

#### Scenario: Save reconcile interval with bidirectional
- **WHEN** sync mode is `bidirectional` and the user selects a reconcile interval preset and saves settings
- **THEN** the interval minutes are persisted
- **AND** subsequent heartbeat reconcile uses that quiet-time interval

#### Scenario: Control hidden in one-way
- **WHEN** sync mode is `one-way`
- **THEN** the options UI does not show the reconcile interval control

#### Scenario: Default fifteen minutes
- **WHEN** the user has never set a reconcile interval
- **THEN** the effective stored/default interval is 15 minutes

#### Scenario: Help text explains adaptive polling
- **WHEN** bidirectional mode is selected and the user views the reconcile interval control
- **THEN** the UI explains that frequent polling applies when idle and that a busy sync queue defers listing
