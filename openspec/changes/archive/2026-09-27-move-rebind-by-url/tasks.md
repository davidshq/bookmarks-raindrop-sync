## 1. Client + rebind helpers

- [x] 1.1 Add `searchRaindrops(query)` (or listRaindrops `search` option) on `RaindropClient`
- [x] 1.2 Add `move-rebind.js`: filter search hits by `urlMatchKeys`, pick oldest claimable rid via `classifyPairClaim`

## 2. Upload drain

- [x] 2.1 In `processUpload`, before create on `reason: "move"`, resolve/rebind by URL; update or skip-create on conflict; log extras / conflicts
- [x] 2.2 Keep paired-move and non-move create paths unchanged

## 3. Tests + docs

- [x] 3.1 Add verify-checklist (or logic) coverage: unpaired move with existing URL → update, zero creates
- [x] 3.2 Cover multi-match (no create) and conflict (no create) cases
- [x] 3.3 Document move relocate-by-URL behavior in README (brief)
