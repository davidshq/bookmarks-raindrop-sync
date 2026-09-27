## 1. Verify shipped behavior

- [x] 1.1 Confirm `tick()` stamps `bulk_pause` and skips reconcile while `needs_choice` (`src/lib/sync.js`)
- [x] 1.2 Confirm Match / Continue call `refreshReconcileSkipAfterBulkResume()` and Options guards stale `bulk_pause`
- [x] 1.3 Confirm `healUnmappedFolderCollections` + pull learn maps (`reconcile-finish.js`, `job-processors.js`)
- [x] 1.4 Confirm `drainJobPriority` puts rename kinds before upload/pull-update (`queue.js`)
- [x] 1.5 Confirm bulk coverage uses `paired/(unpaired+paired)` with size gate on `edgeScanned` (`bulk-candidate.js`)
- [x] 1.6 Confirm Options uses `withBulkMatchGate` and popup Import/Pull do not (`options.js`, `popup.js`)
- [x] 1.7 Run `npm test` (verify-bidirectional-logic + verify-checklist bulk/skip/rename coverage)

## 2. Docs hygiene

- [x] 2.1 Ensure `docs/export-bulk-sync.md` is tracked and matches pinned thresholds + coverage formula + Options-scoped gate
- [x] 2.2 Fill `openspec/specs/canonical-bookmark-roots/spec.md` Purpose (replace TBD) when syncing

## 3. Sync specs to main

- [x] 3.1 Apply delta specs into `openspec/specs/` for bookmark-sync-engine, queue-bulk-prompt, extension-config, bidirectional-sync, export-bulk-sync
- [x] 3.2 Run `openspec validate --all` and fix any archive merge issues
- [x] 3.3 Archive this change (`openspec-archive-change` / `/opsx:archive`) once main specs are updated
