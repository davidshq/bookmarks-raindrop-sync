## Why

Heartbeat still throttles drain and reconcile with fixed per-tick caps (`MAX_JOBS_PER_DRAIN` 25/55, `MAX_ALIVE_CHECKS_PER_TICK` 8, page caps) even though Raindrop exposes ~120 req/min via `X-RateLimit-Remaining`. We already stop on low remaining / 429, but we never size work to spendable quota — so most of the API budget sits unused while catch-up and live sync feel slow. Phases 1–2 (park forever-alives, settled-only cooldown) are done; this is phase 3 of [`docs/sync-architecture-right-sizing.md`](../../../docs/sync-architecture-right-sizing.md): make headers the primary throttle per MV3 wake.

## What Changes

- Each heartbeat / Drain-now wake computes a **spendable** request budget from persisted or freshly observed `X-RateLimit-Remaining` minus reserve; unknown/stale remaining uses a small **bootstrap** (never “be bold”).
- Drain, Trash peek, list pages, and confirm GETs share that spendable budget under a soft **wakeCap** (request and/or wall-clock backstop for SW lifetime / fairness) — fixed 25/55/8 cease to be the *primary* throttle.
- Persist rate-window state (`remaining`, `resetAt`) across service-worker restarts so cold wakes are not blind every minute.
- Status / activity copy distinguishes **Raindrop pause** (`rateLimitedUntil` / remaining ≤ reserve) from **self-cap** (wakeCap / bootstrap exhausted) — remaining phase-5 honesty tied to this ship.
- Out of scope: replacing the busy mutex with ordered shared spendable while drain jobs remain (phase 4); bulk-lane hardening (phase 6); export Match; raising fixed caps alone without header budgeting.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `bookmark-sync-engine`: Header-driven spendable budget + soft wakeCap for drain/reconcile slices; persist rate window; honest self-cap vs Raindrop-pause signaling.
- `bidirectional-sync`: Reconcile list/confirm/Trash slices consume shared spendable under wakeCap rather than magic fixed primary caps.
- `extension-config`: Status distinguishes Raindrop rate-limit pause from self-cap (wakeCap / bootstrap).

## Impact

- `src/lib/raindrop.js` — expose remaining/reset; optional hydrate from persisted window; keep `throwIfShouldPause`
- `src/lib/constants.js` — `BOOTSTRAP_REQS`, soft wakeCap constants; reinterpret `MAX_*` as wakeCap/fairness backstops
- `src/lib/drain.js` / `reconcile.js` / `reconcile-finish.js` / `sync.js` — budget-aware slice loops; stop on spendable / wakeCap / reserve
- `src/lib/store.js` — persist rate window; Status skip / throttle reason for self-cap vs rate_limited
- Popup/options Status copy; verify scripts; migration note in `docs/sync-architecture-right-sizing.md`
