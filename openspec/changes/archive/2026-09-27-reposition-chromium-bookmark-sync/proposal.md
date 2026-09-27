## Why

The extension was positioned as an Edge-only workaround for lost Linux bookmark sync. Edge has restored cross-computer sync on Linux, so that pitch is obsolete. The real product is syncing **Chromium browser bookmarks** with Raindrop under one shared collection tree—usable from Chrome, Edge, Brave, and other Chromium browsers—not an Edge-branded Linux stopgap.

## What Changes

- **Rebrand** the product and repo to **Bookmarks ↔ Raindrop Sync** / `bookmarks-raindrop-sync` (manifest, UI copy, README, package metadata). Drop the “Edge lost Linux sync” framing.
- Target **all Chromium** browsers (Chrome, Edge, Brave, etc.). Firefox and Safari remain out of scope.
- **Canonical Raindrop path titles**: store Chrome-style **`Bookmarks bar`** and **`Other bookmarks`** under the sync root, regardless of the local browser’s labels (`Favorites bar` / `Other favorites` on Edge, etc.).
- **Default sync root** for new installs: `Bookmarks` (was `Edge`).
- **BREAKING (solo install)**: **Migrate/rename** the existing Raindrop tree in place—`Edge` → `Bookmarks`, `Favorites bar` → `Bookmarks bar`, `Other favorites` → `Other bookmarks`—preserving collection ids so pairs and folder maps stay valid.
- Alias matching on pull/resolve so half-migrated or mixed titles do not fork collections.
- Update openspec/docs language from “Edge tree” to browser bookmarks where requirements change; capability folder renames (e.g. `raindrop-to-edge-folders`) are optional cleanup in this change or a follow-up.
- Optional in-scope niceties: extension icons, simple pack zip, load instructions for `chrome://extensions` and `edge://extensions`. Store publishing remains out of scope.

## Capabilities

### New Capabilities
- `canonical-bookmark-roots`: Chromium toolbar/other root aliases, canonical Raindrop segment titles, path normalization on upload/pull, and one-time in-place Raindrop tree migration from legacy Edge/Favorites names.

### Modified Capabilities
- `bookmark-sync-engine`: Folder mirroring and path examples use canonical Raindrop titles; behavior stays enqueue-then-drain but no longer assumes Edge-only root names in Raindrop.
- `extension-config`: Default `rootName` is `Bookmarks`; options/popup copy and placeholders refer to browser bookmarks, not Edge-only.
- `bidirectional-sync`: Requirements/scenarios use browser-neutral language; pull/mirror placement respects canonical roots and aliases.
- `selective-raindrop-folders`: Outside-root landing still under the local “other” root / `Raindrop`, with alias-aware “other” detection; docs drop Edge-only naming where it implies exclusivity.
- `raindrop-to-edge-folders`: Same create/existing-only modes, described as Raindrop → browser folders; path existence checks use canonical/alias rules.

## Impact

- **Code**: `src/manifest.json`, `src/lib/constants.js`, `src/lib/bookmarks.js`, `src/lib/collections.js`, `src/lib/live-handlers.js` (only if path strings matter), reconcile/pull/job processors that build Raindrop paths, `src/options/*`, `src/popup/*`, tests/harness (`Favorites bar` fixtures + Chrome titles), README / package.json.
- **Raindrop**: Rename of root + top segments for the solo production tree; collection ids preserved.
- **Repo**: GitHub rename to `bookmarks-raindrop-sync` (redirects keep old clone URLs).
- **Storage**: Existing installs update `config.rootName` during migration; pairs/`folderCollections` unchanged if collection ids are stable.
- **Out of scope**: Firefox, Safari, OAuth, Chrome Web Store / Edge Add-ons / AMO publishing.
