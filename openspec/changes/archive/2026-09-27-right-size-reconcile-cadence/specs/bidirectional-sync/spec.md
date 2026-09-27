## MODIFIED Requirements

### Requirement: Configurable quiet-time reconcile cadence
When sync mode is `bidirectional`, periodic Raindrop→Edge reconcile on the heartbeat SHALL use the user-configured quiet-time interval (default 1 minute) as the minimum gap between *settled* completed cycles, and SHALL defer starting a new cycle while competing Raindrop traffic is active as defined by the bookmark-sync-engine traffic-aware deferral rules. Quiet-time cooldown SHALL NOT apply after a finish that still has deferred unparked missing-raindrop confirms. Manual "Pull now" SHALL still trigger an immediate reconcile subject to the global rate-limit pause.

#### Scenario: Faster quiet polling when configured
- **WHEN** bidirectional mode is on and the user has set the reconcile interval to 1 minute
- **AND** the queue is idle
- **AND** a settled reconcile cycle completed at least one minute ago
- **THEN** the next heartbeat starts a new reconcile listing pass

#### Scenario: Catch-up continues without quiet nap
- **WHEN** bidirectional mode is on and a reconcile finish deferred unparked missing-raindrop confirms
- **AND** the durable queue is idle
- **THEN** the next heartbeat does not skip reconcile solely for quiet-time cooldown

#### Scenario: Remote deletes wait while uploads drain
- **WHEN** bidirectional mode is on and raindrops were deleted remotely
- **AND** the durable queue still has upload jobs draining to Raindrop
- **THEN** heartbeat does not start a new reconcile listing until the queue is quiet (or the user triggers Pull now)
