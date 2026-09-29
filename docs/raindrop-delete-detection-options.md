# Raindrop → Edge delete detection options

Notes from reviewing the Raindrop REST API against this extension’s bidirectional reconcile. Not a product spec — a decision memo for how we might detect remote deletes more efficiently than today’s capped per-id confirms.

See also: [`raindrop-api-best-practices.md`](./raindrop-api-best-practices.md) for general API usage rules.

> **Superseded (2026-09-28).** The confirm-GET / `seenAcc` / parking design
> described below was replaced by the export presence snapshot and
> evidence-based deletes — see [`sync-engine-rewrite.md`](./sync-engine-rewrite.md).
> Kept for history.

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

### Confirm catch-up (unsettled)

After a finished listing, pairs absent from `seenAcc` are confirm candidates. A soft per-finish confirm backstop (`MAX_ALIVE_CHECKS_PER_TICK`) may leave thousands deferred — logged as “postponed N missing-raindrop check(s)”.

While catch-up is **unsettled**, heartbeat:

1. Skips quiet-time cooldown.
2. **Keeps** the completed listing’s `seenAcc` as a presence snapshot.
3. Runs **confirm-only** wakes (Trash peek + confirm GETs + park) without re-listing the sync root — so almost all leftover spendable goes to shrinking the mountain.
4. Raises the soft confirm backstop to the wake cap for those wakes.

**Pull now** still forces a fresh nested list (clears the snapshot) so presence stays honest after allowlist/root changes. Safety is unchanged: confirm-before-delete, park out-of-scope alives, Trash for soft-deletes.

Math for ~4700 candidates: re-list-every-cycle wasted most of ~80 req/wake on pages; confirm-only can spend ~50–70 GETs/wake → roughly an hour of heartbeats, and parking permanently removes out-of-scope alives from the candidate set.

## Safe to empty Raindrop Trash (Status)

Emptying Trash removes the soft-delete signal. Options → Status (bidirectional) shows one short line:

| Status | Meaning | What to do |
|--------|---------|------------|
| **Safe to empty Raindrop Trash.** | Full Trash scan done; nothing paired left to enroll | Empty Trash if you want |
| **Don't empty… N still syncing** | Paired deletes still need enroll | Wait / Check Trash |
| **Still checking… click Continue.** | Scan not finished (large Trash or budget) | Click **Continue** (resumes; does not restart) |
| **Click Check Trash before…** | Never checked | Click **Check Trash** |

Heartbeat lists newest Trash for enroll but does **not** flip Status to “still checking” on a truncated pass. **Check Trash / Continue** is the complete-scan oracle and keeps a page cursor so each click advances.

**Discovery debt vs apply debt:** Safe means soft-deletes were *enrolled*. Queued Edge deletes may still finish afterward (normal Raindrop→Edge pending).


## Related implementation changes

- OpenSpec `trash-fast-path-delete-detection` — option A.
- OpenSpec `park-out-of-scope-alives` — option C (keep Edge + pair; durable `parkedAliveIds`).
- OpenSpec `trash-safe-status` — Status safe-to-empty + Check Trash.
