## Why

After Trash fast-path delete detection, reconcile still logs thousands of “postponed missing-raindrop check(s)” because pairs that are alive outside the sync-root listing (moved out, allowlist cleared, etc.) stay delete candidates forever. At 8 confirm GETs per finished cycle, that backlog never drains and burns rate-limit budget every quiet-time tick.

## What Changes

- When a capped confirm GET shows a mapped raindrop is still alive and its collection is outside the scoped listing (not under the sync root and not under an active outside-root allowlist), the engine **parks** that raindrop id so it is no longer a delete-confirm candidate.
- Parked ids keep their Edge bookmark and pair (no unpair, no local delete).
- Parking clears when the id appears again in a completed scoped listing (moved back into scope / re-allowlisted and listed).
- Trash fast path and confirm-GET absence → `delete-edge` remain unchanged for true deletes; parked ids still participate in Trash matching via the pair map.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `bookmark-sync-engine`: Park out-of-scope alive confirms so the missing-raindrop candidate set can shrink instead of regenerating forever.
- `bidirectional-sync`: Clarify that out-of-scope living pairs are not repeatedly treated as remote-delete candidates.

## Impact

- `src/lib/reconcile-finish.js` — park on alive+out-of-scope; skip parked when building candidates; unpark when seen in listing.
- `src/lib/store.js` / reconcile state — durable `parkedAliveIds` (or equivalent).
- `src/lib/allowlist.js` / `collections.js` — reuse root/allowlist membership helpers for scope checks.
- Verify scripts + activity-log messages; update `docs/raindrop-delete-detection-options.md` (option C implemented).
