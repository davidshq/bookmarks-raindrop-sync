## 1. Trash list on reconcile finish

- [x] 1.1 Add finish-cycle helper to page `listRaindrops(-99)` (reuse client), intersect ids with `pairs.byRaindrop`, skip tombstones / already-queued deletes
- [x] 1.2 Enqueue `delete-edge` for matched pairs; log a clear info line (trash-driven vs confirm-GET)
- [x] 1.3 Call trash pass from `finishConfirmGets` / `finishReconcileCycle` **before** missing-from-listing confirm GETs; exclude trash-handled ids from confirm candidates
- [x] 1.4 Honor `throwIfShouldPause` between trash pages; cap pages per finish starting at page 0 (no durable trash cursor)

## 2. Guards and docs

- [x] 2.1 Ensure trash items never enqueue pull-create / pull-update
- [x] 2.2 Keep capped confirm-GET + tombstone-prune path for permanent deletes / non-trash absence
- [x] 2.3 Extend verify script or unit coverage for: paired-in-trash → delete-edge; unpaired trash ignored; confirm fallback still runs for non-trash absence
- [x] 2.4 Point module comment at `docs/raindrop-delete-detection-options.md` for non-trash follow-ons (not duplicated in this change)
