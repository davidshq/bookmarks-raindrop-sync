## 1. Durable prompt state + detection

- [x] 1.1 Add `QUEUE_BULK_PENDING_THRESHOLD` (default 150) and storage shape for bulkPrompt (`needs_choice` / snooze watermarks)
- [x] 1.2 Implement `armBulkPromptIfNeeded(pending)` / `clear` / `snooze` helpers; call after enqueue paths and when status refresh sees depth
- [x] 1.3 Offline tests for arm / snooze / clear watermarks

## 2. Pause drain while awaiting choice

- [x] 2.1 Gate `drain()` when `needs_choice`; coalesced activity log line
- [x] 2.2 Skip or defer heartbeat reconcile Raindrop work while paused (avoid digging deeper)
- [x] 2.3 SW messages: get bulk prompt state; continue-drip; (Match reuses existing MSG)

## 3. Status UI

- [x] 3.1 Status banner with pending count + short ETA hint + Match / Continue drip
- [x] 3.2 Wire Match to existing Match flow; Continue clears pause + snoozes
- [x] 3.3 Refresh banner on status poll; help text points at docs (file bulk = future)

## 4. Docs

- [x] 4.1 Update `docs/export-bulk-sync.md`: queue-depth prompt + external import scenario; note file bulk transfer as follow-on
- [x] 4.2 Brief README / Status copy if needed

## 5. Verification

- [x] 5.1 Offline tests for detection + drain gate
- [ ] 5.2 Manual: seed/simulate pending ≥ 150 → Status notice → drain paused → Continue resumes; Match path works
