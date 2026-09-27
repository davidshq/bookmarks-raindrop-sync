## Context

Heartbeat runs every minute (`HEARTBEAT_MINUTES = 1`). After a completed bidirectional reconcile, `reconcile({ force: false })` skips until a quiet-time interval elapses. That interval was a hard-coded 15 minutes and not user-visible. Drain already pauses on `X-RateLimit-Remaining ≤ RATE_LIMIT_RESERVE` and persists `status.rateLimitedUntil`. Users want (1) a shorter quiet-time poll and (2) automatic deference when upload/delete/rename traffic is already using Raindrop — the durable queue is the clear signal for (2); hard pause already covers low remaining.

## Goals / Non-Goals

**Goals:**

- Persist a configurable quiet-time reconcile interval (minutes), default 15.
- Options UI control when sync mode is bidirectional.
- Heartbeat starts a *new* reconcile cycle only when: interval elapsed **and** the durable queue has no Raindrop-bound jobs.
- In-progress reconcile cursors always continue; Pull now still forces past interval/busy (still respects global rate-limit pause).
- Rely on the existing hard `rateLimitedUntil` pause for low remaining / 429 (no durable soft-budget snapshot).

**Non-Goals:**

- Webhooks, SSE, or any Raindrop push channel.
- Changing page/alive-check caps per tick.
- Making one-way mode run reconcile.
- Per-collection poll schedules.
- Guaranteeing sub-minute remote-delete latency under sustained upload load.
- A second durable soft-busy gate from `X-RateLimit-Remaining` (redundant with hard pause).

## Decisions

### 1. Config field: `reconcileIntervalMinutes`

**Choice:** Integer minutes on `DEFAULT_CONFIG`, default `15`. Clamp in `normalizeConfig` to `[1, 60]`. Invalid/missing → default.

**UI:** Select presets `1 / 2 / 5 / 15 / 30 / 60` under Settings when bidirectional is selected. Help text: “How often to check Raindrop when the sync queue is idle. Polling waits while uploads or other Raindrop work is still queued.”

**Alternatives:** Free numeric input (rejected — easier to pick bad values); seconds (rejected — heartbeat is 1 minute granularity).

### 2. Quiet-time interval replaces the hard-coded constant

**Choice:** `reconcile.js` reads `config.reconcileIntervalMinutes * 60_000` instead of `MIN_RECONCILE_INTERVAL_MS`. Keep `DEFAULT_RECONCILE_INTERVAL_MINUTES = 15` (and min/max constants) in `constants.js` for docs and clamps. Export a small helper `reconcileIntervalMs(config)`.

### 3. Traffic-aware skip before starting a new cycle

**Choice:** When `force` is false and no in-progress cursor, skip with reason `busy` if the durable queue contains any job whose kind hits Raindrop (`upload`, `delete-raindrop`, `delete-edge`, `pull-*`, `rename-collection`). Empty queue → not busy.

Order of skip reasons for heartbeat: existing `rate_limited` (hard pause) → in-progress continues → `busy` → `cooldown` (interval not elapsed) → run.

**Why queue only:** User intent — “if we’re doing a bunch of other things, don’t also list.” Drain already ran earlier in `tick()`; leftover jobs mean more Raindrop calls are imminent. Low remaining already triggers hard pause via `throwIfShouldPause` / 429 — a durable soft snapshot would duplicate that threshold and fight `clearRateLimit` at end of tick.

**Alternatives:** Soft-busy from persisted remaining/reset (rejected — redundant with hard pause, easy to wipe accidentally); defer only when pending > N (rejected — even one upload should win over a fresh listing).

### 4. Skip reason surface

**Choice:** Add `busy` to heartbeat reconcile results (manual Pull now already documents `busy` for in-flight). Do not spam the activity log every minute when skipping for busy/cooldown — only return structured `reason` (same as today’s cooldown silence).

### 5. Tick ordering unchanged

**Choice:** Keep `tick()` = drain → reconcile → drain. Busy check runs inside reconcile before listing. That way a heartbeat that empties the queue can still reconcile on the *next* minute once interval allows.

## Risks / Trade-offs

- **[Risk] Aggressive 1-minute interval + large library still burns budget on listing alone** → Mitigation: existing page/alive caps; hard pause on low remaining / 429; queue-busy gate.
- **[Risk] Queue never idle during continuous bookmarking** → Mitigation: Pull now still works; remote deletes wait until quiet (acceptable per product goal).
- **[Risk] `delete-edge` jobs count as busy and delay discovering more remote deletes** → Mitigation: intentional — finish queued deletes before another listing; in-progress cursor still advances mid-cycle.

## Migration Plan

- No storage migration: `getConfig` merges `DEFAULT_CONFIG`, so missing field → 15 minutes (current behavior).
- Existing installs see the new Options control only in bidirectional mode.

## Open Questions

- None blocking; preset list (`1/2/5/15/30/60`) can shrink in UI review if cluttered.
