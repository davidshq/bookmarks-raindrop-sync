## 1. Extract reusable primitives from temporary repair

- [x] 1.1 Move `urlMatchKeys` (and tests) into a shared module (e.g. `src/lib/url-match.js`)
- [x] 1.2 Move CSV parse into a shared module (e.g. `src/lib/export-csv.js`); keep `RaindropClient.exportRaindropsCsv`
- [x] 1.3 Add offline verify coverage for CSV parse + ambiguous URL key behavior

## 2. Match existing bulk operation

- [x] 2.1 Implement Match existing planner: export → Edge URL scan → counts
- [x] 2.2 Implement Apply: record unambiguous pairs; stale reverse rebind; activity log
- [x] 2.3 Add `MSG` + service-worker handler with `handleClientError` rate-limit gate

## 3. Guided detect → ask → optional dry-run → continue

- [x] 3.1 Add `bulk-candidate.js` heuristics + thresholds in constants
- [x] 3.2 Interrupt Import with Match-first / continue / cancel + optional dry-run
- [x] 3.3 Interrupt Pull (bidirectional) with the same guided flow
- [x] 3.4 Keep Manual Sync Match as power-user fallback; update help copy

## 4. Cleanup temporary repair mess

- [x] 4.1 Remove Options Other favorites repair UI / MSG / module / file script
- [x] 4.2 Verify scripts cover helpers + heuristics (not hardwired folder repair)

## 5. Docs

- [x] 5.1 Update `docs/export-bulk-sync.md` for guided flow
- [x] 5.2 Option F + README note for detect/ask/Match

## 6. Verification

- [x] 6.1 Offline verify: URL/CSV/Match planner + bulk heuristics
- [ ] 6.2 Manual smoke: large Import prompts → Match → Import; small Import no prompt; repair UI gone
