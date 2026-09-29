# Sync engine rewrite: identity, deletion evidence, presence

Decision memo. Written 2026-09-28 after the Sep 25–28 desync incident. Describes
**what** in the current engine must change so a fork storm cannot recur, and
**what** can be deleted once it does. Not a patch list. The recovery steps for
the incident itself (Match conflict rule, pair rebuild, circuit breaker) are
separate and smaller; this is the target model they should converge on.

Related: [`sync-architecture-right-sizing.md`](./sync-architecture-right-sizing.md)
(throughput), [`raindrop-delete-detection-options.md`](./raindrop-delete-detection-options.md)
(presence options), [`export-bulk-sync.md`](./export-bulk-sync.md) (Match lane),
[`../AGENTS.md`](../AGENTS.md) (hard rules).

---

## What happened, in one paragraph

Scripts edited Edge's `Bookmarks` file on disk and wrote a timestamp into its
`checksum` field. Chromium reassigns every bookmark id on checksum mismatch, so
all ~5,800 ids changed and every pair-map entry went stale. An Import then
queued 5,285 "unpaired" bookmarks; the upload path creates a new raindrop
unless the job is a move or a crash retry, so it forked ~5,500 duplicates. The
duplicates were trashed within hours. Reconcile saw the paired raindrop ids
gone, concluded "user deleted in Raindrop", and removed 890 Edge bookmarks,
707 of which still existed in Raindrop under their original ids. Deletes in
the other direction hit dead Edge ids and silently did nothing. An earlier,
smaller wave of 1,451 forks on Sep 25 has no recorded trigger.

Three design assumptions failed together. Each one alone would have been
survivable.

| Assumption | Where it lives | Why it is wrong |
|---|---|---|
| Edge bookmark id is durable identity | `store.js` pairs `byBookmark` / `byRaindrop` | Ids change on checksum reassignment, profile rebuild, re-import. The code already knew (`match-existing.js` comments) but only the manual Match tool copes. |
| A plain create never needs to look for an existing raindrop | `job-processors.js` `processUpload`, `shouldReclaim` | Reclaim runs only for `reason === "move"` or `createAttemptedAt`. Any id churn followed by Import or onCreated forks the library. |
| Absence of the paired counterpart means the user deleted it | `reconcile-finish.js` confirm GET → `enqueueDeleteEdge`; `live-handlers.js` `handleBookmarkRemoved` | Absence also results from a stale pair, a trashed duplicate, a moved item, or a renumbered id. Acting on it is destructive and was wrong 707 times out of 890. |

---

## Target model

### 1. Identity: pair records, not id pairs

A pair is a record, and both id indexes are caches derived from it.

```
pair = {
  raindropId,            // stable while the raindrop lives
  bookmarkId,            // cache; may go stale at any time
  urlKey,                // urlMatchKeys(url)[0] at last sync
  url,                   // raw URL at last sync
  collectionId,          // Raindrop placement at last sync
  edgeParentId,          // Edge placement at last sync (cache)
  edgePathAtSync,        // ["Other favorites","Raindrop","Dev"] at last sync
  title,                 // at last sync
  lastSeenEdgeAt,        // epoch ms
  lastSeenRaindropAt,    // epoch ms
}
```

Rules:

- **Stale Edge id ⇒ rebind, never delete.** When `bookmarkId` is not in the
  tree, look for `urlKey` in the current tree. Prefer a match under
  `edgePathAtSync`, then anywhere under the mirror. Rebind silently and log
  `Rebound: <title> (Edge id changed)`. Only if the URL is nowhere in the
  mirror is the pair a candidate for "Edge side gone", and even then see §3.
- **Stale Raindrop id ⇒ rebind, never delete.** When `raindropId` is absent,
  look for `urlKey` in the presence snapshot (§4). If another raindrop carries
  the URL, rebind to it (oldest id wins, same rule as `pickMoveRebindCandidate`)
  and log. Only if no raindrop carries the URL is the pair a candidate for
  "Raindrop side gone".
- **Migration.** Existing `PAIRS` becomes records with `url` filled from the
  live tree and export on first load. Anything that cannot be resolved on
  either side is dropped, not kept as a ghost.

### 2. Creates always reclaim

Before `createRaindrop`, always consult presence by URL. In order:

1. The presence snapshot (§4), free.
2. `searchRaindrops(url)` if the snapshot is older than the wake, one request.

If a raindrop with the URL exists and is claimable under `classifyPairClaim`,
bind and update placement instead of creating. This makes `shouldReclaim`
unconditional; delete the `reason === "move"` special case.

Forking is the expensive failure. One extra request per genuinely new bookmark
is the cheap one.

### 3. Deletes require evidence, not absence

A delete on either side runs only when a positive signal exists **and** the URL
does not survive elsewhere on the source side.

| Direction | Positive signal required | Survival check |
|---|---|---|
| Raindrop → Edge | Raindrop id is in **Trash**, or absent from a **complete** presence snapshot | No other raindrop carries the URL (else rebind) |
| Edge → Raindrop | `onRemoved` fired **with a node payload** for that URL (Chromium supplies it), recorded in a durable `edgeRemoved` ledger `{urlKey, at, title}` | URL not present anywhere under the mirror (else the removal was a duplicate; forget the pair for that copy only) |

A per-id confirm GET that 404s is **not** a positive signal on its own; it
confirms an id is gone, not that the user meant it. It becomes evidence only
after the survival check fails.

### 4. Presence via export, not per-id GETs

One `GET /raindrops/0/export.csv` returns every live id and URL in one request
(~6k rows today). Use it as the presence oracle:

- Refresh at most once per quiet interval, or when a wake needs it and the
  snapshot is older than N minutes. Store `{at, ids: Set, byUrlKey: Map}`
  in memory plus a compact durable form (ids only) for SW restarts.
- Placement drift still needs the nested listing, because the CSV carries no
  collection column. Keep listing for **placement**, but stop using it for
  **presence**.
- Trash listing stays as the fast positive signal for soft deletes.

This removes: `seenAcc`, `unsettledConfirmCatchUp`, `runConfirmCatchUp`,
`rotateConfirmWindow`, `aliveConfirmOffset`, `parkedAliveIds` and the
park/unpark logic, the "postponed N missing-raindrop check(s)" concept, and
most of `finishDeleteDetection`. Tombstone prune becomes a set difference
against the snapshot instead of GETs. Rough estimate: 1,200–1,500 lines of
`reconcile.js`, `reconcile-finish.js`, `trash-hygiene.js`, `wake-budget.js`
and `store.js` go away or shrink to a few lines.

### 5. Delete circuit breaker

Even with §1–4, a bug or a bad snapshot must not be able to empty a side.

- Count executed deletes per direction in a rolling 24h window.
- If the count would exceed `max(50, 2% of live pairs)`, stop executing
  deletes, set `status.deletionsHalted = true` with a reason, log once, and
  keep the jobs queued.
- Options → Status shows the halt with the pending delete count and two
  actions: **Allow these deletes** (reset the window) and **Discard pending
  deletes** (drop the jobs, keep the pairs).
- The existing `deletionsHalted` field is already read by Status; nothing
  sets it today for this case.

Today's incident bled 3–5 deletes per cycle for a day. A per-wake cap would not
have caught it; a rolling window would have halted it after the first hour.

### 6. Pair health in Status

Compute from the presence snapshot and the tree, no extra requests:

- live ↔ live pairs
- pairs with a stale Edge id (rebind pending)
- pairs with a stale Raindrop id (rebind pending)
- Edge-only URLs, Raindrop-only URLs
- duplicate-URL groups on each side

Show the counts and a **Repair pairs** action that runs the §1 rebind pass on
demand. The inventory that took a hand-written join script during the incident
should be one click.

---

## What stays

- Durable queue, backoff, dead letter (`queue.js`).
- Raindrop client, rate headers, `RateLimitError` posture (`raindrop.js`).
- Collections mirroring, folder→collection map, in-place renames
  (`collections.js`, rename processors).
- Folder policies, exclude/offload, allowlist (`policy.js`, `allowlist.js`).
- Options UI structure. Status gains pair health and the breaker banner.
- `urlMatchKeys` as the single URL normalization.

## What goes

- `byBookmark` / `byRaindrop` as the source of truth (become indexes).
- `shouldReclaim` gating on move/crash.
- Confirm-GET presence: `seenAcc`, catch-up, parking, rotating windows.
- Deleting on absence in either direction.

## Known issues in code this rewrite deletes

Found by review on 2026-09-28 and deliberately not fixed, because §4 removes
the code they live in. **Resolved by deletion in the `sync-engine-rewrite`
change** (OpenSpec `openspec/changes/sync-engine-rewrite/`; rollout pending):

- **Confirm-only catch-up can stall pulls.** Gone with `runConfirmCatchUp`
  and `seenAcc`. Heartbeat no longer has a confirm-only mode; presence comes
  from one export per quiet interval, and a finish whose due export did not
  fit the wake (`presencePending`) completes on the next wake without
  re-listing and without skipping cooldown forever.
- **Check Trash can report "safe to empty" early.** Check Trash now rescans
  from page 0 on every click (`trashHygieneNextPage` is gone), and paired ids
  found by an earlier partial scan stay pending (`trashPendingIds`) until a
  later scan enrolls them.

## Tests

Move the checklist scripts to a real runner. The invariants that must have
tests, in priority order:

1. No delete executes without a positive signal and a failed survival check.
2. A create with an existing URL binds instead of forking.
3. A stale Edge id rebinds by URL under the same path.
4. A stale Raindrop id rebinds to the surviving copy.
5. The circuit breaker halts at the threshold and resumes on Allow.
6. Pair migration drops unresolvable ghosts.

## Sequencing

1. Circuit breaker (§5) — shipped in `03c265e` with the manual Repair pairs
   dry-run.
2. Unconditional reclaim on create (§2) — implemented. Every unpaired upload
   looks up its URL in the presence snapshot (plus raindrops this engine
   paired after that export began), falls back to one `searchRaindrops` when
   the snapshot is stale and cannot be refreshed or predates the job's
   `createAttemptedAt`, and binds instead of creating. Move conflict still
   drops; a plain create in conflict creates. Import refreshes the snapshot
   once before enqueuing.
3. Export presence snapshot (§4) — implemented (`presence.js`). Not behind a
   flag: the confirm-GET path was removed in the same change. `complete` is
   false on a parse error, a truncated body, or a suspicious row count (below
   half the last complete snapshot once that had ≥ 50 rows, or zero while
   pairs exist); a second export at the same count confirms a real cleanup.
   Durable form is ids only; URL consumers re-export after a worker restart.
4. Pair records + rebind rules (§1, §3) — implemented (`store.js` v2 records,
   `pair-rebind.js`, `pair-migration.js`). Delete evidence: `edgeRemoved`
   ledger from `onRemoved` payloads, synced-scope survival check for
   Edge→Raindrop; Trash or complete-snapshot absence plus a URL survival
   check for Raindrop→Edge, re-run at drain time against a later export
   (`signalSeq`). `presenceDeletesEnabled` (Status toggle) turns absence
   deletes off without a code change.
5. Delete the confirm-GET machinery and the parking logic — implemented in
   the same change as 3 and 4.
6. Pair health + Repair action in Status (§6) — implemented (`pair-health.js`;
   Repair pairs runs the same rebind pass and reports Edge-side and
   Raindrop-side rebinds separately from prunes).

Tests run under `node --test` (`test/*.test.mjs`); invariants 1–4 and 6 have
dedicated files (`evidence`, `reclaim`, `rebind`, `pairs`), invariant 5 is
checklist 7.8.

Items 2–6 are implemented in the `sync-engine-rewrite` change; rollout on the
primary profile is pending. Rollout (take a Raindrop export and a copy of the
Bookmarks file first, per `AGENTS.md`), then check: the one-line
`Pair migration:` log entry, Status pair health with zero stale-id pairs and
an unchanged breaker count after the first completed check, and that the
pre-migration pair backup is dropped after the next completed check.
