# Export bulk sync lane

See also: [`raindrop-api-best-practices.md`](./raindrop-api-best-practices.md) (export vs live listing, rate budget).

Bookmarks ↔ Raindrop sync has two geometries:

| Lane | When | Mechanism |
|------|------|-----------|
| **A — Live / incremental** | Day-to-day creates, edits, deletes | Heartbeat drain, capped reconcile, Import, Pull |
| **B — Bulk / snapshot** | Large or thinly paired libraries | Detect → ask → optional dry-run → Match from `export.csv` → continue live op |

Heartbeat stays on Lane A. Bulk is **guided** when you start Import/Pull, when the **durable queue** crosses a depth threshold (external imports), and via a Manual Sync power-user Match control as fallback.

## Guided flow (Import / Pull)

1. **Detect** (local only — bookmarks + pair map + folder policy; no export yet):
   - Shared walk: `scanImportScope()` in `backfill.js` (same exclude / already-paired rules as Import enqueue).
   - Import: unpaired would-queue ≥ 200, **or** `edgeScanned` ≥ 100 with in-scope pair coverage (`paired / (unpaired + paired)`) &lt; 30%.
   - Pull (bidirectional): **only** `edgeScanned` ≥ 100 with that coverage &lt; 30% (not the unpaired Import threshold).
   - Size gate uses all scanned URL nodes (including excluded); coverage ignores excluded.
2. **Ask**: Match from export first / continue without matching / cancel.
3. **Optional dry-run**: review would-pair / ambiguous / conflict counts.
4. **Apply**: record unambiguous pairs only (no upload, pull, move, or delete).
5. **Continue** the original Import or Pull.

Options Manual Sync shares one helper (`withBulkMatchGate` in `options.js`) for Import and Pull so the ask/Match/abort path cannot drift; the Status queue-depth banner keeps its own Match entry point. The compact **popup** Import/Pull controls do **not** run this gate (queue-depth pause still applies if pending crosses 150).

## Queue-depth prompt (external import / already-swollen queue)

Large dumps often arrive **outside** Manual Sync: Edge HTML import (or a Raindrop pull storm) fires hundreds of `onCreated` / pull-create jobs. Status can show pending 1k+ with no Import click.

1. **Detect**: durable `queue.size() ≥ 150` (`QUEUE_BULK_PENDING_THRESHOLD`) and no active snooze.
2. **Pause**: drain (and heartbeat reconcile) stop while `bulkPrompt.status === needs_choice`. Live bookmark events may still enqueue — pending can keep rising until you open Options.
3. **Status notice**: Options → Status shows pending count, a short drip ETA, and **Match from export** / **Continue drip**.
4. **Match** reuses the same export Match flow as Import gates (pairs only).
5. **Continue drip** clears the pause and snoozes until pending drops below half the threshold (75), so the banner does not reappear every minute on the same backlog.

Activity log records a coalesced line while drain is paused.

## Match existing

Uses `GET /raindrops/0/export.csv` (all except Trash). Stale pair-map reverse links (bookmark id gone after Edge Sync) are rebound to the live bookmark with the same URL.

Dry-run plan and Apply share `classifyPairClaim()` so conflict / already-paired / match verdicts cannot drift.

## Export limits

- CSV has `id` + `url` but **not** collection path — placement still needs live Pull.
- Export is a snapshot; live sync continues afterward.

## Follow-on: file-based bulk transfer

Raindrop has no true multi-create REST bulk. v1 remediation is Match (dedupe pairs) + adaptive drip. A later change may add Edge→Netscape HTML download / Raindrop import instructions, or Raindrop export→Edge bulk create. That path is **out of scope** for the queue-depth prompt.

## Anti-pattern: editing the Bookmarks file

Do **not** rewrite Chromium’s on-disk Bookmarks JSON while the browser (or Edge Favorites sync) is running. Prefer `chrome.bookmarks` APIs.

## Testing

Automated (no real Edge tree):

| Layer | Script | What it covers |
|-------|--------|----------------|
| Pure logic | `verify-bidirectional-logic.mjs` | Heuristics, CSV/`planMatchFromExport`, queue-prompt state machine, Options HTML control ids |
| Engine (mocked chrome + Raindrop) | `verify-checklist.mjs` **7.5–7.7** | Enqueue arms `needs_choice`; drain/tick pause (zero Raindrop writes / no export.csv); Continue drip resume; `applyMatchExisting` → pairs + Import skip; `scanImportScope` exclude/pair rules; Pull bulk gate off in one-way |

```bash
npm test
```

Options UI smoke (fresh Chrome profile + unpacked extension; does **not** touch your normal Edge/Chrome Favorites):

```bash
# token via scripts/lib/test-harness loadToken (.tmp/raindrop_token or RAINDROP_TOKEN);
# puppeteer-core under .tmp/smoke-npm
xvfb-run -a node scripts/smoke-bulk-options.mjs
# SMOKE_HEADED=1 for a visible window (still a throwaway profile)
```

Covers: Status bulk banner show/hide, Continue drip snooze, Match from banner + Manual Sync Match (live `export.csv`, Apply cancelled), Import bulk-gate cancel (no queue growth). Apply of pairs is intentionally not confirmed so your live Raindrop library is not paired into an empty smoke profile.

## Related

- Delete-detection option F: [`raindrop-delete-detection-options.md`](./raindrop-delete-detection-options.md)
- OpenSpec: `export-bulk-sync-lane`, `queue-depth-bulk-prompt`
