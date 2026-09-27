# Raindrop → Edge delete detection options

Notes from reviewing the Raindrop REST API against this extension’s bidirectional reconcile. Not a product spec — a decision memo for how we might detect remote deletes more efficiently than today’s capped per-id confirms.

## Current behavior

Reconcile:

1. Lists raindrops under the sync root (`nested=true`), optionally outside-root allowlist collections.
2. Builds `seenAcc` from that listing.
3. Treats every pair **not** in `seenAcc` as a delete candidate.
4. Confirms with `GET /raindrop/{id}` (≤ 8/tick), sharing budget with tombstone prune.

That is safe but expensive. Logs like “postponed N missing-raindrop check(s)” usually mean a large candidate set, not N pending deletes. Many candidates can be **alive outside the sync listing** (moved out of root, allowlist cleared, etc.). Option **C** parks those after confirm GET so they stop regenerating the backlog.

## Raindrop API constraints

| Fact | Implication |
|------|-------------|
| Soft-delete → Trash (`-99`); second delete / empty trash → gone | Trash is a strong soft-delete signal |
| List pages max 50; `collectionId=0` = all except trash | Presence is page-based, not bulk-by-id |
| `ids` on update/remove only — **no** official bulk GET-by-ids | Per-id GET does not scale |
| `search=lastUpdate:>…` | Good for creates/edits, **not** deletes |
| Export (`…/export.csv` etc.) | Occasional full dump, awkward for heartbeat |
| **120 req/min** | Listing and confirms compete with uploads |
| No changelog / webhooks | Must poll |

## Options

| # | Option | What it uses | Catches well | Misses / cost |
|---|--------|--------------|--------------|---------------|
| **A** | **Trash fast path** | `GET /raindrops/-99` (paginated) | Soft-deletes still in Trash (~99% of typical remote deletes) | Emptied trash / hard delete; out-of-scope alives (never in trash) |
| B | Trust complete scoped listing | After root (+ outside) paging done, absent ⇒ delete without GET | In-scope true deletes | Risky if listing incomplete; still leaves out-of-scope candidates |
| **C** | Park out-of-scope alives (**implemented**) | After GET says alive + collection outside sync/allowlist, stop re-candidating; keep Edge + pair; unpark when listed again | Stops the “postpone N forever” tax | Hard-delete while parked may linger until Trash/other presence; see change `park-out-of-scope-alives` |
| D | Occasional `collectionId=0` | Full-library list as presence oracle | Account-wide gone/alive | Heavier ticks (`ceil(N/50)` pages) |
| E | `lastUpdate` search | `search=lastUpdate:>since` on list | Creates/edits | **Not deletes** (gone ids do not appear) |
| F | Export dump | `…/export.csv` etc. | Bulk lane presence / Match existing (record pairs); rare full rebuild | No collection path in CSV; awkward for heartbeat; see `docs/export-bulk-sync.md` |
| G | Status quo (GET confirms only) | `GET /raindrop/{id}` | Definite gone/trash/404 | O(candidates) over many cycles; fights upload budget |

```
User soft-deletes in Raindrop
        │
        ▼
   ┌─────────┐   list -99    ┌────────────┐
   │  Trash  │ ────────────► │ delete-edge│   ← Option A
   └─────────┘               └────────────┘
        │ empty trash
        ▼
     404 / absent ── fallback confirm / listing (B/D/G)

Raindrop moved out of sync tree
        │
        ▼
   still alive, not in trash
        │
        ▼
   park (keep Edge + pair) ── Option C (implemented)
```

## Recommended sequence

1. **A — Trash fast path** (**done**): list Trash on reconcile finish; enqueue `delete-edge` for paired ids; keep confirm GET as fallback.
2. **C — Park out-of-scope alives** (**done**): after confirm GET, park living pairs outside sync root / allowlist so they stop re-candidating; keep Edge + pair; Trash still covers soft-deletes.
3. **B and/or D** if hard-delete / emptied-trash latency matters.
4. **E** as a separate pull (create/update) optimization — not a delete strategy.
5. **F** as the opt-in **bulk lane** (Match existing / future plan modes) — not heartbeat.

## Working assumption

Trash listing should capture the vast majority of real “user deleted in Raindrop” cases. The leftover confirm backlog is a different problem (scope mismatch), addressed by parking (C).

## Related implementation changes

- OpenSpec `trash-fast-path-delete-detection` — option A.
- OpenSpec `park-out-of-scope-alives` — option C (keep Edge + pair; durable `parkedAliveIds`).
