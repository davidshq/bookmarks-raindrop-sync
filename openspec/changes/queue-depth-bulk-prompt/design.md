## Context

`export-bulk-sync-lane` added Match existing + Import/Pull click gates. It does **not** observe an already-swollen queue from live `onCreated` storms (Edge HTML import) or reconcile pull-create bursts (Raindrop import). Status can show pending 1626 with no call to action.

Raindrop still has no true multi-create REST bulk; v1 remediation is Match (dedupe pairs / skip redundant uploads where URLs already exist) + continue adaptive drip. File-based bulk transfer is explicitly follow-on.

## Goals / Non-Goals

**Goals:**

- Detect pending ≥ threshold (default **150**, aligned with “offer bulk” band).
- Persist a prompt state so Options Status can show it after reload.
- User choices: **Match first**, **Keep dripping**, **Dismiss** (same as keep for v1, or snooze).
- While prompt is **pending user**, **pause drain** (and optionally skip starting new reconcile) so the stampede does not silently continue — user must acknowledge.
- After Match apply (or nothing to pair), clear prompt and resume drain.
- Reuse Match SW messages / `runMatchExisting*` flow.

**Non-Goals (v1):**

- Bulk HTML/CSV file transfer to/from Raindrop (follow-on OpenSpec).
- Popup-only UX without Options (nice-to-have).
- Auto-Match without confirmation.
- Changing adaptive `drainJobsCap` numbers (orthogonal).

## Decisions

### 1. Signal = durable queue size

**Decision:** Primary trigger: `queue.size() >= QUEUE_BULK_PENDING_THRESHOLD` (150). Optional secondary: ≥ N enqueues in the last 60s (burst) — implement if cheap; otherwise depth-only for v1.

**Why:** Depth is what the user sees on Status; burst helps catch the storm mid-import before depth settles.

### 2. Pause drain until acknowledged

**Decision:** When `bulkPrompt.status === 'needs_choice'`, `drain()` returns immediately (log once / coalesce). Heartbeat reconcile may still run or also skip — prefer **skip Raindrop-heavy work** while awaiting choice so we do not dig the hole deeper. Live `onCreated` may still enqueue (otherwise we drop user bookmarks); document that pending can keep rising until they open Options.

**Alternative:** Pause enqueue too — riskier (lost captures if SW logic errs). Defer.

### 3. Status UI is the home

**Decision:** Prominent Status callout: “Sync queue has ~N jobs (~ETA). Match from Raindrop export first, or continue dripping?” Buttons: Match / Continue drip. Manual Sync can show the same strip if Status is not visible.

**Why:** User already looks at pending there; no click on Import required.

### 4. Snooze / dismiss

**Decision:** “Continue drip” clears `needs_choice` and sets `snoozedUntil` or `snoozedBelow` so we do not re-prompt every minute while N stays high. Re-prompt if pending grows by another large step (e.g. +500) or after snooze expires (e.g. 24h) — keep v1 simple: snooze until pending drops below threshold/2, then arm again.

### 5. Follow-on bulk transfer

**Decision:** Document in this change’s design/docs as next OpenSpec: Edge→Netscape HTML download + instructions or Raindrop import API if any; Raindrop export→Edge bulk create. Prompt UI SHOULD reserve a disabled or “Coming soon” affordance only if it does not clutter — prefer docs link in help text for v1.

## Risks / Trade-offs

- **[Risk] Pause drain while Options closed** → Mitigation: activity log line; optional badge on extension icon later; pending keeps growing from live creates but no Raindrop writes until choice.
- **[Risk] Re-prompt spam** → Mitigation: snooze until depth drops.
- **[Risk] Match does not shrink upload queue for Edge-only URLs** → Mitigation: copy says Match helps overlaps; remainder still drips; ETA honest.
- **[Trade-off] File bulk deferred** → Prompt still valuable; transfer is the speed win later.

## Open Questions

- Badge on action icon when `needs_choice`? (Lean: yes if &lt;1h work)
- Pause enqueue during needs_choice? (Lean: no for v1)
