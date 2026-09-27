## Why

Large bookmark dumps often arrive **outside** Manual Sync: user imports HTML into Edge (or Raindrop), Chromium fires hundreds of `onCreated` events (or reconcile enqueues pull-creates), and the durable queue jumps to 1k+ jobs. Today that path is **silent drip only** — Match-from-export is offered only when the user clicks Import/Pull, so an already-full queue (e.g. 1626 pending on Status) never prompts. Users should be told the backlog is bulk-sized and choose Match / keep dripping / (later) bulk file transfer — not discover hours later that sync is still crawling.

## What Changes

- **Detect** bulk backlogs from queue depth (and optionally recent enqueue burst), not only from Import/Pull click heuristics.
- **Surface** a Status (and/or Manual Sync) notice when pending crosses a threshold; one-shot user choice.
- **Actions (v1):** Match existing from export (reuse `export-bulk-sync-lane` primitives) → then continue drip; or dismiss and keep dripping; optional **pause drain** until the user chooses so a stampede does not continue unnoticed.
- **Document follow-on:** true bulk file transfer (Edge HTML → Raindrop import; Raindrop export → Edge) as a later change — not required to ship the prompt.
- Keep existing Import/Pull guided Match gates; this change covers the “already in queue / external import” gap.

## Capabilities

### New Capabilities

- `queue-bulk-prompt`: Queue-depth (and optional burst) detection, durable “needs user choice” state, Status UI notice, Match / continue-drip / dismiss actions, optional drain pause while awaiting choice.

### Modified Capabilities

- `extension-config`: Status panel SHALL show a bulk-backlog notice with actions when the engine flags a queue-depth bulk candidate.
- `bookmark-sync-engine`: Engine SHALL detect pending queue above threshold and MAY pause drain until the user resolves the bulk prompt (configurable behavior per design).
- `export-bulk-sync`: Match existing remains the v1 remediation action invoked from the queue prompt (no new Match semantics).

## Impact

- `src/lib/` — detection helper, status flags in `chrome.storage` (e.g. `bulkPrompt`), drain gate
- `src/options/` — Status banner + actions; maybe popup badge later (out of scope unless cheap)
- Reuse `match-existing.js` / SW Match messages from `export-bulk-sync-lane`
- Docs: `docs/export-bulk-sync.md` cross-link; note follow-on bulk file transfer
- Thresholds near existing bulk constants (~150–200 pending)
