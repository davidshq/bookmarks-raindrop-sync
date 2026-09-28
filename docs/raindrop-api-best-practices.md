# Raindrop API best practices (this extension)

Practices for calling [Raindrop.io REST API v1](https://developer.raindrop.io/) from Bookmarks ↔ Raindrop sync. Grounded in the official docs plus what we already encode in `src/lib/raindrop.js`, wake budgets, and reconcile.

Related decision memos: [`raindrop-delete-detection-options.md`](./raindrop-delete-detection-options.md), [`export-bulk-sync.md`](./export-bulk-sync.md), [`sync-architecture-right-sizing.md`](./sync-architecture-right-sizing.md).

Official sources (prefer `.md` URLs):

- Overview / rate limits: https://developer.raindrop.io/
- Terms: https://developer.raindrop.io/terms
- Auth: https://developer.raindrop.io/v1/authentication/token
- Raindrops: https://developer.raindrop.io/v1/raindrops · [single](https://developer.raindrop.io/v1/raindrops/single) · [multiple](https://developer.raindrop.io/v1/raindrops/multiple)
- Collections: https://developer.raindrop.io/v1/collections/methods · [nested](https://developer.raindrop.io/v1/collections/nested-structure)
- Export / import: https://developer.raindrop.io/v1/export · https://developer.raindrop.io/v1/import

---

## 1. Be gentle (terms + rate limit)

Raindrop’s terms ask clients not to overburden the API. Attempts to circumvent limits (extra apps, bogus accounts) are prohibited. They may throttle or block abusive usage beyond the published cap.

| Fact | Our practice |
|------|----------------|
| **120 requests / minute / authenticated user** | Treat as a hard shared budget for all extension activity (heartbeat, Options, live handlers) |
| Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining` (docs also say `RateLimit-Remaining`), `X-RateLimit-Reset` (UTC epoch **seconds**) | `RaindropClient` records remaining/reset on every response; persist the window across SW wakes |
| HTTP **429** | Throw `RateLimitError`; honor `Retry-After` when present, else wait until reset (fallback 60s) |
| Prefer stopping **before** 429 | Pause when remaining ≤ `RATE_LIMIT_RESERVE` (4) via `throwIfShouldPause()` / proactive `RateLimitError` |
| Soft wake caps (`SOFT_MAX_REQS_PER_WAKE`, short vs full budget) | Fairness under MV3 + multi-entry drain; headers remain the real throttle |

**Do:**

- Share one token’s budget across drain, reconcile, Match, and Options UI refreshes.
- Size work to `WakeBudget.allowance()` / spendable, not fixed “politeness” alone.
- Persist `rateRemaining` / `rateResetAt` so a cold service-worker restart does not “be bold” (`BOOTSTRAP_REQS`).

**Don’t:**

- Fire unbounded parallel `fetch` storms from live bookmark events (use short wake budgets).
- Spin new requests while `status.rateLimitedUntil` is in the future.
- Treat our soft page/job caps as “we’re at the API limit” in user-facing copy when Remaining is still high.

---

## 2. Authentication and errors

```http
Authorization: Bearer <access_token>
Content-Type: application/json   # when sending a body
```

Base URL: `https://api.raindrop.io/rest/v1` (`RAINDROP_API`).

| Status | Meaning | Our reaction |
|--------|---------|----------------|
| **401 / 403** | Token rejected | `AuthError` — halt deletions, keep jobs queued |
| **404** | Resource gone | Treat as already deleted / clear stale maps (`isNotFoundError`) |
| **429** | Rate limit | Back off until `retryAt`; keep jobs queued |
| **4xx** (other) | Client error — docs: do **not** retry unmodified | Dead-letter after attempts; fix payload or drop |
| **5xx** | Server error — docs: safe to retry later | Backoff and retry (within `MAX_JOB_ATTEMPTS`) |
| **204** / empty body | Success with no JSON | Treat as `{}` (e.g. some DELETEs) |

**Token notes (docs):**

- App **test tokens** are fine for personal/single-account use (what Options → Settings expects today).
- Full OAuth access tokens expire (~two weeks) and need refresh; test tokens do not follow that expiry path.
- Validate with `GET /user` before relying on sync.

**Do not** depend on undocumented response fields — Raindrop warns they may vanish.

---

## 3. System collection IDs

Path parameter `collectionId` on list/export/batch ops:

| ID | Meaning |
|----|---------|
| **0** | All raindrops **except** Trash |
| **-1** | Unsorted |
| **-99** | Trash (soft-deleted) |

Warnings from the docs that affect us:

- Batch **update/remove** do **not** support `collectionId=0` yet.
- `DELETE` of a raindrop **moves it to Trash**. Deleting again from Trash (or emptying Trash) is permanent.
- `DELETE /collection/-99` empties Trash — destroys the soft-delete signal our Trash fast path needs. See Status “Safe to empty” in the delete-detection memo.

---

## 4. Listing and pagination

`GET /raindrops/{collectionId}`

| Parameter | Rule |
|-----------|------|
| `perpage` | **Max 50** — always clamp (`RAINDROP_LIST_PER_PAGE`) |
| `page` | Zero-based |
| `nested` | `true` to include descendants (sync-root and outside-root allowlist forests) |
| `search` | Same syntax as the Raindrop app search box — **not** a guaranteed exact-URL match |
| `sort` | e.g. `-created` (default), `title`, `score` (with search), etc. |

**Practices:**

1. Prefer **scoped** listing (`root` + `nested=true`, then outside-root allowlist roots) over paging the whole library every heartbeat.
2. Use `count` + short page / `isListPageDone()` to know when a cursor finished — never assume one page is the full set.
3. Cap pages per wake (`MAX_RECONCILE_PAGES_PER_TICK`, Trash `MAX_TRASH_PAGES_PER_TICK`) and resume via durable reconcile cursor.
4. After each page, call `throwIfShouldPause()` so listing does not burn the reserve needed for ensure-collection chains.

**Search caveats:**

- `searchRaindrops` / `GET /raindrops/0?search=…` is fuzzy. Callers **must** hard-filter with `urlMatchKeys` (move-rebind, reclaim).
- `search=lastUpdate:>…` is useful for **creates/edits**, not deletes (gone IDs never appear). Do not use it as a delete oracle.

**Presence alternatives (choose by lane):**

| Need | Prefer | Avoid for |
|------|--------|-----------|
| Soft-delete detection | List `-99` (Trash fast path) | Assuming emptied Trash still shows deletes |
| Day-to-day pull | Nested scoped list | Full `collectionId=0` every minute |
| Bulk pair Match | `GET …/export.csv` once | Heartbeat export |
| Confirm one id | `GET /raindrop/{id}` | N confirms without parking/Trash first |

There is **no** official bulk GET-by-ids. `ids` exists on batch **update/remove** only.

---

## 5. Edge-owned writes only (field-selective)

Raindrop raindrops carry rich fields (tags, notes, highlights, cover, excerpt, media, reminders). Edge bookmarks only own URL, title, and folder placement.

**Creates** (`POST /raindrop`):

```json
{
  "link": "…",
  "title": "…",
  "collection": { "$id": <id> },
  "pleaseParse": {}
}
```

- `pleaseParse: {}` asks Raindrop to enrich cover/excerpt/html in the background — allowed on create.
- Never send empty `tags`, `note`, `highlights`, etc. on create.

**Updates** (`PUT /raindrop/{id}`):

- Send **only** changed Edge-owned keys: `link`, `title`, and/or `collection: { $id }`.
- Omit rich fields entirely. Empty arrays/strings on update **clear** those fields server-side (confirmed by spike / bidirectional design).
- Do not send `pleaseParse` on routine Edge→Raindrop title/URL sync (would re-fetch metadata unexpectedly).

**Collections:**

- Create with `title` + optional `parent: { $id }` for nesting.
- Rename with field-selective `PUT /collection/{id}` (`title` only).
- Removing a collection moves its raindrops to Trash and removes descendants — treat as destructive; our engine does not bulk-delete collections for sync hygiene without an explicit product decision.

Spec: OpenSpec `bidirectional-sync` — Edge→Raindrop writes SHALL NOT clear Raindrop-only fields.

---

## 6. Deletes and Trash

| Action | API | Result |
|--------|-----|--------|
| Soft-delete one item | `DELETE /raindrop/{id}` | Moves to Trash (`-99`) |
| Permanent | Delete while in Trash, or empty Trash | Gone (404 afterward) |
| Batch soft-delete | `DELETE /raindrops/{collectionId}` + `ids` / `search` | To Trash; **not** with `0` yet |
| Empty Trash | `DELETE /collection/-99` | Permanent; **user for sync** |

**Practices we follow:**

1. Prefer Trash listing for Raindrop→Edge delete detection before burning confirm GETs.
2. Confirm GET remains the fallback for hard-delete / emptied Trash.
3. Park out-of-scope alives so missing-from-scoped-list does not regenerate confirm debt forever.
4. Surface trash hygiene (“Safe to empty”) so users do not empty Trash while paired soft-deletes still need enroll.

---

## 7. Bulk vs incremental geometry

Raindrop has `POST /raindrops` (create **up to 100** items per request) and batch update/remove. We still run **incremental drip** for live sync because:

- Each create may need ensure-collection chains and pair-map updates.
- MV3 wakes and shared rate budget favor small, resumable jobs over multi-hundred POST bursts.
- Large libraries use the **bulk lane**: detect → ask → Match from `export.csv` → continue live ops ([`export-bulk-sync.md`](./export-bulk-sync.md)).

**Export** (`GET /raindrops/{collectionId}/export.{csv|html|zip}`):

- One request for a snapshot; `collectionId=0` ≈ whole library except Trash.
- CSV has id + url but **not** collection path — Match pairs only; placement still needs live Pull.
- Suitable for guided bulk / queue-depth prompts — **not** for every heartbeat.

**Import helpers we do not depend on today** (optional future):

- `POST /import/url/exists` — batch “already saved?” by URL.
- `GET /import/url/parse` — metadata preview (overlaps `pleaseParse` on create).

If we adopt batch create later, keep field-selective bodies, respect 100/item max, and still count **one HTTP request per batch** against the 120/min budget.

---

## 8. Collections tree

Raindrop does not return the full sidebar in one call. Docs require:

1. `GET /user` — `groups[].collections` = root order  
2. `GET /collections` — root collection objects  
3. `GET /collections/childrens` — all nested collections (`parent.$id`)

**Practices:**

- Build an in-memory index (`collections.js`) once per reconcile wake; reuse for allowlist, ensure-path, and heal.
- Cache path → collectionId and folderId → collectionId so steady-state uploads avoid recreate.
- Duplicate titles under the same parent are possible — resolve by id maps, not title alone.
- Groups are UI organization for roots; our sync root is a **collection title** under the account, not a Raindrop “group”.

---

## 9. Client surface checklist

Keep Raindrop HTTP behind `RaindropClient`. Current intentional surface:

| Method | Endpoint | Use |
|--------|----------|-----|
| `getUser` | `GET /user` | Token check |
| `getRootCollections` / `getChildCollections` | `GET /collections`, `/collections/childrens` | Tree index |
| `createCollection` / `updateCollection` | `POST/PUT /collection…` | Ensure path / rename |
| `createRaindrop` | `POST /raindrop` | Upload create |
| `updateRaindrop` | `PUT /raindrop/{id}` | Edge-owned fields only |
| `deleteRaindrop` | `DELETE /raindrop/{id}` | Soft-delete |
| `listRaindrops` | `GET /raindrops/{id}` | Reconcile, Trash, search |
| `getRaindrop` | `GET /raindrop/{id}` | Confirm alive / gone |
| `exportRaindropsCsv` | `GET …/export.csv` | Bulk Match |
| `searchRaindrops` | list `0` + `search` | Move-rebind / reclaim (hard-filter!) |

Avoid ad-hoc `fetch` to `api.raindrop.io` outside this client so rate headers, Auth/429 typing, and body summarization stay consistent.

---

## 10. Retry, queue, and UX

- **Rate-limit / auth failures:** keep jobs on the durable queue; do not dead-letter solely for 429 or AuthError.
- **Transient 5xx / network:** exponential backoff capped (`BASE_BACKOFF_MS` … `MAX_BACKOFF_MS`).
- **Poison jobs:** after `MAX_JOB_ATTEMPTS`, dead-letter with a clear error (summarized body — no full HTML dumps).
- Status UI should say “paused for Raindrop rate limits until …” when `rateLimitedUntil` is set, and distinguish **our** wake caps from **their** 120/min when logging postponed work.

---

## 11. Anti-patterns (quick reference)

| Anti-pattern | Why it hurts |
|--------------|--------------|
| Full-library page loop every minute | Burns 120/min; competes with uploads |
| Confirm GET for every missing scoped id without Trash/park | O(candidates) debt |
| `PUT` with `tags: []` / empty note | Wipes Raindrop-rich data |
| Trusting `search=` as exact URL | False reclaim / wrong rebind |
| Emptying Trash while Status ≠ safe | Loses soft-delete enroll window |
| Export on heartbeat | Heavy snapshot for incremental work |
| Ignoring Remaining until hard 429 | Worse UX; jobs stall longer |
| Relying on undocumented JSON keys | Breaks on API change |
| Circumventing rate limits | Terms violation; account risk |

---

## 12. When adding a new Raindrop call

1. Put it on `RaindropClient` with field-selective bodies and header accounting.
2. Decide which **lane** it belongs to (live / reconcile / bulk) and what wake budget it spends.
3. Check whether an existing endpoint already covers the need (Trash list vs GET-by-id; export vs `collectionId=0`; `import/url/exists` vs search).
4. Update this doc and the relevant OpenSpec delta if the call changes sync semantics.
5. Spike with `scripts/spike-raindrop.mjs` (or a focused script) before baking assumptions into reconcile.

---

*Last reviewed against developer.raindrop.io docs and this repo’s client (2026-09).*

## Server-side response cache (observed 2026-09-28)

Raindrop's REST API sits behind its own response cache (`x-api-cache: HIT` /
`MISS` response header), keyed by the full URL. It is **not** Cloudflare
(`cf-cache-status: BYPASS`) and it **ignores** `Cache-Control: no-cache` and
`Pragma: no-cache` on the request. Several cache copies of different ages can
answer the same URL: back-to-back identical requests returned 43 and 44 items,
and a listing more than two hours stale was served repeatedly while a
cache-busted request returned current data.

Consequence for sync: a stale listing reports raindrops in collections they
have already left, so reconcile moves the browser copy to the old place, then
back when a fresh copy answers. `RaindropClient.request` therefore appends a
unique `_cb` query parameter to every GET (`cacheBustPath`) and sets
`cache: "no-store"` so Edge's HTTP cache cannot replay an old body either.
Writes are unaffected.
