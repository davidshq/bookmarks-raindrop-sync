# Agent rules for this repository

## Never edit the browser's Bookmarks file on disk

Do not read-modify-write `~/.config/microsoft-edge/*/Bookmarks` (or any Chromium
profile's `Bookmarks` file) from a script, and do not restore a `Bookmarks.bak`
over it while the browser is closed. Use the `chrome.bookmarks` API from the
extension instead.

Why: Chromium stores an MD5 `checksum` in that file. When the stored checksum
does not match the content on load, Chromium **reassigns every bookmark id**.
On 2026-09-27 a script rewrote the file (and put a timestamp in `checksum`);
Edge renumbered ~5,800 bookmarks, every entry in the extension's pair map
became stale, a subsequent Import created ~5,500 duplicate raindrops, and the
delete-propagation path then removed hundreds of Edge bookmarks.

## Never treat an Edge bookmark id as durable identity

Bookmark ids are a cache, not a key. Any pairing between Edge and Raindrop must
be recoverable from the URL (plus path) and must rebind by URL when an id is
gone, instead of concluding that the user deleted the bookmark. A missing
counterpart on either side is not evidence of intent to delete.

## Before any destructive sync change

Take a Raindrop export and a copy of the Bookmarks file first. Incident backups
and analysis for the Sep 2026 desync live outside the repo in
`~/backups/edge-raindrop-sync/`.
