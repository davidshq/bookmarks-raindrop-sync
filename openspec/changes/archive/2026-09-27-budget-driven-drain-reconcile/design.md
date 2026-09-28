## Context

Phases 1–2 of [`docs/sync-architecture-right-sizing.md`](../../../docs/sync-architecture-right-sizing.md) shipped: park out-of-scope alives, settled-only cooldown, default quiet interval 1. Heartbeat still sizes drain/reconcile with fixed caps (`MAX_JOBS_PER_DRAIN` 25/55, `MAX_ALIVE_CHECKS_PER_TICK` 8, page/trash caps) while `RaindropClient` already reads `X-RateLimit-Remaining` / Reset and throws proactive `RateLimitError` at reserve. Caps became the real throttle; ~120/min stays mostly unused. This change is phase 3 (+ remaining phase-5 Status honesty for self-cap vs Raindrop pause). Phase 4 (drop busy mutex for ordered shared spendable) stays separate.

MV3 constraint: service worker is ephemeral; `chrome.alarms` ~1/min. Budget is **per wake**, not a continuous fill-the-calendar-minute loop.

## Goals / Non-Goals

**Goals:**

- Primary throttle = spendable from headers (`remaining - RESERVE`), refreshed after every response.
- Soft **wakeCap** (max requests and/or wall-clock) as MV3/fairness backstop, not the API law.
- Cold / stale remaining → small **bootstrap** spendable; never unbounded.
- Persist `{ remaining, resetAt }` across SW restarts for the current rate window.
- Drain + reconcile list/Trash/confirm slices honor the same wake budget on heartbeat / Drain-now / Pull now.
- Status/log distinguish Raindrop pause (`rateLimitedUntil`) from self-cap stop (wakeCap / bootstrap exhausted).
- Fixed 25/55/8 become secondary backstops under spendable (or fold into wakeCap constants).

**Non-Goals:**

- Replacing busy mutex so listing runs while Raindrop-bound jobs remain (phase 4).
- Continuous “fill the wall-clock minute” while SW is awake.
- Settled idle maxing nested list every heartbeat (quiet cooldown still applies when settled).
- Changing confirm-before-act, park semantics, Trash fast path, bulk pause, or export Match.
- Opportunistic live handlers burning large spendable (event path stays short; only heartbeat / Drain-now / Pull now may use full wake budget).

## Decisions

### D1 — Shared `WakeBudget` object per tick

**Choice:** Introduce a small helper (e.g. `src/lib/wake-budget.js`) owned by `tick` / `reconcileNow` / drain entry:

```
loadPersistedRateWindow()
if remaining unknown or resetAt ≤ now (stale window):
  spendable = BOOTSTRAP_REQS   # e.g. 6
else:
  spendable = max(0, remaining - RATE_LIMIT_RESERVE)

wakeCapReqs = SOFT_MAX_REQS_PER_WAKE   # e.g. 80
wakeDeadline = now + SOFT_MAX_MS_PER_WAKE  # e.g. 20s

canSpend(n) / noteSpent(n) / shouldStop()
hydrate client from window; after each client response: sync remaining/reset → persist
```

Pass the same budget into `drain({ budget })` and `reconcile({ budget })` for that wake. When budget omitted (tests / legacy callers), synthesize a conservative one-shot budget from constants.

**Alternatives:** Keep independent caps per module (rejected — cannot share leftover); global mutable singleton without persist (rejected — SW death loses window).

### D2 — Fixed caps demoted to wakeCap / fairness

**Choice:**

| Today | After |
|-------|--------|
| `drainJobsCap(pending)` 25/55 as primary stop | Stop when `!budget.canSpend(worstCaseJob)` or jobs done; keep soft max jobs ≤ wakeCapReqs as backstop (may keep 25/55 as *upper* fairness when spendable is huge, or replace with single `SOFT_MAX_DRAIN_JOBS`) |
| `MAX_ALIVE_CHECKS_PER_TICK = 8` | Confirm GETs while `canSpend(1)` and under wakeCap; optional soft max confirms per wake (higher than 8, e.g. 40) so one wake cannot starve SW |
| `MAX_RECONCILE_PAGES_PER_TICK` / trash pages | Same pattern: spendable-first, soft page max as backstop |

**Why:** Panel rejected “raise 25→80 alone”; headers must lead. Soft maxima remain for SW lifetime.

### D3 — Persist rate window on status or dedicated key

**Choice:** Persist under `KEY.STATUS` (or sibling `KEY.RATE_WINDOW`): `{ rateRemaining, rateResetAt, rateObservedAt }`. On wake start, if `rateResetAt > now` and `rateObservedAt` is recent enough for this window, seed spendable from `rateRemaining`; else bootstrap. After every Raindrop response (client already notes headers), write back. Assume token bucket is **shared** with other Raindrop clients — never invent remaining.

**Alternatives:** Memory-only (rejected — every SW restart bootstraps forever); probe `/user` every wake before work (rejected — wastes a call when persisted window is fresh).

### D4 — Stop reasons: Raindrop pause vs self-cap

**Choice:**

- **Raindrop pause:** 429 or `remaining ≤ RESERVE` → existing `RateLimitError` → `rateLimitedUntil` + skip reason `rate_limited`.
- **Self-cap:** spendable or wakeCap exhausted while remaining > RESERVE → stop tick without setting `rateLimitedUntil`; durable note `lastThrottle: "wake_cap" | "bootstrap"` (and clear on next wake that runs work or on real pause). Activity log: “paused after N requests (wake cap)” / “bootstrap budget” — never “rate-limit budget.”
- Status UI: when `rateLimitedUntil` active → rate-limit copy; else if `lastThrottle` is wake_cap/bootstrap → distinct self-cap copy; reconcile skip reasons unchanged for busy/cooldown/bulk_pause.

**Alternatives:** Overload `rate_limited` for wakeCap (rejected — trains misdiagnosis); new reconcile skip reason for every drain stop (rejected — drain stop ≠ reconcile skip).

### D5 — Tick order stays drain → reconcile → drain; budget shared

**Choice:** Keep `tick()` order: drain, then reconcile (if bidirectional / not bulk_pause), then drain again. One `WakeBudget` created at tick start and passed through both drains and reconcile so leftover after first drain can fund Trash/list/confirm, and leftover after reconcile can fund second drain. Busy mutex unchanged (phase 4).

**Why:** Minimal behavioral blast radius; unlocks throughput without inventing concurrent listing.

### D6 — Event-path drain stays short

**Choice:** Live handlers that call `drain()` without a shared wake budget use a **short** synthetic budget (e.g. bootstrap-sized or small fixed job count), not full `SOFT_MAX_REQS_PER_WAKE`. Full spendable only on heartbeat / explicit Drain-now / Pull now.

**Why:** Panel condition 7; avoids bookmark storms burning the shared token bucket before heartbeat.

### D7 — Reserve sizing

**Choice:** Keep `RATE_LIMIT_RESERVE = 4` unless worst-case nested calls in one job exceed it; document that reserve MUST be ≥ worst-case nested Raindrop calls for one job (ensure-collection chains). If audit finds larger nesting, raise reserve in same change.

### D8 — Honest deferred-confirm messaging stays

**Choice:** Postpone log already fixed in phase 2; keep attributing deferrals to confirm/wake budget, not Raindrop exhaustion, unless `rateLimitedUntil` / proactive pause actually fired. When stop is wakeCap, say so.

## Risks / Trade-offs

- **[Risk] Faster wakes + higher confirms stress SW 30s idle kill** → Mitigation: soft wall-clock wakeCap; persist cursors already; never continuous filler.
- **[Risk] Shared token bucket with mobile/web Raindrop clients → unexpected early pause** → Mitigation: persist remaining; bootstrap small; hard pause on low remaining.
- **[Risk] Raising effective confirm throughput before phase 4 still fights busy mutex** → Mitigation: accepted; phase 3 still helps idle/unsettled installs; do not expand scope.
- **[Risk] Dup Edge creates under larger partial wakes** → Mitigation: existing createAttemptedAt / reclaim; ATs from architecture memo §9.
- **[Trade-off] Soft max jobs may still bind when remaining is high** → Intentional fairness; tune constants, not remove backstop.
- **[Trade-off] Busy mutex remains** → Explicit non-goal; documented for phase 4.

## Migration Plan

1. Ship WakeBudget + persist window + demoted caps + Status throttle copy.
2. No wipe; missing rate window → bootstrap on first wake.
3. Rollback: restore fixed primary caps; drop `lastThrottle` / rate window fields (harmless leftovers).

## Open Questions

- Exact numeric defaults for `BOOTSTRAP_REQS`, `SOFT_MAX_REQS_PER_WAKE`, `SOFT_MAX_MS_PER_WAKE`, soft max confirms/pages — pick conservatively in implementation (suggest 6 / 80 / 20s / 40 confirms) and adjust via verify scripts; not user-facing settings in v1.
- Whether “Drain now” exists as a distinct UI control vs only heartbeat + Pull now — budget applies to whatever entry points already burn full ticks today.
