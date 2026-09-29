## MODIFIED Requirements

### Requirement: Repair pairs
Options → Manual Sync SHALL offer **Repair pairs**: a dry-run that refreshes the presence snapshot and, without any Edge or Raindrop write, computes (a) pairs to keep (both ids alive), (b) Edge-side rebinds and Raindrop-side rebinds using the pair-records rebind rules, (c) pairs to prune (unresolvable on either side after rebind), (d) tombstones to clear because the raindrop is alive, and (e) queued delete jobs to drop. Apply SHALL replace the pair records with kept + rebound records, clear those tombstones, drop delete jobs, and reset the delete breaker. Match existing SHALL treat a forward link to a raindrop id absent from the snapshot as stale (rebind), not as a conflict.

#### Scenario: Ghost forward link rebinds to the surviving raindrop
- **WHEN** a live bookmark is paired to a raindrop id that no longer exists and the snapshot has the same URL under another id
- **THEN** the plan rebinds the record to the surviving id with zero conflicts

#### Scenario: Stale Edge id rebinds in plan
- **WHEN** a record's bookmark id is missing from the tree and the same URL exists under its recorded mirror path
- **THEN** the plan lists it as an Edge-side rebind, not a prune

## ADDED Requirements

### Requirement: Pair health in Status
After each completed reconcile finish and after Repair pairs, the engine SHALL compute from the pair records, the Edge tree and the presence snapshot: live↔live pairs, pairs with a stale Edge id, pairs with a stale Raindrop id, Edge-only URLs under the mirror, Raindrop-only URLs, duplicate-URL groups on each side, and snapshot age and completeness. Options → Status SHALL display these counts from the stored result without fetching the export itself and SHALL offer a **Repair pairs** shortcut when any stale-id count is non-zero.

#### Scenario: Health shown after reconcile
- **WHEN** a reconcile finish completes with a complete snapshot
- **THEN** Status shows the pair-health counts and the snapshot age

#### Scenario: Stale pairs prompt repair
- **WHEN** the stale-Edge-id or stale-Raindrop-id count is greater than zero
- **THEN** Status shows a Repair pairs action next to the counts
