## 1. Durable trash hygiene snapshot

- [x] 1.1 Extend reconcile state defaults with `trashHygieneAt`, `trashScanComplete`, `trashPairedPending` (and optional `trashHygieneSource`)
- [x] 1.2 After `finishTrashDeleteDetection` (and any Check Trash peek), write the snapshot: complete vs truncated, paired-needing-enroll count (skip tombstoned + already-queued `delete-edge`), peek timestamp
- [x] 1.3 Export a small helper to derive Status display state (`safe` | `waiting` | `partial` | `unknown`) from the snapshot — never `safe` unless scan complete and pending 0

## 2. Check Trash + Status wiring

- [x] 2.1 Add background message / handler for Check Trash: Trash-only peek under wake budget + rate-limit gates; reuse trash detection + snapshot writer (no full nested reconcile)
- [x] 2.2 Include trash hygiene fields (or derived state) in the Options Status `getStatus`-style response
- [x] 2.3 Options Status UI: line for safe / waiting / partial / unknown + last peek time; **Check Trash** button; hide in one-way; leave toolbar popup unchanged

## 3. Docs and verification

- [x] 3.1 Document safe-to-empty (discovery debt vs apply debt) in `docs/raindrop-delete-detection-options.md` or a short Status note linked from it
- [x] 3.2 Verify coverage: complete clear → safe; paired pending → waiting; truncated peek → not safe; Check Trash refreshes snapshot; one-way hides control
