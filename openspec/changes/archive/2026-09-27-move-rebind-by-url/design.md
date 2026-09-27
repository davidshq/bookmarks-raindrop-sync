## Context

Since `e9a7c64` (2026-09-16), Edge `onMoved` fans out upload jobs with `reason: "move"`. Paired drains call `updateRaindrop({ collectionId })` (relocate). Unpaired drains call `createRaindrop`, which forks a second copy when the URL already exists in Raindrop (common when Favorites and Raindrop were never Match-paired). Collection reparent is not required; relocating the raindrop by id is enough.

## Goals / Non-Goals

**Goals:**

- On `reason: "move"`, never create a second raindrop for a URL that already exists in Raindrop.
- Rebind Edge bookmark ↔ existing raindrop when safe, then update placement (and title/link) like a paired move.
- Reuse Match claim rules (`classifyPairClaim`) so we do not steal a raindrop paired to another live bookmark.
- Keep rate-limit / drain behavior intact.

**Non-Goals:**

- Reparenting Raindrop collections on folder move.
- Auto-deleting extra duplicate raindrops when several already exist for one URL.
- Changing create behavior for first-time Import / `onCreated` / non-move uploads (Match + Import remain the bulk path).
- Changing Raindrop→Edge pull placement.

## Decisions

### D1. Resolve by Raindrop search, filter with `urlMatchKeys`

**Choice:** `GET /raindrops/0?search=<url>` (via a small client helper), then keep items whose `link` shares a `urlMatchKeys` key with the Edge URL.

**Why:** Cheap per bookmark; no full-library CSV on every move. Match-from-export already proved the key rules.

**Alternatives:** Always `export.csv` once per drain — better for huge fan-outs, heavier for single bookmark moves. Defer; search first.

### D2. Only gate the create branch when `job.reason === "move"`

**Choice:** URL rebind runs only for move-enqueued uploads before create.

**Why:** User requirement is move-specific; create-on-first-seen elsewhere stays unchanged.

### D3. Ambiguous URLs: relocate oldest, do not create, do not delete extras

**Choice:** Prefer the smallest numeric raindrop id among matches (stable proxy for oldest). `recordSynced` + update. Log that N−1 extras remain.

**Why:** Stops growing the fork; cleanup of pre-existing extras stays manual / future tool.

### D4. Conflicts use `classifyPairClaim`

**Choice:** Before rebinding, run the same claim classification as Match (with live Edge id set). `conflict` → remove job, log, no create. `already` / `match` → proceed with that rid (rebind if needed).

**Why:** One claim policy; Edge Sync stale reverse links remain reclaimable.

### D5. Helper module `move-rebind.js`

**Choice:** Pure helpers for filtering search hits + picking a candidate; `processUpload` orchestrates I/O and pairing.

**Why:** Testable without chrome; keeps `job-processors` thinner.

## Risks / Trade-offs

- **[Search noise]** Raindrop search may return non-exact hits → Mitigation: hard-filter with `urlMatchKeys`.
- **[Rate limit on large folder moves]** One search per bookmark → Mitigation: existing drain pause; optional export-index cache later if needed.
- **[Extras left behind]** Ambiguous case leaves N−1 copies → Mitigation: log; out of scope to auto-delete.
- **[Conflict skips sync]** Other live bookmark owns the raindrop → Mitigation: log clearly; user can Match/resolve.

## Migration Plan

No storage migration. Deploy extension; subsequent moves rebind. Existing double copies (e.g. JSON / Dev/JSON) need one-time manual cleanup or a separate cleanup script.
