// Presence snapshot: Raindrop export.csv as the oracle for "does this raindrop
// id / URL still exist?".
//
// One GET /raindrops/0/export.csv lists every live raindrop (Trash excluded)
// with its id and URL. Delete detection, tombstone prune, stale-id rebind and
// upload reclaim read this snapshot instead of issuing per-id GETs. The CSV has
// no collection column, so placement drift still comes from the nested listing.
//
// Memory holds { at, ids, byUrlKey, urlById, complete }. Storage holds the
// compact { at, ids, complete, count, lastCompleteCount } so a restarted
// worker keeps absence detection without a new export. A restored snapshot has
// no URL index (`urlIndexed: false`); URL consumers refresh before trusting it,
// because an empty index reads as "no survivor".
//
// Refresh cadence (ensurePresence):
//   heartbeat  → when age ≥ reconcile interval
//   on-demand  → when age ≥ PRESENCE_STALE_MS, the URL index is missing, or
//                the caller needs a later export than a given `seq`
//                (delete-edge execution re-checks against a later export)
//   pull-now   → always
// The export is one request on the caller's client, so a bound WakeBudget
// charges it like any other Raindrop call.

import {
  KEY,
  PRESENCE_STALE_MS,
  PRESENCE_MAX_AGE_MS,
  PRESENCE_MIN_COMPLETE_FRACTION,
  PRESENCE_SHRINK_MIN_ROWS,
} from "./constants.js";
import { indexExportByUrl } from "./export-csv.js";
import { urlMatchKeys } from "./url-match.js";
import { _read as read, _write as write } from "./store.js";
import { AuthError, RateLimitError } from "./raindrop.js";

/**
 * @typedef {{
 *   at: number,
 *   ids: Set<string>,
 *   byUrlKey: Map<string, string[]>,
 *   urlById: Map<string, string>,
 *   complete: boolean,
 *   count: number,
 *   urlIndexed: boolean,
 *   lastCompleteCount: number,
 *   seq: number,
 *   suspectCount?: number|null,
 *   error?: string,
 * }} PresenceSnapshot
 *
 * `seq` increases with every export (persisted), so "a snapshot taken after
 * X" is exact even when two exports land in the same millisecond.
 *
 * @typedef {"heartbeat"|"on-demand"|"pull-now"} PresenceReason
 */

/** @type {PresenceSnapshot|null} */
let memory = null;

/** Two exports agree on a row count (1% or one row of slack). */
function sameCount(a, b) {
  return a != null && b != null && Math.abs(a - b) <= Math.max(1, Math.round(0.01 * a));
}

/**
 * Build a snapshot from export CSV text. Never throws.
 * `complete` is false on a parse error, and on a suspicious count: fewer than
 * half the rows of the last complete snapshot (when that had at least
 * PRESENCE_SHRINK_MIN_ROWS), or zero rows while pairs exist. A suspicious
 * count becomes complete once the next export agrees with it
 * (`previousSuspectCount`), so a real cleanup is accepted on a second look
 * instead of blocking deletes forever.
 * @param {string} csvText
 * @param {{ at?: number, previousCompleteCount?: number, previousSuspectCount?: number|null, expectNonEmpty?: boolean, seq?: number }} [opts]
 * @returns {PresenceSnapshot}
 */
export function buildSnapshot(
  csvText,
  {
    at = Date.now(),
    previousCompleteCount = 0,
    previousSuspectCount = null,
    expectNonEmpty = false,
    seq = 1,
  } = {}
) {
  let parsed;
  try {
    parsed = indexExportByUrl(csvText);
  } catch (err) {
    return {
      at,
      ids: new Set(),
      byUrlKey: new Map(),
      urlById: new Map(),
      complete: false,
      count: 0,
      urlIndexed: false,
      lastCompleteCount: previousCompleteCount,
      seq,
      error: err?.message || String(err),
    };
  }
  const count = parsed.raindropCount;
  let error;
  if (
    previousCompleteCount >= PRESENCE_SHRINK_MIN_ROWS &&
    count < previousCompleteCount * PRESENCE_MIN_COMPLETE_FRACTION
  ) {
    error = `export shrank to ${count} from ${previousCompleteCount}`;
  } else if (count === 0 && expectNonEmpty) {
    error = "export returned no raindrops while pairs exist";
  }
  const confirmed = error != null && sameCount(count, previousSuspectCount);
  const complete = error == null || confirmed;
  return {
    at,
    ids: parsed.raindropIds,
    byUrlKey: parsed.byKey,
    urlById: parsed.urlById,
    complete,
    count,
    urlIndexed: true,
    lastCompleteCount: complete ? count : previousCompleteCount,
    seq,
    suspectCount: complete ? null : count,
    ...(error && !confirmed ? { error } : {}),
  };
}

/** Durable form: ids only (no URLs), about 6k short strings today. */
function toStored(snap) {
  return {
    at: snap.at,
    ids: [...snap.ids],
    complete: !!snap.complete,
    count: snap.count,
    lastCompleteCount: snap.lastCompleteCount || 0,
    seq: snap.seq || 0,
    suspectCount: snap.suspectCount ?? null,
  };
}

/** @returns {PresenceSnapshot|null} */
function fromStored(stored) {
  if (!stored || typeof stored.at !== "number" || !Array.isArray(stored.ids)) return null;
  return {
    at: stored.at,
    ids: new Set(stored.ids.map(String)),
    byUrlKey: new Map(),
    urlById: new Map(),
    complete: !!stored.complete,
    count: Number(stored.count) || stored.ids.length,
    urlIndexed: false,
    lastCompleteCount: Number(stored.lastCompleteCount) || 0,
    seq: Number(stored.seq) || 0,
    suspectCount: stored.suspectCount ?? null,
  };
}

/**
 * Current snapshot: memory first, then the durable ids from storage.
 * @returns {Promise<PresenceSnapshot|null>}
 */
export async function loadPresence() {
  if (memory) return memory;
  memory = fromStored(await read(KEY.PRESENCE, null));
  return memory;
}

/** @param {PresenceSnapshot} snap */
export async function savePresence(snap) {
  memory = snap;
  await write(KEY.PRESENCE, toStored(snap));
}

/** Forget the in-memory snapshot (tests; simulates a worker restart). */
export function resetPresenceMemory() {
  memory = null;
}

/** Complete and young enough to act on absence (ids only). */
export function isUsableForAbsence(snap, now = Date.now()) {
  return !!snap && snap.complete && now - snap.at <= PRESENCE_MAX_AGE_MS;
}

/** Complete, young enough, and carrying the URL index (survival checks, rebind). */
export function isUsableForUrls(snap, now = Date.now()) {
  return isUsableForAbsence(snap, now) && snap.urlIndexed;
}

/**
 * Live raindrop ids whose URL shares a match key with `url`.
 * @param {PresenceSnapshot|null} snap
 * @param {string|null|undefined} url
 * @returns {string[]}
 */
export function idsForUrl(snap, url) {
  if (!snap?.byUrlKey || !url) return [];
  const out = [];
  for (const key of urlMatchKeys(url)) {
    for (const rid of snap.byUrlKey.get(key) || []) {
      if (!out.includes(rid)) out.push(rid);
    }
  }
  return out;
}

/**
 * Adopt export CSV fetched by another consumer (Match existing, Repair) as the
 * current snapshot, so one export serves both.
 * @param {string} csvText
 * @param {number} startedAt epoch ms captured before that export request
 * @returns {Promise<PresenceSnapshot>}
 */
export async function adoptExportCsv(csvText, startedAt) {
  const prev = await loadPresence();
  const next = buildSnapshot(csvText, {
    at: startedAt,
    previousCompleteCount: prev?.lastCompleteCount || 0,
    previousSuspectCount: prev?.suspectCount ?? null,
    expectNonEmpty: (await storedPairCount()) > 0,
    seq: (prev?.seq || 0) + 1,
  });
  await savePresence(next);
  return next;
}

/** Number of stored pairs, for the empty-export guard. Read-only, no lock. */
async function storedPairCount() {
  const stored = await read(KEY.PAIRS, null);
  if (stored?.records) return Object.keys(stored.records).length;
  if (stored?.byBookmark) return Object.keys(stored.byBookmark).length;
  return 0;
}

/**
 * Whether `reason` needs a new export given the current snapshot.
 * `afterSeq` (on-demand) also demands a later export than that snapshot.
 * @param {PresenceSnapshot|null} snap
 * @param {PresenceReason} reason
 * @param {{ now?: number, intervalMs?: number, afterSeq?: number|null }} [opts]
 */
export function presenceRefreshDue(
  snap,
  reason,
  { now = Date.now(), intervalMs = 0, afterSeq = null } = {}
) {
  if (reason === "pull-now") return true;
  if (!snap) return true;
  const age = now - snap.at;
  if (reason === "heartbeat") return age >= intervalMs;
  if (afterSeq != null && (snap.seq || 0) <= afterSeq) return true;
  return age >= PRESENCE_STALE_MS || !snap.urlIndexed;
}

/**
 * Return a snapshot, refreshing it first when `reason` says it is due.
 * Refresh needs a client and (when given) one spendable request; otherwise the
 * existing snapshot comes back with `unavailable: true`. Auth and rate-limit
 * errors propagate so callers keep their global pause handling; any other
 * export failure leaves the old snapshot in place.
 *
 * @param {{
 *   client?: import("./raindrop.js").RaindropClient|null,
 *   budget?: import("./wake-budget.js").WakeBudget|null,
 *   reason: PresenceReason,
 *   intervalMs?: number,
 *   afterSeq?: number|null,
 *   now?: number,
 * }} opts
 * @returns {Promise<{ snapshot: PresenceSnapshot|null, refreshed: boolean, due: boolean, unavailable?: boolean, error?: string }>}
 */
export async function ensurePresence({
  client,
  budget,
  reason,
  intervalMs = 0,
  afterSeq = null,
  now = Date.now(),
}) {
  const snap = await loadPresence();
  const due = presenceRefreshDue(snap, reason, { now, intervalMs, afterSeq });
  if (!due) return { snapshot: snap, refreshed: false, due };
  if (!client || (budget && !budget.canSpend(1))) {
    return { snapshot: snap, refreshed: false, due, unavailable: true };
  }
  // `at` is taken before the request: anything recorded at or before it
  // existed before the export began, so its absence from the export is real.
  const startedAt = Date.now();
  let csv;
  try {
    csv = await client.exportRaindropsCsv(0);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RateLimitError) throw err;
    return { snapshot: snap, refreshed: false, due, unavailable: true, error: err?.message };
  }
  const next = buildSnapshot(csv, {
    at: startedAt,
    previousCompleteCount: snap?.lastCompleteCount || 0,
    previousSuspectCount: snap?.suspectCount ?? null,
    expectNonEmpty: (await storedPairCount()) > 0,
    seq: (snap?.seq || 0) + 1,
  });
  await savePresence(next);
  return { snapshot: next, refreshed: true, due };
}
