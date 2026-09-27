## Context

Bidirectional reconcile today confirms “missing from sync-root listing” with capped per-id `GET /raindrop/{id}`. Raindrop soft-deletes land in Trash (`-99`) first. Broader API/options analysis lives outside this change: [`docs/raindrop-delete-detection-options.md`](../../../docs/raindrop-delete-detection-options.md).

## Goals / Non-Goals

**Goals:**

- Detect typical Raindrop soft-deletes via **Trash listing** so paired Edge bookmarks are removed quickly without waiting on the rotating confirm window.
- Keep fail-soft behavior: do not false-delete Edge bookmarks for alive raindrops.
- Stay within existing rate-limit pause / page-budget posture.

**Non-Goals:**

- Other delete-detection strategies from the options doc (trust listing, park out-of-scope, `collectionId=0`, `lastUpdate`, export).
- Changing Edge→Raindrop delete behavior (already soft-deletes into Trash).

## Decisions

### D1 — Trash listing as primary soft-delete signal

**Choice:** On reconcile finish (after the scoped listing phase completes for that cycle), list Trash and enqueue `delete-edge` for each trash item id that still has a pair (and is not already tombstoned / queued).

**Why keep confirm GET:** Emptied trash and permanent deletes never appear in `-99`. Out-of-scope alives must not become Edge deletes. Confirm path remains the safety net (capped, rotating).

### D2 — List pages from 0 each finish, not per-id GET

**Choice:** Reuse `listRaindrops(-99, { page, perPage })` with a small dedicated page cap (`MAX_TRASH_PAGES_PER_TICK`). Always start at page 0 so recent soft-deletes (default `-created` sort) are preferred. No durable trash cursor — overflow beyond the cap falls through to confirm-GET.

**Why:** Intersection with `pairs.byRaindrop` is local and cheap; a forward cursor would starve newest Trash while scanning an old bin.

### D3 — Interaction with missing-from-listing confirms

**Choice:** After trash-driven enqueues, remaining candidates still go through capped confirm GETs (tombstone prune shares that budget). Skip confirm for ids already handled via trash this cycle.

### D4 — Trash is delete-detection only

**Choice:** Never pull-create or pull-update from `-99`.

## Risks / Trade-offs

- **[Risk] Trash emptied before we list** → Mitigation: retain capped confirm GET.
- **[Risk] Large Trash bin burns page budget** → Mitigation: bounded pages/tick from page 0; ignore unpaired trash ids; confirm-GET covers overflow.
- **[Risk] “Postpone N checks” log remains** → Expected if N is mostly out-of-scope alives; see options doc (park out-of-scope), not more trash paging.
- **[Risk] False delete** → Mitigation: only delete when id ∈ pairs; same guards as today’s `delete-edge` drain.
- **[Trade-off] Extra list calls on every completed reconcile** → Acceptable vs N single GETs.

## Migration Plan

- No storage schema migration.
- Roll forward: deploy; next completed reconcile lists trash from page 0.
- Rollback: remove trash pass; confirm-GET path unchanged.

## Open Questions

1. Should trash listing run only on **completed** scoped cycles, or also on a cheap heartbeat when cooldown would skip full listing? (Lean: finish only for v1.)
