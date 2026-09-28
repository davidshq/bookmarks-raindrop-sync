## Context

Bidirectional sync discovers Raindrop soft-deletes primarily by listing Trash (`-99`) on reconcile finish (`finishTrashDeleteDetection`), then enqueues `delete-edge`. Emptying Raindrop Trash before that pass removes the fast-path signal. Options Status today shows durable queue depth (“Pending”) and Raindrop→Edge / Edge→Raindrop splits — that is **apply debt**, not **discovery debt** (paired items still in Trash that have not been enrolled). Panel consensus (explore, 2026-09-28): expose **safe to empty Trash** only; Options Status only; optional Check Trash; no toolbar popup.

Related: [`docs/raindrop-delete-detection-options.md`](../../../docs/raindrop-delete-detection-options.md), trash fast path + right-sizing Status honesty.

## Goals / Non-Goals

**Goals:**

- Durable trash-hygiene snapshot after each trash list pass.
- Status (bidirectional) shows clear / waiting / unknown for **safe to empty Trash**.
- **Clear** only when a **complete** trash scan found zero paired ids still needing enrollment (not yet tombstoned and not already covered by an enqueued `delete-edge` for that raindrop — prefer counting “still in trash ∩ pairs needing enroll” at peek time; after enroll, they may still sit in Trash until the user empties).
- Check Trash forces a trash peek + snapshot refresh without a full Pull now.
- Incomplete / truncated peeks MUST NOT show clear.

**Non-Goals:**

- “Edge catch-up finished” / requiring `delete-edge` drain before clear.
- Toolbar popup surfacing.
- Blocking the Raindrop web UI from emptying Trash (warn only).
- Full-trash scan on every Status paint.
- Changing delete detection itself (still trash fast path + confirm GET).
- One-way mode UI (hidden / N/A).

## Decisions

### D1 — Oracle: discovery debt only

**Choice:** Safe-to-empty ⇔ last peek was a **complete** scan of Trash and `pairedNeedingEnroll === 0`, where needing enroll means: id ∈ pairs, not tombstoned, and no in-flight / queued `delete-edge` (or equivalent “already handled this peek”) for that id.

**Rationale:** Once enrolled, emptying Trash is safe for discovery; local apply can finish from the queue. User asked explicitly for safe-to-empty, not catch-up-finished.

**Alternative rejected:** Require zero Raindrop→Edge pending — conflates layers and delays “you may empty Trash” unnecessarily.

### D2 — Persist snapshot on reconcile state

**Choice:** Extend `getReconcileState` / `setReconcileState` with fields such as:

| Field | Meaning |
|-------|---------|
| `trashHygieneAt` | Epoch ms of last trash peek |
| `trashScanComplete` | `true` if listing reached end within page/budget caps |
| `trashPairedPending` | Count of paired-in-trash still needing enroll at peek |
| `trashHygieneSource` | `"reconcile"` \| `"check-trash"` (optional, for Status hint) |

Derive Status display state in the Status payload / options renderer — do not invent a second storage key unless needed.

**Alternative rejected:** Recompute by listing Trash on every `getStatus` — burns rate limit; MV3 Status open would thrash.

### D3 — Incomplete scan ⇒ not clear

**Choice:** If the pass stops early (`MAX_TRASH_PAGES_PER_TICK` / wake budget), set `trashScanComplete: false` and Status shows **waiting / partial** (e.g. “Trash deeper than we peeked — Check Trash or wait for more heartbeats”), never “safe to empty.”

**Rationale:** Page-0 newest-first can miss older paired deletes past the page cap; claiming clear would be another Status lie.

### D4 — Check Trash = trash-only peek

**Choice:** Background message runs the existing trash delete-detection path (list `-99`, enqueue, update snapshot) under wake budget / rate-limit gates, without forcing a full nested root reconcile. Prefer reusing `finishTrashDeleteDetection` (+ snapshot write) over duplicating list logic.

**Why not full Pull now:** User intent is “am I clear to empty?”; Pull now is heavier and already exists.

### D5 — Status surface only

**Choice:** Options → Status line + Check Trash button when `syncMode === bidirectional`. Toolbar popup unchanged.

### D6 — Unknown when never peeked / one-way

**Choice:** Missing snapshot or one-way ⇒ do not claim safe. Bidirectional with no peek yet ⇒ “unknown — Check Trash or wait for a Raindrop check.”

## Risks / Trade-offs

- **[Risk] Stale clear between peeks** (user soft-deletes after last complete clear) → Mitigation: show last peek time; Check Trash; heartbeat trash peeks refresh snapshot; copy: “as of last Trash check.”
- **[Risk] Truncated scan false confidence** → Mitigation: D3 — never clear unless complete.
- **[Risk] Check Trash fights upload budget** → Mitigation: same rate-limit / wake budget as reconcile trash; surface pause if deferred.
- **[Risk] Counting “needing enroll” wrong (double-count tombstoned)** → Mitigation: skip tombstoned and already-queued `delete-edge` ids when tallying `trashPairedPending`.
- **[Trade-off] Snapshot lag vs live Raindrop Trash** → Acceptable; we cannot subscribe to Raindrop UI empties.

## Migration Plan

- New reconcile-state fields default to “no peek” (unknown) — no breaking migration.
- Roll forward: next trash pass writes snapshot; Status lights up.
- Rollback: ignore/hide Status fields; trash delete path unchanged.

## Open Questions

- (none blocking) Exact Status copy strings can be finalized in implementation to match existing muted status-line tone.
