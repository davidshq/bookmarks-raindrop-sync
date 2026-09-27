## 1. Product identity and defaults

- [x] 1.1 Update `src/manifest.json` name, description, and action title to Bookmarks ↔ Raindrop Sync (Chromium bookmarks ↔ Raindrop)
- [x] 1.2 Change `DEFAULT_CONFIG.rootName` to `Bookmarks` and options placeholder/copy in `constants.js` / `options.html` / `options.js`
- [x] 1.3 Rewrite user-visible Edge-only strings in options, popup, and activity copy to browser / local bookmarks language
- [x] 1.4 Update `package.json` name/description and README pitch (drop Linux Edge-sync primary story; document Chrome + Edge load steps)

## 2. Canonical roots and path normalization

- [x] 2.1 Add a shared helper for toolbar/other role detection, canonical titles (`Bookmarks bar` / `Other bookmarks`), and alias equality
- [x] 2.2 Apply canonicalization in `raindropUploadSegments` (and any other upload path builders) so first-segment roots are rewritten
- [x] 2.3 Update `resolveMirrorPlacement` / path-existence walks so Raindrop canonical titles match local Favorites/Bookmarks roots without creating duplicates
- [x] 2.4 Ensure bidirectional folder-rename / pull-update logic does not rename browser top roots when titles differ only by alias

## 3. Legacy Raindrop tree migration

- [x] 3.1 Implement one-shot migrator: rename `Edge` → `Bookmarks`, `Favorites bar` → `Bookmarks bar`, `Other favorites` → `Other bookmarks` (preserve collection ids)
- [x] 3.2 Update `config.rootName` when migrating from `Edge`, rewrite or drop stale `collectionCache` path keys, persist completion flag
- [x] 3.3 Hook migrator into startup/drain after token is available; log skip/conflict cases (canonical child already exists)

## 4. Tests and fixtures

- [x] 4.1 Extend test harness with Chrome-style root titles alongside Edge Favorites fixtures
- [x] 4.2 Add unit/integration coverage for upload canonicalization, pull alias placement, and migration rename behavior
- [x] 4.3 Update existing scenarios/docs that assert `Edge/Favorites bar/…` paths to canonical `Bookmarks/Bookmarks bar/…`

## 5. Packaging and repo rename

- [x] 5.1 Add extension icons and wire `action.default_icon` / manifest icons
- [x] 5.2 Add a simple `npm run pack` (zip of loadable extension files)
- [ ] 5.3 Rename GitHub repo to `bookmarks-raindrop-sync` and fix remote/clone references in README as needed

## 6. Verification

- [ ] 6.1 Smoke on Edge: migration runs once; upload/pull/move/delete use canonical Raindrop paths
- [ ] 6.2 Smoke on Chrome against the same Raindrop account: no forked bar/other collections
- [x] 6.3 Run lint and existing Node test suite
