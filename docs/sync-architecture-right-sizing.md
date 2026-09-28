# Sync architecture: right-sizing throughput

Decision memo. Describes **why** the current engine feels slow, **where** the
15‑minute wait and job caps live, what the **right** architecture is, and what
to **eliminate**. Not a patch list — a target model.

Related: [`raindrop-api-best-practices.md`](./raindrop-api-best-practices.md),
[`export-bulk-sync.md`](./export-bulk-sync.md),
[`raindrop-delete-detection-options.md`](./raindrop-delete-detection-options.md).

**Status:** Direction **approved with conditions** by an internal panel
(2026-09-27). See [Panel review](#panel-review). Conditions below are part of
the contract, not optional polish.

---

## Short answers

### Why do we wait 15 minutes?

Because heartbeat **refuses to start a new Raindrop listing** until
`config.reconcileIntervalMinutes` has elapsed since the last **completed**
cycle, when the queue is idle. Default is **15**. That is a product/config
choice we made to “be polite,” not a Raindrop API requirement.

| What | Where |
|------|--------|
| Default (historical `15`; now `1`) | `src/lib/constants.js` → `DEFAULT_RECONCILE_INTERVAL_MINUTES` |
| Stored on config | `DEFAULT_CONFIG.reconcileIntervalMinutes` |
| Clamp `[1, 60]` | `src/lib/store.js` → `clampReconcileIntervalMinutes` |
| Options UI | `src/options/options.html` → `#reconcileIntervalMinutes` (presets 1/2/5/15/30/60) |
| Enforced | `src/lib/reconcile.js` → `reconcileOnce`: if `!force && !inProgress` and `Date.now() - lastRunAt < reconcileIntervalMs(config)` → skip `reason: "cooldown"` |
| Heartbeat uses cooldown | `src/lib/sync.js` → `tick()` calls `reconcile({ force: false })` |
| Bypass | Options/popup **Pull now** → `reconcileNow()` → `reconcile({ force: true })` |

Historical note: OpenSpec change `adaptive-reconcile-interval` (2026-09-27)
turned a hard-coded 15‑minute constant into a configurable field and **kept
default 15**. It also added “skip new cycle while any Raindrop-bound job is
queued” (`busy`). Intent was: avoid listing while uploads use quota; let users
who want faster polls pick 1–5 minutes. Side effect with unfinished confirm
backlogs: a finished cycle with thousands of postponed checks still stamps
`lastRunAt` and then sits on cooldown — Status shows “0 pending” while catch-up
is stalled.

**Raindrop does not require a 15‑minute gap.** The API budget is ~**120
requests/minute**. The 15‑minute gap is entirely ours.

### Why leave most of the API limit on the table?

Because work is gated by **fixed per-heartbeat caps** and **mutual exclusion**,
not by `X-RateLimit-Remaining`:

| Gate | Constant / behavior | Typical use of ~120/min |
|------|---------------------|-------------------------|
| Drain (small queue) | `MAX_JOBS_PER_DRAIN = 25` | ~20% |
| Drain (pending ≥ 100) | `MAX_JOBS_PER_DRAIN_BUSY = 55` | ~45% |
| Reconcile list pages | `MAX_RECONCILE_PAGES_PER_TICK = 5` (+ trash ≤ 3) | small |
| Confirm GETs | `MAX_ALIVE_CHECKS_PER_TICK = 8` **per finished cycle** | tiny average once cooldown applies |
| Proactive stop | `RATE_LIMIT_RESERVE = 4` | stop when remaining ≤ 4 |
| Queue busy | any Raindrop-bound job → **no new reconcile** | listing idle while drain drips |
| Quiet cooldown | default 15 min between **completed** cycles | long idle with unused quota |

We already read rate-limit headers in `RaindropClient` and pause on low remaining
/ 429. We do **not** size drain/reconcile to “use remaining quota this wake.”
Caps were added as crude politeness; they became the real throttle.

The activity log line “postponed N … (rate-limit budget)” is often **lying by
naming**: N is usually leftover after our **8 GET** cap, not after Raindrop
exhausted the minute.

---

## Current architecture (what we encoded)

```
MV3 alarm every 1 min
        │
        ▼
   drain ≤ 25 or 55 jobs  ──────────────►  Raindrop writes / pulls
        │
        ▼
   reconcile? ── busy? ──► skip (queue still has Raindrop work)
        │         cooldown? ──► skip (default 15 min since lastRunAt)
        │         bulk_pause? ──► skip
        ▼
   list ≤ 5 pages (+ trash ≤ 3)
        │
        ▼ (only when listing cycle completes)
   confirm GET ≤ 8 candidates
        │
        ▼
   lastRunAt = now  →  next new cycle waits quiet interval
```

**One serial drip** serves:

1. Day-to-day live sync  
2. Large import / move / delete storms  
3. Forever delete-candidate rotation (scope mismatches)

That is the corner. Caps and cooldowns that are fine for (1) destroy (2) and (3).

---

## Right architecture

### Principle

> **Live sync stays polite. Catch-up uses different algorithms. Each MV3 wake
> spends available Raindrop quota until headers (or a soft wake cap) say stop.
> Unfinished work never looks like “idle cooldown.” Settled idle does not
> max out the API.**

### Lane model

| Lane | Purpose | Mechanism | SLO (target) |
|------|---------|-----------|--------------|
| **A — Live** | Few creates/edits/deletes | Event enqueue + short/debounced opportunistic drain; heartbeat may burn a larger spendable slice; cheap Trash peek when bidirectional | Edge→Raindrop: seconds–couple minutes; Raindrop→Edge when idle: about one heartbeat–few minutes |
| **B — Bulk / repair** | Thin pairs, HTML import storms, large reorg | Detect → ask → export Match / guided plan → then resume A ([`export-bulk-sync.md`](./export-bulk-sync.md)) | User-gated; not silent drip for an hour |
| **C — Presence** | “Is this raindrop gone or out of scope?” | Trash list (soft-delete); **park** out-of-scope alives; rare full-library / export presence — **not** infinite per-id GET rotation ([`raindrop-delete-detection-options.md`](./raindrop-delete-detection-options.md)) | Postponed confirm count falls; real deletes via Trash quickly |

Lane A must not be the execution engine for B or C.

### Budget model (headers + soft wake caps)

MV3 reality: the service worker is **ephemeral**. `chrome.alarms` wakes about
once a minute; idle kill is ~30s after the last awaited work. You cannot run a
continuous “fill the wall-clock minute” loop. Promise **per wake**, not per
calendar minute.

```
Each wake (heartbeat tick, or coalesced Drain-now; NOT every bookmark event):

  if rateLimitedUntil > now: note skip; return

  load persisted { remaining?, resetAt? } if fresh for this window
  if remaining unknown / stale:
      spendable = BOOTSTRAP_REQS          # small, e.g. 4–8 — never “be bold”
  else:
      spendable = max(0, remaining - RESERVE)

  wakeCap = soft max requests and/or wall-clock for this wake
  # headers = API brake; wakeCap = SW lifetime / storage / overlap guard

  order while spendable > 0 and under wakeCap:
    1. Prefer drain due jobs (reserve ≥ worst-case nested calls per job)
    2. Bidirectional + !bulk_pause: Trash peek (cheap presence)
    3. If in progress OR unsettled OR quiet_interval_elapsed:
         list / confirm slices with leftover spendable
       else if settled: do NOT full nested-list just to burn quota

  after every response: refresh Remaining/Reset; recompute spendable
  stop on: auth halt, rateLimitedUntil, remaining ≤ RESERVE, or wakeCap
  persist remaining/reset + coalesce “drain requested” if reentrancy skipped work
```

Rules:

- **`X-RateLimit-Remaining` is the API throttle.** Fixed `25` / `55` / `8` must
  not be the *primary* throttle once header-driven budgeting ships — but a
  **soft per-wake cap stays** as an MV3 / fairness backstop.  
- **Cold start is conservative.** Never “unknown → be bold.” Bootstrap small,
  then follow headers. Prefer persisting remaining + reset across SW restarts;
  assume the token bucket is **shared** (app / other clients).  
- **Share spendable this wake**; do not mutex “entire reconcile off while one
  upload remains” when spendable is left. Ordering: prefer drain, still leave a
  slice for Trash / small list.  
- **Event path ≠ heartbeat path.** Live bookmark handlers enqueue + short
  opportunistic drain; only heartbeat / manual Drain-now may burn a large
  spendable slice.  
- **Cooldown means “library looked settled.”** It must **not** apply when:
  - unparked confirm candidates remain,
  - reconcile cursor / `seenAcc` is mid-flight (already true today),
  - or deferred finish work was logged this cycle.  
- **Settled idle ≠ fill the quota.** Shorter default quiet (1–2 min / every
  heartbeat) is for Trash peek and cheap presence — **not** maxing nested list
  + confirms every minute when nothing is wrong.  
- Default quiet interval for a *settled* library stays user-configurable;
  default should be **1** (alarm floor), not 15.

### Presence model (Lane C)

1. **Trash fast path** — keep (soft-deletes).  
2. **Park out-of-scope alives** — ship (`park-out-of-scope-alives`); stop
   re-candidating forever-alives.  
3. **Confirm GET** — only for ambiguous absences; per-wake budget follows
   spendable inside wakeCap — not a magic 8 that resets after a long cooldown.
   While unsettled, retain the finished listing’s `seenAcc` and run
   **confirm-only** wakes (no nested re-list) so catch-up spends quota on
   probes/parks instead of re-paging the library every minute.  
4. Optional later: occasional `collectionId=0` or export presence if hard-delete
   latency matters. Export stays **user-gated Lane B**, not heartbeat.

### Status honesty

Surface separately:

- Queue depth + drip ETA (Edge→RD vs RD→Edge)  
- Next reconcile eligibility (busy / cooldown / rate-limited / bulk_pause)  
- Confirm-candidate count vs parked count  
- Whether we are **rate-limited by Raindrop** vs **self-capped** (wakeCap /
  bootstrap)

Never call an internal GET cap “rate-limit budget” unless
`rateLimitedUntil` or remaining ≤ reserve actually fired.

Composite Status lie that must be impossible (or scream “unsettled catch-up”):
**0 pending + cooldown + postponed thousands.**

---

## What to eliminate

### Eliminate (behavior / concepts)

| Eliminate | Why |
|-----------|-----|
| **Default 15‑minute quiet cooldown as the normal bidirectional cadence** | Not an API constraint; makes idle installs feel dead; stacks with unfinished confirm work |
| **Applying quiet cooldown after a cycle that left deferred confirms / remediation** | “0 pending + cooldown + postponed 5k” is a broken product state |
| **Fixed `MAX_JOBS_PER_DRAIN` / `_BUSY` as the *primary* throttle** | Leaves most of ~120/min unused; replace primacy with spendable-from-headers (soft wake cap remains) |
| **Fixed `MAX_ALIVE_CHECKS_PER_TICK = 8` as the *primary* confirm throttle** | Same; especially toxic combined with long cooldown |
| **Hard “any Raindrop-bound job ⇒ skip all new reconcile”** | Starves discovery while drain under-uses quota; replace with ordered shared spendable |
| **Per-id confirm GET as the strategy for thousands of forever-candidates** | Wrong algorithm; park (C) or presence oracle — don’t rotate forever |
| **Log copy that blames “rate-limit budget” for internal caps** | Trains users (and us) to misdiagnose |
| **Using Lane A drip as silent remediation for bulk storms** | Bulk pause + Match exists; strengthen “must not drip 1k jobs unnoticed” |
| **“Unknown remaining → be bold” / continuous fill-the-minute loops** | Unsafe cold starts; not how MV3 wakes work; rejected by panel |

### Keep

| Keep | Why |
|------|-----|
| Durable queue + pair map + tombstones | Crash-safe sync core |
| Heartbeat alarm (1 min) | MV3 wake; fine as the tick |
| Hard `rateLimitedUntil` on 429 / remaining ≤ reserve | Real API protection |
| Soft per-wake request / wall-clock cap | SW lifetime, storage churn, overlap — not the API law |
| Confirm-before-act / no cascade delete | Safety invariant |
| Trash fast path | Correct cheap soft-delete signal |
| Export Match bulk lane (B) | Right tool for thin pairs / import storms |
| Pull now | Explicit force past idle policy |
| User-configurable quiet interval **for settled idle** | Power users; default must change |

### Reinterpret (don’t delete the knob — change the meaning)

| Knob | Today | Should mean |
|------|--------|-------------|
| `reconcileIntervalMinutes` | Gap after **every** completed cycle when queue empty | Gap only when last cycle was **settled**. Default **1**, not 15 |
| `RATE_LIMIT_RESERVE` | Early stop | Keep; size ≥ worst-case nested Raindrop calls in one job |
| `MAX_JOBS_PER_DRAIN*` / page / alive caps | Primary throttle | Soft **wakeCap** / fairness backstop under spendable; not the story users feel as “rate limited” |
| Quiet cooldown | Politeness after any finish | Settled-idle only; unsettled keeps waking every heartbeat until catch-up parks or finishes |

---

## Target tick (sketch)

```
# Heartbeat / Drain-now only (bookmark handlers: enqueue + short drain)

tick():
  if rateLimitedUntil > now: note skip; return

  client = RaindropClient(token)
  remaining, resetAt = loadPersistedRateWindow() or client after first call
  if remaining is unknown or window stale:
    spendable = BOOTSTRAP_REQS          # small; never unbounded
  else:
    spendable = max(0, remaining - RESERVE)

  wakeCap = SOFT_MAX_REQS_PER_WAKE      # and/or wall-clock

  drainSlice(client, min(spendable, wakeCap, prefer=drain))
  # after each response: update headers, spendable, persist window

  if bidirectional && !bulk_pause && spendable > 0 && under wakeCap:
    trashPeek(client)                   # cheap presence; prefer over confirms
    if inProgress OR unsettled OR quiet_interval_elapsed(lastSettledAt):
      listAndConfirmSlice(client)       # spendable-limited; park out-of-scope
    # settled + quiet: do not full nested-list to burn quota

  if cycle finished && unsettled: do NOT arm quiet cooldown
  if cycle finished && settled: lastSettledAt = now

  if jobs enqueued && spendable left && under wakeCap:
    drainSlice again

  if reentrancy skipped a wake: set durable drainRequested for next opportunity
```

Exact APIs land via OpenSpec; this sketch is the contract after panel conditions.

---

## Migration / change sequence (recommended)

Ship for user-visible win first; rewrite throttles only after rails exist.

| Phase | Work | Notes |
|-------|------|--------|
| **1** | **Park out-of-scope alives** | Done (`park-out-of-scope-alives`) |
| **2** | **Cooldown only when settled** + **default interval → 1 minute** | Done (`right-size-reconcile-cadence`) |
| **5** | **Rename/fix Status + log strings** | Done with phase 3 (`lastThrottle` self-cap vs `rateLimitedUntil`; honest postpone/cooldown copy from phase 2) |
| **3** | **Budget-driven drain/reconcile** | Done (`budget-driven-drain-reconcile`) — headers primary; soft wakeCap + bootstrap; persist rate window |
| **4** | **Replace busy mutex with ordered shared spendable** | Done (`ordered-shared-spendable`) — prefer drain; leftover funds Trash/list; `busy` = reentrancy only |
| **6** | **Harden bulk lane** | Large queues must not silently drip (mostly done) |

Do **not** “fix slowness” by only raising 25→80 or 8→40 while keeping 15‑minute
cooldown and forever-candidates. That is more of the same corner — and is an
explicit reject criterion for architecture review.

---

## Acceptance tests (architecture-level)

An install is “right-sized” when:

1. **Idle bidirectional, settled library:** a Raindrop soft-delete appears as an
   Edge delete within a small number of heartbeats (Trash path), not after a
   15‑minute nap.  
2. **Under load (heartbeat / Drain-now):** a wake consumes most *available*
   remaining quota until reserve or soft wakeCap; Status distinguishes
   “using Raindrop budget” vs “paused until …” vs “wake capped.”  
3. **Scope mismatch:** postponed confirm count falls monotonically as ids park;
   it does not hover at thousands forever.  
4. **Bulk:** pending ≥ threshold pauses for Match/Continue; user is not stuck
   watching a slow drip for an hour with no explanation.  
5. **Pull now** remains an explicit force, not the only way to get a check within
   a quarter hour.  
6. **Composite Status lie:** `0 pending` + `cooldown` + large postponed confirms
   cannot present as idle quiet-time (must be unsettled catch-up or continue
   every heartbeat).  
7. **Settled oracle:** deferred confirms / mid-flight cursor / deferred finish ⇒
   quiet cooldown does **not** arm.  
8. **Lane separation:** while B is `needs_choice`, A does not silently execute
   bulk remediation; C parking does not starve Trash soft-delete fairness.  
9. **Safety under speed-up:** no duplicate Edge creates from list∩upload races;
   alive / out-of-scope never becomes `delete-edge`; confirm-before-act holds
   across larger partial wakes + SW death.  
10. **Edge→Raindrop SLO (Lane A):** a single local bookmark create reaches
    Raindrop within a small number of heartbeats when not rate-limited and not
    bulk-paused.

---

## Panel review

Internal multi-persona review of this memo (2026-09-27). All five seats:
**Approve with conditions** (confidence 4/5 each). No reject.

| Seat | Vote |
|------|------|
| Pragmatic engineer | Approve w/ conditions |
| Web extension (MV3) | Approve w/ conditions |
| Raindrop API / product | Approve w/ conditions |
| HTTP rate-limit systems | Approve w/ conditions |
| Sync / QA product | Approve w/ conditions |

### What the panel endorsed

- Diagnosis: 15‑min cooldown, fixed 25/55/8, busy mutex, and misleading
  “rate-limit budget” logs are self-inflicted.  
- Lane A / B / C split; park forever-alives before raising confirm throughput.  
- Headers + small reserve as the real API brake; hard `rateLimitedUntil` on 429.  
- Cooldown only when settled; default quiet → alarm floor (1 min).  
- Status honesty: Raindrop pause vs self-cap; composite idle lie must die.

### Conditions folded into this memo

1. **Per-wake, not per wall-clock minute** — MV3 cannot hold a continuous filler.  
2. **Soft SW/work wakeCap remains** even when spendable > 0.  
3. **Never “be bold” on unknown Remaining** — bootstrap small; persist window.  
4. **Settled idle ≠ full nested list every minute.**  
5. **Ship park + settled cooldown + Status honesty before ripping primary caps.**  
6. **Ordered share instead of busy mutex** — prefer drain; leave Trash/list slice.  
7. **Event path short; heartbeat/Drain-now may burn larger slices.**  
8. **Coalesce skipped drains** when in-memory reentrancy no-ops.  
9. **Reserve ≥ worst-case nested calls in one job**; re-read headers every response.  
10. **Safety ATs** for dupes, wrong deletes, and the composite Status lie.

### Explicitly rejected phrasing (do not reintroduce)

- “Continuous pass while SW is awake” as a scheduler  
- “Unknown → be bold until header”  
- “Fill the API minute” as an SLO without wakeCap  
- Raising fixed caps alone while keeping 15‑min cooldown + forever-candidates  

---

## Document history

- 2026-09-27 — Initial memo after reviewing cooldown/caps vs ~120 req/min and
  multi-day Status symptoms (quiet cooldown + postponed thousands + drain paused
  at 25).  
- 2026-09-27 — Panel review (5× approve with conditions). Tightened principle,
  budget model, target tick, migration order (1→2→5 then 3→4), acceptance
  tests, and eliminate list; added this section.
- 2026-09-27 — Phases **2** + partial **5** implemented in OpenSpec change
  `right-size-reconcile-cadence` (`lastSettledAt` / `unsettledConfirmCatchUp`,
  default interval 1, honest postpone + cooldown copy).
- 2026-09-27 — Phase **3** + remaining **5** implemented in OpenSpec change
  `budget-driven-drain-reconcile` (per-wake `WakeBudget`, persist rate window,
  demote fixed 25/55/8 primacy, Status `lastThrottle` vs Raindrop pause).
- 2026-09-27 — Phase **4** implemented in OpenSpec change
  `ordered-shared-spendable` (drop queue-busy gate; prefer-drain + leftover
  spendable for Trash/list; Status `busy` = reentrancy only).
