## Context

The extension is already Chromium MV3 (`chrome.*`, bookmarks/storage/alarms). Product identity, default Raindrop root (`Edge`), and path segments (`Favorites bar` / `Other favorites`) are Edge-shaped. Edge’s restored Linux sync removes the original pitch; the solo production Raindrop tree should be renamed and future sync should write a Chrome-style canonical tree so Chrome and Edge share one Raindrop hierarchy.

## Goals / Non-Goals

**Goals:**
- Rebrand to **Bookmarks ↔ Raindrop Sync** / repo `bookmarks-raindrop-sync`
- Support all Chromium browsers with one package
- Canonical Raindrop segments: `Bookmarks bar`, `Other bookmarks` under default root `Bookmarks`
- Map local Edge (and any alias) titles ↔ canonical on upload and pull
- One-time in-place Raindrop rename migration (stable collection ids)
- Update docs/UI/tests for the new pitch

**Non-Goals:**
- Firefox, Safari, or WebExtension polyfill
- Chrome Web Store / Edge Add-ons / AMO publishing
- OAuth (personal test token remains)
- Renaming every openspec capability folder (`raindrop-to-edge-folders` etc.) — optional cleanup, not required for apply
- Changing sync algorithms (queue, pairs, tombstones, policies) beyond path normalization

## Decisions

### D1. Canonical Raindrop titles = Chrome-style
**Choice:** Persist `Bookmarks bar` and `Other bookmarks` under the sync root in Raindrop.  
**Why:** Matches Chrome/Brave/Opera/Vivaldi; Edge is the naming outlier; migration is acceptable for a solo install.  
**Alternatives:** Keep Favorites as canonical (rejected — Edge-centric); abstract tokens like `_bar` (rejected — ugly in Raindrop UI).

### D2. Alias table at the path boundary
**Choice:** Centralize root-role classification and canonicalization (e.g. in `collections.js` / small helper used by upload segments + `resolveMirrorPlacement`):

| Role | Canonical Raindrop title | Local aliases (match, case-insensitive) |
| --- | --- | --- |
| toolbar | `Bookmarks bar` | Favorites bar, Bookmarks bar, Bookmarks Toolbar, titles matching `/bar\|toolbar/i` |
| other | `Other bookmarks` | Other favorites, Other bookmarks, titles matching `/^other\b/i` among top roots |

- **Upload:** local path → replace first segment if it is a known toolbar/other root → canonical title → `[rootName, …]`.
- **Pull / mirrorPathExists:** first Raindrop segment compared to local top roots via alias equality (canonical or any alias matches the local root).
- Nested user folder titles are never rewritten.

**Why:** One place owns path fidelity; avoids forking `Edge/Favorites bar` vs `Bookmarks/Bookmarks bar`.  
**Alternatives:** Per-browser config of titles (unnecessary for Chromium).

### D3. Default `rootName` = `Bookmarks`
**Choice:** `DEFAULT_CONFIG.rootName = "Bookmarks"`; options placeholder updated. Existing `config.rootName` in storage wins until migration updates it.  
**Why:** Aligns new installs with the product name.

### D4. In-place Raindrop migration (solo install)
**Choice:** On startup (after token + config load), or first drain/reconcile, run a guarded migrator once:

1. Find collection titled `Edge` at account top (or configured legacy root); rename title → `Bookmarks` (same id).
2. Under that root, rename direct children `Favorites bar` → `Bookmarks bar`, `Other favorites` → `Other bookmarks` when present.
3. Rewrite `collectionCache` path keys that use old prefixes; leave `pairs` / `folderCollections` (id-based) untouched.
4. Set `config.rootName` to `Bookmarks` if it was `Edge`.
5. Persist a one-shot flag (e.g. `config.rootsMigratedAt` or storage key) so migration does not re-run.

If the new names already exist alongside old ones, prefer merging into canonical (rename old → canonical only when canonical child missing; if both exist, log and skip that segment — solo tree should not hit this).

**Why:** Preserves raindrop and collection ids; no pair rebuild.  
**Alternatives:** Manual Raindrop UI rename + docs only (rejected — easy to desync cache); delete-and-recreate tree (rejected — breaks ids).

### D5. Local browser folders stay native
**Choice:** Never rename Edge “Favorites bar” or Chrome “Bookmarks bar” in the browser. Only Raindrop titles and path resolution are canonicalized.  
**Why:** Browser roots are system-owned; renaming them is wrong and fragile.

### D6. Product / repo rename
**Choice:**
- Manifest `name` / `description` / `default_title`: Bookmarks ↔ Raindrop Sync (or “Bookmarks → Raindrop Sync” if ↔ is awkward in stores later)
- README pitch: Chromium bookmarks ↔ Raindrop; mention Edge Linux sync only as history if at all
- `package.json` `name`: `bookmarks-raindrop-sync`
- GitHub repo rename to `bookmarks-raindrop-sync` (operator step; document in tasks)
- Internal alarm/IDB prefixes (`ers-*`) MAY stay to avoid churn

**Why:** Identity matches the new product; internal keys are invisible.

### D7. Packaging niceties (same change, low priority)
**Choice:** Add icons + a simple `npm run pack` that zips `src/` (or `dist/`). Document load steps for Chrome and Edge.  
**Why:** Cheap; helps sideload on multiple browsers. Stores still out of scope.

## Risks / Trade-offs

- **[Risk] Migration renames wrong top-level `Edge` collection** → Only rename when it matches configured/legacy sync root and has the expected Favorites/Other children or was `config.rootName`; log clearly; one-shot flag.
- **[Risk] Dual children after partial manual rename** → Detect both old and canonical; skip rename and log; user can delete duplicate manually.
- **[Risk] collectionCache stale paths after rename** → Migrator rewrites/drops prefixed keys; ensure-if-missing rebuilds.
- **[Risk] Copy still says “Edge” in deep UI** → Grep-driven pass in tasks; prefer “browser” / “local bookmarks”.
- **[Trade-off] Canonical ≠ local title on Edge** → Raindrop shows “Bookmarks bar” while Edge shows “Favorites bar”; acceptable and documented.

## Migration Plan

1. Ship code with alias + canonical upload/pull and migrator.
2. Load unpacked on Edge (current install): migrator renames Raindrop tree + updates `rootName`.
3. Smoke: upload from Edge, pull, create/move/delete; confirm Raindrop paths are canonical.
4. Load same extension on Chrome against same Raindrop account; confirm no forked bar/other collections.
5. Rename GitHub repo when code/docs are ready.
6. Rollback: re-rename collections in Raindrop UI; clear `rootsMigratedAt` and restore `rootName` if needed (no automated down-migration).

## Open Questions

None blocking. Optional later: rename openspec capability ids from `*-edge-*` to browser-neutral names when archiving.
