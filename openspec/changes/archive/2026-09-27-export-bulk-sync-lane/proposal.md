## Why

Live incremental sync works for day-to-day edits but scales poorly for large libraries and empty/stale pair maps: Import/Pull can enqueue thousands of duplicates, and discovery burns the ~120 req/min budget. Users should not have to know to open a special tool — the system should **detect** bulk candidates, **ask**, offer an optional **dry-run**, then **apply** Match-from-export before continuing the live operation. Raindrop `export.csv` answers presence (id + url) in roughly one request. Temporary Other-favorites repair UI/scripts must stay removed.

## What Changes

- Add a **bulk / snapshot lane** (Match existing from export) separate from the heartbeat.
- **Detect** when Import (and Pull, when applicable) is a bulk candidate using local heuristics (unpaired count, pair coverage) — no export required for the prompt.
- **Ask** the user before proceeding: Match first / Continue without matching / Cancel.
- **Optional dry-run** then confirm Apply (record pairs only); then **resume** the original Import/Pull.
- Keep a Manual Sync power-user entry for Match existing (not the primary path).
- Document the guided flow and export limits; cleanup of temporary repair remains in scope (already done in implementation).

## Capabilities

### New Capabilities

- `export-bulk-sync`: Bulk lane with export presence oracle, Match existing (record pairs), candidate detection heuristics, guided confirm + optional dry-run + apply before live Import/Pull.

### Modified Capabilities

- `extension-config`: Manual Sync Import/Pull SHALL offer guided bulk Match when heuristics fire; power-user Match control MAY remain; temporary Other-favorites repair MUST NOT remain.
- `bookmark-sync-engine`: Pair map MAY be updated from export URL matches; Import skips already-paired ids after Match.

## Impact

- `src/lib/bulk-candidate.js` (heuristics), `match-existing.js`, `export-csv.js`, `url-match.js`
- Options Import/Pull flows interrupt with prompts; SW Match plan/apply messages
- Docs: `docs/export-bulk-sync.md`, delete-detection option F, README
