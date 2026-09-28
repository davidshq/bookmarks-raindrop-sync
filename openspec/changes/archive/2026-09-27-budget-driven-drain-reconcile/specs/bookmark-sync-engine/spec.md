## ADDED Requirements

### Requirement: Header-driven per-wake Raindrop budget
On each heartbeat tick, Drain-now, or Pull-now that performs Raindrop API work, the engine SHALL compute a per-wake spendable request budget from observed or persisted `X-RateLimit-Remaining` minus the configured reserve. When remaining is unknown or the persisted rate window is stale (reset time elapsed or never observed), spendable SHALL be a small bootstrap count and SHALL NOT be treated as unbounded. The engine SHALL also enforce a soft per-wake cap (maximum Raindrop requests and/or wall-clock duration for that wake). Drain jobs, reconcile list pages, Trash list pages, and confirm GETs on that wake SHALL stop when spendable is exhausted, the soft wake cap is hit, remaining falls to the reserve (hard pause), auth fails, or there is no more due work. After every Raindrop response the engine SHALL refresh remaining/reset from response headers and recompute spendable. Fixed historical per-tick job/confirm/page constants SHALL NOT be the primary throttle when header-driven budgeting is active; they MAY remain only as soft fairness backstops under spendable.

#### Scenario: Heartbeat spends available remaining under wake cap
- **WHEN** a heartbeat tick runs with a fresh persisted or observed remaining well above reserve
- **AND** due queue jobs and/or reconcile work exist
- **THEN** the wake continues issuing Raindrop requests until work is done, remaining reaches reserve, or the soft wake cap is hit
- **AND** it does not stop solely because a historical fixed drain count of 25 (or busy 55) was reached while spendable and wake cap remain

#### Scenario: Unknown remaining bootstraps small
- **WHEN** a wake starts with no usable persisted rate window
- **THEN** spendable is limited to the bootstrap request count
- **AND** the wake does not assume the full ~120/min budget before the first headers arrive

#### Scenario: Low remaining still hard-pauses
- **WHEN** Raindrop responses report `X-RateLimit-Remaining` at or below the reserve threshold during a budgeted wake
- **THEN** the engine sets the global `rateLimitedUntil` pause as today
- **AND** subsequent heartbeats skip Raindrop work until the pause ends

### Requirement: Persist Raindrop rate window across wakes
The engine SHALL persist the latest observed Raindrop rate-limit remaining and reset timestamp (and an observation time) in durable extension storage so a later service-worker wake can seed spendable without assuming unknown→bold. When the persisted reset time is in the past, the engine SHALL treat the window as stale and use bootstrap until new headers arrive.

#### Scenario: SW restart reuses fresh window
- **WHEN** a prior wake observed remaining R with resetAt in the future
- **AND** the service worker restarts before resetAt
- **THEN** the next budgeted wake seeds spendable from that persisted remaining (minus reserve)
- **AND** does not ignore the prior observation solely because memory was cleared

#### Scenario: Stale window falls back to bootstrap
- **WHEN** persisted resetAt is at or before now
- **THEN** the next wake uses bootstrap spendable until a new Raindrop response updates headers

### Requirement: Distinguish self-cap stop from Raindrop rate-limit pause
When a budgeted wake stops because spendable or the soft wake cap is exhausted while remaining is still above reserve and no HTTP 429 occurred, the engine SHALL NOT set `rateLimitedUntil` for that stop. It SHALL record a durable throttle note distinct from `rate_limited` (e.g. wake cap or bootstrap) and activity-log copy SHALL attribute the stop to the self-cap, not to Raindrop rate-limit exhaustion. When a real rate-limit pause is active, Status and skip reason `rate_limited` remain authoritative.

#### Scenario: Wake cap stop is not rate_limited
- **WHEN** a heartbeat drain/reconcile stops after hitting the soft wake cap
- **AND** `X-RateLimit-Remaining` is still above reserve
- **THEN** `rateLimitedUntil` is not set for that stop
- **AND** the activity log or Status throttle note indicates a wake/self cap
- **AND** the message does not claim Raindrop rate-limit exhaustion

#### Scenario: True 429 still sets global pause
- **WHEN** Raindrop returns HTTP 429 during a budgeted wake
- **THEN** the engine sets `rateLimitedUntil` and skip reason `rate_limited` as today

### Requirement: Event-path drain uses a short budget
Live bookmark event handlers that signal drain SHALL use a short synthetic Raindrop budget (bootstrap-sized or similarly small), not the full soft wake request cap. Only heartbeat, explicit Drain-now, and Pull-now MAY burn the full per-wake spendable/wakeCap slice.

#### Scenario: Bookmark create does not burn full wake cap
- **WHEN** the user creates a bookmark and the live handler signals drain
- **THEN** that opportunistic drain stops after a short budget even if many jobs are due
- **AND** a later heartbeat may continue draining under a full wake budget

## MODIFIED Requirements

### Requirement: Honest deferred confirm messaging
When reconcile finish postpones unparked missing-raindrop confirm GETs because spendable, the soft wake cap, or a soft confirm backstop is exhausted, the activity log SHALL state that work continues on a later cycle due to the confirm/wake budget, and SHALL NOT attribute that postponement to Raindrop rate-limit exhaustion unless a rate-limit pause is actually active.

#### Scenario: Postpone log is not rate-limit blame
- **WHEN** finish defers N > 0 missing-raindrop confirms under the wake confirm budget
- **AND** no Raindrop rate-limit pause is active
- **THEN** the activity log mentions postponed confirms and continuing next cycle
- **AND** the message does not claim “rate-limit budget”
