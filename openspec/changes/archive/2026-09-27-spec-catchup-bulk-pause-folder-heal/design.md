## Context

Bulk-lane and queue-depth prompt specs were archived with drain pause + Status banner. Follow-up commits then:

1. Skipped heartbeat **reconcile** during `needs_choice` and stamped Status skip reason `bulk_pause`.
2. Refreshed that skip to `busy` (or cleared it) after Match / Continue so Status stays honest.
3. Healed missing `folderCollections` on reconcile finish and learned maps on pull-create/pull-update.
4. Prioritized rename jobs ahead of uploads / pull-updates in the drain sort.

Main OpenSpec still describes only `busy` / `rate_limited` / `cooldown` and drain-only pause. This change documents shipped behavior; it does not redesign the engine.

## Goals / Non-Goals

**Goals:**

- Align main specs with Status skip reasons, reconcile pause under bulk prompt, folder-map heal/learn, and rename drain priority.
- Pin bulk heuristic / queue-depth numbers already used in `constants.js` and `docs/export-bulk-sync.md`.
- Keep apply work mostly verify + sync/archive (code already matches).

**Non-Goals:**

- New bulk UX, file-based bulk transfer, or changing threshold defaults.
- Chromium vs “Edge” prose rewrite across all specs (optional later).
- Raindrop collection *reparent* → Edge folder move (still out of scope; rename-in-place only).

## Decisions

### 1. Spec catch-up, not re-implement

**Choice:** Delta specs describe current code; tasks are verify + sync to main + fill `canonical-bookmark-roots` Purpose.

**Alternatives:** Revert hardening (rejected — Status honesty and map heal fix real installs); silent archive without deltas (rejected — next audit drifts again).

### 2. `bulk_pause` as a first-class skip reason

**Choice:** Heartbeat records `bulk_pause` when `needs_choice` is set and skips reconcile (after drain already no-ops). Pull now still uses `force: true` and is not gated by bulk_pause in `reconcile()`; users resolve via Status Match / Continue.

**Alternatives:** Reuse `busy` for bulk pause (rejected — Status copy must mention Match/Continue, not “Pull now”).

### 3. Refresh skip after bulk resume

**Choice:** After Match apply or Continue drip, call `refreshReconcileSkipAfterBulkResume()`: if Raindrop-bound jobs remain → `busy`, else clear skip. Options also guards against showing stale `bulk_pause` when `needs_choice` is already cleared.

### 4. Folder-map heal on finish

**Choice:** On reconcile finish, before pull-rename enqueue: bind unmapped collections under root via exact mirror path, leaf title under resolved parent, or single unmapped sibling (title drifted). Skip top roots, exclude, and outside-root `Raindrop` landing. Pull-create/update keep recording maps when they touch folders.

**Alternatives:** Only learn on future pulls (rejected — renames stay broken until every folder gets a pull); full Raindrop↔Edge tree walk every tick (heavier than needed).

### 5. Rename drain priority

**Choice:** `drainJobPriority`: `rename-collection` and `pull-rename-folder` = 0; all other kinds = 1. Prevents child path-ensure from creating a new collection under the new title before in-place rename runs.

### 6. Threshold numbers and coverage formula

**Choice:** State Import unpaired ≥ 200; low-coverage gate when `edgeScanned` ≥ 100 **and** `paired / (unpaired + paired)` &lt; 0.3 (in-scope = non-excluded URLs from `scanImportScope`). Size uses all scanned URL nodes (including excluded) so a huge excluded tree still trips the coverage gate; coverage itself ignores excluded. Same as `bulk-candidate.js`.

**Alternatives:** `paired/edgeScanned` (archived design sketch) — rejected; would dilute coverage when many URLs are excluded and disagree with Import enqueue scope.

### 7. Guided Match is Options-scoped

**Choice:** Specs require the ask → optional dry-run → Match path for Options Manual Sync Import/Pull and Status bulk-queue Match. The compact popup MAY call Import/Pull without that gate (shipped today). Queue-depth pause still protects drip either way.

**Alternatives:** Wire `withBulkMatchGate` into the popup (product follow-up; out of scope for this catch-up).

## Risks / Trade-offs

- **[Risk] Heal binds the wrong sibling when multiple unmapped folders share a parent** → Mitigation: only auto-bind when a single candidate remains (`pickHealFolderCandidate`); otherwise wait for exact path/title.
- **[Risk] Spec archive overwrites unrelated main edits** → Mitigation: MODIFIED blocks are full requirement copies; prefer ADDED where possible.
- **[Trade-off] Pull now vs bulk_pause** → Manual Pull is not the remediation path during bulk prompt; Status Match/Continue is. Specs must not imply Pull clears `needs_choice`.

## Migration Plan

1. Land delta specs + tasks (this change).
2. Run `npm test` to confirm shipped behavior still matches.
3. Sync deltas into `openspec/specs/` (or archive the change) and fill `canonical-bookmark-roots` Purpose.
4. Track `docs/export-bulk-sync.md` if still untracked so thresholds stay documented outside OpenSpec too.

No runtime migration; storage shapes already exist.

## Open Questions

- Whether to later wire the popup through `withBulkMatchGate` (product follow-up; not this catch-up).
- Optional later: rename “Edge” in capability titles for Chromium-neutral wording.
