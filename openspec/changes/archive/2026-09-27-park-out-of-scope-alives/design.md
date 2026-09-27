## Context

Confirm-GET delete detection treats every pair absent from the completed scoped listing as a candidate. Out-of-scope alives (cleared allowlist, moved out of root, etc.) confirm as living and stay candidates forever. Trash listing (option A) does not shrink that set. Broader options: [`docs/raindrop-delete-detection-options.md`](../../../docs/raindrop-delete-detection-options.md) option C.

## Goals / Non-Goals

**Goals:**

- Stop re-candidating raindrops confirmed alive outside sync scope so “postponed N checks” can fall toward real absences only.
- Keep Edge bookmarks and pairs for parked ids (no silent unpair / local delete).
- Preserve Trash fast path and confirm-GET → `delete-edge` for truly gone ids.
- Stay within existing per-tick GET budget and rate-limit pause behavior.

**Non-Goals:**

- Trust-listing deletes without GET (option B), full-library `collectionId=0` presence (D), `lastUpdate` search (E), export bulk lane (F).
- Raising `MAX_ALIVE_CHECKS_PER_TICK` as the primary fix (parking makes each GET progress permanent).
- UI to browse/manage parked ids (durable set + activity log is enough for v1).

## Decisions

### D1 — Policy: keep Edge + pair

**Choice:** Park = durable skip of delete-confirm only. Do not unpair or delete the Edge bookmark.

**Alternatives:** Unpair (loses sync identity; harder to re-attach) or delete-local (surprising for “moved out of scope”). Keep is the least destructive and matches “scope mismatch ≠ remote delete.”

### D2 — Scope test uses live collection from GET

**Choice:** After `GET /raindrop/{id}` returns a non-trash item, treat as in-scope if `collectionPathFromRoot(index, col, rootId)` is non-empty **or** (allowlist active and `isCollectionAllowed(col, …)`). Otherwise park.

**Why:** Listing miss alone is ambiguous; collection membership is the durable signal for “would never appear in scoped listing.”

### D3 — Durable `parkedAliveIds` on reconcile state

**Choice:** Persist string raindrop ids on reconcile state (same store as `aliveConfirmOffset`). Skip parked ids when building confirm candidates. Unpark when id appears in `seenAcc ∪ seenIds` at finish. Prune parked ids that no longer have a pair.

**Why:** No new storage key; survives worker restarts; unpark restores delete detection if the item returns to scope.

### D4 — In-scope alives that miss listing stay candidates

**Choice:** If GET says alive **and** collection is in scope, do not park (listing lag / race). Still do not enqueue delete.

**Why:** Parking in-scope alives would hide permanent deletes that never hit Trash if we later trust absence incorrectly; rare and self-heals on next listing.

### D5 — Trash still covers parked soft-deletes

**Choice:** Trash listing continues to intersect `pairs.byRaindrop` regardless of park set. Parked soft-deletes still enqueue `delete-edge`.

**Why:** Soft-delete discoverability must not regress for out-of-scope pairs the user later trashes.

## Risks / Trade-offs

- **[Risk] Hard-delete / emptied trash while parked** → Confirm GET no longer visits that id; Edge bookmark may linger. Mitigation: Trash fast path covers soft-delete; hard-delete of out-of-scope pairs is rare; future option D if needed.
- **[Risk] First drain of a multi-thousand backlog still takes many cycles** → Each id is parked once then gone; postponed N falls monotonically for that set. Acceptable vs infinite rotate.
- **[Risk] Stale park after allowlist re-adds a collection** → Mitigation: unpark on seen in listing; next outside-root list pass includes them.
- **[Trade-off] Extra log line when parking** → Batch “Parked N out-of-scope alive pair(s)” per finish pass to avoid spam.

## Migration Plan

- Roll forward: deploy; existing candidates park as the rotating window visits them.
- No schema migration beyond new optional reconcile field (default `[]`).
- Rollback: ignore/clear `parkedAliveIds`; confirm path returns to prior forever-candidate behavior.

## Open Questions

- None for v1; optional later: Status UI count of parked ids.
