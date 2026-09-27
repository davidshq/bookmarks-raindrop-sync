# Bookmarks ↔ Raindrop Sync

A Manifest V3 **Chromium** extension (Chrome, Edge, Brave, …) that syncs browser
bookmarks with [Raindrop.io](https://raindrop.io) — one shared Raindrop tree
across browsers.

**Source:** [github.com/davidshq/bookmarks-raindrop-sync](https://github.com/davidshq/bookmarks-raindrop-sync)
(`git clone https://github.com/davidshq/bookmarks-raindrop-sync.git`)

Raindrop stores **canonical** root titles (`Bookmarks bar`, `Other bookmarks`)
under a sync root you name (default `Bookmarks`). Local labels such as Edge’s
`Favorites bar` / `Other favorites` map to those titles on upload and pull so
Chrome and Edge do not fork collections.

**Sync modes** (Options → Sync mode):

| Mode | Behavior |
| --- | --- |
| **One-way** (default) | Browser → Raindrop only. Choose whether to **delete locally** after upload (offload) or **keep** a local copy. |
| **Bidirectional** | Keeps bookmarks in **both** places: also pulls Raindrop → browser under your root, and propagates **user** deletes both ways. Global default is keep-both; use folder policies for Exclude or Offload exceptions. Quiet-time **Raindrop check interval** is configurable (default 15 minutes); heartbeat defers a new listing while the upload queue still has Raindrop work. **Pull now** still runs immediately. |

## What it does

- **Live capture** — a new bookmark is queued the moment you create it.
  Dragging a bookmark (or folder) to another parent re-queues it so Raindrop
  **collection placement** matches the new path; same-folder reorders are ignored.
  Folder moves fan out to every URL bookmark under that tree. Editing a bookmark
  **title or URL** updates those browser-owned fields on the paired raindrop.
  Renaming a folder renames the mirrored Raindrop collection **in place**
  (same collection id) once that folder has been synced. Browser top roots are
  never renamed to match Raindrop’s canonical titles. In bidirectional mode,
  reconcile also applies the reverse for **bookmarks and folders**. Recent
  activity logs `Moved: … → …`, `Updated: …`, `Pulled update: …`,
  `Pulled move: …`, `Pulled folder rename: …`, or `Renamed folder: …` as
  appropriate (creates still log `Synced: …` / `Pulled: …`). Moving into an
  **Exclude** folder skips the Raindrop write.
- **Folder mirroring** — your bookmark folder tree is recreated as nested
  Raindrop collections under a root you name (default `Bookmarks`), preserving
  both Chromium roots as `Bookmarks bar` and `Other bookmarks` in Raindrop.
- **Per-folder policy** — override keep / offload (`sync-and-delete`) / `exclude`
  on any folder. Nearest ancestor wins. Folder policies edits stay in a draft
  until you **Apply folder policies**.
- **Instant local delete** — under offload / `sync-and-delete`, the bookmark is
  removed locally after Raindrop confirms the copy. That cleanup **does not**
  delete the Raindrop copy.
- **Bidirectional pull** — raindrops under the root appear as browser bookmarks
  (files/documents skipped); deletes propagate both ways with tombstones.
  Heartbeat reconcile uses your quiet-time interval when idle, and skips starting
  a new listing while Raindrop-bound jobs are still queued.
  **Raindrop → browser folders** chooses create-as-needed / existing-only /
  mirror-all. Outside-root allowlist picks land under Other bookmarks / Raindrop
  (or Other favorites on Edge).
- **Metadata ownership** — the browser only writes URL, title, and collection
  placement. Raindrop tags, notes, highlights, covers, and excerpts are never
  overwritten from the browser.
- **Import to Raindrop** — one-shot upload of existing bookmarks that are not
  synced yet.
- **Crash-safe** — durable queue, pair map, rate-limit gates, and heartbeat drain.
- **Activity log** — Status shows the newest 500 lines; optional long-term
  IndexedDB archive.

## Setup

1. Get a Raindrop **test token**: Raindrop → Settings → Integrations →
   *Create new app* → open it → **Test token**.
2. Optional API spike:
   ```bash
   RAINDROP_TOKEN=xxxxx node scripts/spike-raindrop.mjs --cleanup
   ```
3. Load unpacked in any Chromium browser:
   - Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → `src/`
   - Edge: `edge://extensions` → Developer mode → **Load unpacked** → `src/`
   - Or pack a zip: `npm run pack` → load `dist/bookmarks-raindrop-sync-*.zip` contents / unpack as needed
4. Open **Options** → Settings: paste token, **Test**, set root name / sync mode,
   **Save settings**. Legacy installs with an `Edge` / Favorites Raindrop tree are
   renamed once in place to `Bookmarks` / `Bookmarks bar` / `Other bookmarks`
   (collection ids preserved).
5. Optional: **Manual Sync** → **Import to Raindrop**. Bidirectional: **Pull now**.

## Tests

```bash
npm test
# node scripts/verify-bidirectional-logic.mjs && node scripts/verify-checklist.mjs
```

```bash
RAINDROP_TOKEN=xxxxx npm run test:live
RAINDROP_TOKEN=xxxxx npm run test:integration
```

Mocks never touch your real bookmark tree. Integration uses
`Favorites bar / test-edge-raindrop-sync / …` in the mock and a live Raindrop
root `test-edge-raindrop-sync`.

## Lint & format

```bash
npm run lint
npm run format
npm run format:check
```

## Layout

```
src/
  manifest.json
  icons/                   extension icons
  background/service-worker.js
  lib/
    bookmark-roots.js      canonical toolbar/other titles + aliases
    migrate-roots.js       one-shot Edge/Favorites → Bookmarks migration
    constants.js, store.js, queue.js, raindrop.js, collections.js, …
    sync.js, drain.js, job-processors.js, live-handlers.js, reconcile*.js
  options/  popup/
scripts/
  pack-extension.mjs
  verify-*.mjs
  lib/test-harness.mjs
```

## Notes

- **Identity:** pairs and overrides key on bookmark node `id` (Chromium GUID is
  not exposed by the API).
- **Auth:** personal test token (no OAuth). Sideload-oriented; store publishing
  is out of scope for now.
- **Deletes in bidirectional mode:** only **user** deletes propagate. Folder
  **Offload** still means remove locally after upload and leave Raindrop intact.
- **History:** this project began as an Edge-only Linux sync workaround; Edge
  restored cross-computer sync on Linux, so the product is now Chromium bookmarks
  ↔ Raindrop.
