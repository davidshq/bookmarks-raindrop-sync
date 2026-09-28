## Why

Phase 3 made drain and reconcile share a per-wake header-driven budget, but heartbeat still hard-skips *all* new Raindrop listing when any Raindrop-bound queue job remains (`busy`). That mutex starves Trash / list / confirm while drain under-uses leftover spendable — the last open item from [`docs/sync-architecture-right-sizing.md`](../../docs/sync-architecture-right-sizing.md) phase 4.

## What Changes

- Remove the hard “any Raindrop-bound job ⇒ skip new reconcile cycle” gate on heartbeat.
- Keep tick order prefer-drain: first drain consumes spendable, then Trash / list / confirm run on leftover budget (and soft wakeCap), then second drain for jobs reconcile just enqueued.
- Keep settled quiet-time cooldown, in-progress cursor continue, bulk_pause, rate-limit pause, and Pull-now force semantics.
- Retire Status skip reason `busy` as *queue-contention deferral*; keep `busy` only for in-process reentrancy (“reconcile already running”). After Match / Continue drip, clear stale `bulk_pause` without inventing a busy skip when jobs remain.
- Update verify scripts, Status copy, and the right-sizing memo migration table (phase 4 done).

## Capabilities

### New Capabilities

<!-- none — behavior change within existing sync engine / Status -->

### Modified Capabilities

- `bookmark-sync-engine`: Replace traffic-aware busy-mutex deferral with ordered shared spendable; adjust skip-reason and bulk-resume refresh rules.
- `bidirectional-sync`: Drop the “busy-mutex unchanged” caveat; require leftover-budget Trash/list progress while queue work remains.
- `extension-config`: Status copy for `busy` means reentrancy only; queue depth is not a listing deferral banner.
- `queue-bulk-prompt`: After Match / Continue clears needs_choice, clear `bulk_pause` (do not stamp `busy` solely because jobs remain).

## Impact

- `src/lib/reconcile.js` — remove queue-busy gate for new cycles; comments / skip reasons.
- `src/lib/sync.js` — `refreshReconcileSkipAfterBulkResume` clears skip instead of noting `busy`.
- `src/lib/store.js` (+ Options/popup consumers) — `busy` copy / JSDoc.
- `scripts/verify-checklist.mjs` / `verify-bidirectional-logic.mjs` — replace busy-mutex expectations with ordered-share cases.
- `docs/sync-architecture-right-sizing.md` — phase 4 marked done.
- OpenSpec main specs synced via delta specs in this change.
