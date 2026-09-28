## Why

Emptying Raindrop Trash removes the soft-delete signal the extension uses for Raindrop→Edge deletes. Status “0 pending” only reflects the durable job queue — it does **not** say whether paired items still sit in Trash unseen. Users need a clear **safe to empty Trash** signal before they purge, without waiting for Edge catch-up to finish.

## What Changes

- Persist a small **trash hygiene snapshot** whenever Trash is listed (heartbeat reconcile finish or an explicit Check Trash): paired-in-trash count still needing enrollment, whether the trash scan completed or was truncated, and when it was last peeked.
- Surface that snapshot on **Options → Status** (bidirectional only) as a clear safe / waiting / unknown state. **Safe to empty** means discovery debt is clear (paired ∩ Trash enrolled or empty after a complete scan) — not that queued `delete-edge` jobs have drained.
- Add an optional **Check Trash** control on Status that forces a trash peek and refreshes the snapshot without requiring a full Pull now.
- Do **not** add this to the toolbar popup.
- Document the hazard and Status meaning alongside existing delete-detection notes.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `extension-config`: Options Status SHALL surface trash-safe state (and Check Trash) when bidirectional, so “safe to empty Raindrop Trash” is visible and actionable.
- `bookmark-sync-engine`: Reconcile trash listing SHALL update a durable trash-hygiene snapshot used by Status; incomplete peeks MUST NOT report safe-to-empty.
- `bidirectional-sync`: Clarify that emptying Trash early is unsafe until Status reports clear after a complete paired-trash scan (discovery debt, not apply debt).

## Impact

- `src/lib/reconcile-finish.js` — record trash hygiene after `finishTrashDeleteDetection`.
- `src/lib/store.js` (or reconcile state) — durable snapshot fields.
- `src/background/service-worker.js` — Status payload + optional Check Trash message.
- `src/options/options.html` / `options.js` — Status line + Check Trash (hidden in one-way).
- `docs/raindrop-delete-detection-options.md` (or short Status note) — safe-to-empty meaning.
- Verify / checklist coverage for safe vs partial vs waiting states.
- Toolbar popup unchanged.
