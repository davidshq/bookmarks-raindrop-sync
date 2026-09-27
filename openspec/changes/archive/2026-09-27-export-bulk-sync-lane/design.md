## Context

Lane A (live incremental) remains the default. Lane B (export snapshot) is for large/overlapping libraries. v1 product surface is a **guided interrupt**, not a mysterious Manual Sync-only tool.

## Goals / Non-Goals

**Goals:**

- Detect bulk candidates cheaply (local Edge + pairs only) before Import/Pull burns the API.
- Ask → optional dry-run → apply Match (record pairs) → continue the user’s original action.
- Match existing primitives (export, URL keys, stale reverse rebind, rate-limit gate).
- Power-user Manual Sync Match remains as a fallback.
- Temporary repair UI stays gone.

**Non-Goals (v1):**

- Export inside heartbeat.
- Destructive delete convergence from export.
- Folder placement from CSV.
- Perfect duplicate prediction without export (heuristics are suggestive, not exact overlap counts).

## Decisions

### 1. Detect without export

**Decision:** Heuristics use only `collectAllBookmarks` + pair map + policy (same filters as Import):

- **Import candidate** when unpaired (would-queue) count ≥ `BULK_UNPAIRED_IMPORT_THRESHOLD` (200), or Edge URL count ≥ 100 and pair coverage (paired/edge) < 0.3.
- **Pull candidate** when bidirectional and Edge URL count ≥ 100 and pair coverage < 0.3 only — **not** the unpaired Import threshold (avoids Import “would queue” prompts on Pull / first auto-pull).

**Why:** Prompt must be instant; export is the expensive step after the user opts in.

### 2. Guided flow owns the primary UX

**Decision:** On Import/Pull click, if candidate → confirm Match first / continue without / cancel. If Match first → ask whether to dry-run; then apply; then run Import/Pull.

**Alternatives:** Manual-only button — rejected as “small mind” / discoverability failure.

### 3. Dry-run optional

**Decision:** Ask “Show dry-run counts before applying?” OK = dry-run then confirm Apply; Cancel = record pairs immediately (still no deletes). Power-user button keeps dry-run-first for safety when not in a guided flow.

### 4. Stale reverse pairs

**Decision:** `byRaindrop` pointing at a bookmark id not in the live tree is not a conflict — allow rebind (Edge Sync / reinstall).

### 5. Rate limits

**Decision:** Match plan path calls `handleClientError` so the global gate is set.

### 6. Manual Sync button

**Decision:** Keep as secondary (“also available anytime”); primary path is the Import/Pull interrupt.

## Risks / Trade-offs

- **[Risk] Heuristic false positives** → Mitigation: user can Continue without matching; thresholds documented/constants.
- **[Risk] Heuristic false negatives** → Mitigation: power-user Match control.
- **[Risk] confirm() UX is crude** → Acceptable for extension Options; custom modal later if needed.
- **[Risk] Large matched list in runtime message** → Accept for v1; revisit if quota issues.

## Open Questions

- Persist “don’t ask again for N days”? — defer.
- Pull interrupt only when bidirectional — yes for v1.
