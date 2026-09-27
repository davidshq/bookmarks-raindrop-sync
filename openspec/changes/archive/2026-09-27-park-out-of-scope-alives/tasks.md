## 1. Storage

- [x] 1.1 Add durable `parkedAliveIds` on reconcile state (default `[]`) with helpers to park / unpark / read as a Set
- [x] 1.2 Prune parked ids that no longer have a pair when finishing delete detection

## 2. Confirm path

- [x] 2.1 Pass collection index, sync root id, and allowlist into delete-confirm finish
- [x] 2.2 On alive confirm: if collection out of scoped listing, park id (keep Edge + pair); if in scope, leave unparked and do not delete
- [x] 2.3 Skip parked ids when building missing-raindrop candidates; unpark ids present in `seenAcc ∪ seenIds`
- [x] 2.4 Activity log: batch “Parked N out-of-scope alive pair(s)” when any parked this finish

## 3. Docs and verification

- [x] 3.1 Update `docs/raindrop-delete-detection-options.md` to mark option C implemented
- [x] 3.2 Add verify coverage: outside-scope alive parks and is not re-confirmed next cycle; Trash still deletes parked; in-scope alive miss is not parked
- [x] 3.3 Run relevant verify scripts
