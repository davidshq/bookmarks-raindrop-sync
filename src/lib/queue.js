// Durable job queue, persisted entirely in chrome.storage.local.
//
// Jobs are typed:
//   { id, kind, attempts, nextAttemptAt, ...payload }
// Legacy jobs with only `{ id }` are treated as upload jobs (id = bookmarkId).
// Enqueue is idempotent per job id.
//
// After MAX_JOB_ATTEMPTS transient failures, defer moves the job into
// KEY.DEAD_LETTER (same withLock) so poison work stops consuming drain budget.
// QUEUE and DEAD_LETTER are written in one storage.set so a quota failure
// cannot drop the job from both lists. Rate-limit deferUntil does not
// increment attempts and never dead-letters.
//
// Mutations go through withLock so drain/remove cannot race enqueue and drop jobs.

import {
  KEY,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_JOB_ATTEMPTS,
  DEAD_LETTER_LIMIT,
  JOB,
} from "./constants.js";
import { _read, _write, _writeMany } from "./store.js";
import { withLock } from "./mutex.js";
import { noteQueueDepthForBulkPrompt } from "./queue-bulk-prompt.js";

async function readQueue() {
  return _read(KEY.QUEUE, []);
}

async function writeQueue(jobs) {
  await _write(KEY.QUEUE, jobs);
}

async function readDeadLetter() {
  return _read(KEY.DEAD_LETTER, []);
}

async function writeDeadLetter(entries) {
  await _write(KEY.DEAD_LETTER, entries);
}

export function jobKind(job) {
  return job.kind || JOB.UPLOAD;
}

/** Job kinds that remove something on one side (delete circuit breaker scope). */
export const DELETE_JOB_KINDS = new Set([JOB.DELETE_EDGE, JOB.DELETE_RAINDROP]);

export function isDeleteJob(job) {
  return DELETE_JOB_KINDS.has(jobKind(job));
}

/** Raindrop→Edge jobs (pull creates/updates/renames, remote-delete → local delete). */
const RAINDROP_TO_EDGE_KINDS = new Set([
  JOB.PULL_CREATE,
  JOB.PULL_UPDATE,
  JOB.PULL_RENAME_FOLDER,
  JOB.DELETE_EDGE,
]);

/**
 * Sync direction for a job kind. Legacy jobs without `kind` default to upload
 * (Edge→Raindrop), matching {@link jobKind}.
 * @param {string} [kind]
 * @returns {"edgeToRaindrop"|"raindropToEdge"}
 */
export function jobDirection(kind) {
  return RAINDROP_TO_EDGE_KINDS.has(kind) ? "raindropToEdge" : "edgeToRaindrop";
}

/**
 * Count queued jobs by direction (Edge→Raindrop vs Raindrop→Edge).
 * @param {Array<{ kind?: string }>} jobs
 * @returns {{ total: number, edgeToRaindrop: number, raindropToEdge: number }}
 */
export function countByDirection(jobs) {
  let edgeToRaindrop = 0;
  let raindropToEdge = 0;
  for (const job of jobs) {
    if (jobDirection(jobKind(job)) === "raindropToEdge") raindropToEdge++;
    else edgeToRaindrop++;
  }
  return {
    total: edgeToRaindrop + raindropToEdge,
    edgeToRaindrop,
    raindropToEdge,
  };
}

/**
 * Human-readable pending breakdown for Status / popup.
 * @param {{ edgeToRaindrop?: number, raindropToEdge?: number }} counts
 */
export function formatPendingByDirection(counts) {
  const e2r = Number(counts?.edgeToRaindrop) || 0;
  const r2e = Number(counts?.raindropToEdge) || 0;
  return `Edge → Raindrop: ${e2r} · Raindrop → Edge: ${r2e}`;
}

/**
 * Drain ordering: lower runs first. Folder renames (Edge→Raindrop and
 * Raindrop→Edge) before uploads/pull-updates so a pending child job does not
 * ensureCollectionPath / ensureMirrorFolderPath on the new title and orphan
 * the mapped collection (create-new instead of in-place rename).
 */
export function drainJobPriority(kind) {
  return kind === JOB.RENAME_COLLECTION || kind === JOB.PULL_RENAME_FOLDER ? 0 : 1;
}

export async function list() {
  return readQueue();
}

export async function size() {
  return (await readQueue()).length;
}

/** Pending depth plus Edge→Raindrop / Raindrop→Edge splits. */
export async function sizeByDirection() {
  return countByDirection(await readQueue());
}

/**
 * Bookmark ids with a queued upload (their pair URL may lag a local edit),
 * each mapped to the dateAdded of the bookmark it was queued for (or null).
 * @returns {Promise<Map<string, number|null>>}
 */
export async function pendingUploadIds() {
  return new Map(
    (await readQueue())
      .filter((j) => jobKind(j) === JOB.UPLOAD)
      .map((j) => [String(j.id), typeof j.dateAdded === "number" ? j.dateAdded : null])
  );
}

export async function listDeadLetter() {
  return readDeadLetter();
}

export async function deadLetterSize() {
  return (await readDeadLetter()).length;
}

/**
 * Enqueue an upload job for a bookmark id (backward-compatible).
 * @param {string} id bookmark id
 * @param {{ reason?: "move"|"change", dateAdded?: number|null }} [opts]
 *   activity hint for paired drain; the node's dateAdded when the event had it
 *   (ties the job to that bookmark, not just the id)
 */
export async function enqueue(id, { reason, dateAdded } = {}) {
  return enqueueJob({
    id,
    kind: JOB.UPLOAD,
    ...(reason ? { reason } : {}),
    ...(typeof dateAdded === "number" ? { dateAdded } : {}),
  });
}

async function noteBulkPromptAfterMutation() {
  // Static import is required: ServiceWorkerGlobalScope forbids import().
  // Cycle is avoided because queue-bulk-prompt takes pending and does not
  // import this module.
  try {
    await noteQueueDepthForBulkPrompt(await size());
  } catch (err) {
    console.error("[ers] bulk prompt arm failed:", err);
  }
}

/** Fresh queue entry: upload by default, no attempts, due now. */
function newJob(fields) {
  return { kind: JOB.UPLOAD, ...fields, attempts: 0, nextAttemptAt: 0 };
}

/** Coalesce an activity hint onto a queued job: "move" wins, else first reason sticks. */
function mergeReason(existing, reason) {
  if (reason === "move") existing.reason = "move";
  else if (reason && !existing.reason) existing.reason = reason;
}

export async function enqueueJob(job) {
  const added = await withLock(async () => {
    const jobs = await readQueue();
    const existing = jobs.find((j) => j.id === job.id);
    if (existing) {
      // Promote activity hint when a move coalesces with an earlier change.
      mergeReason(existing, job.reason);
      // The latest event names the bookmark now at this id (ids can be reassigned).
      if (typeof job.dateAdded === "number") existing.dateAdded = job.dateAdded;
      await writeQueue(jobs);
      return false;
    }
    jobs.push({ attempts: 0, nextAttemptAt: 0, kind: JOB.UPLOAD, ...job });
    await writeQueue(jobs);
    return true;
  });
  await noteBulkPromptAfterMutation();
  return added;
}

/**
 * @param {string[]} ids
 * @param {{ reason?: "move"|"change", dateAddedById?: Map<string, number> }} [opts]
 *   dateAddedById: each node's dateAdded, as for {@link enqueue}
 */
export async function enqueueMany(ids, { reason, dateAddedById } = {}) {
  const added = await withLock(async () => {
    const jobs = await readQueue();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    let count = 0;
    for (const id of ids) {
      const existing = byId.get(id);
      const dateAdded = dateAddedById?.get(String(id));
      if (existing) {
        mergeReason(existing, reason);
        if (typeof dateAdded === "number") existing.dateAdded = dateAdded;
        continue;
      }
      const job = newJob({
        id,
        ...(reason ? { reason } : {}),
        ...(typeof dateAdded === "number" ? { dateAdded } : {}),
      });
      jobs.push(job);
      byId.set(id, job);
      count++;
    }
    await writeQueue(jobs);
    return count;
  });
  await noteBulkPromptAfterMutation();
  return added;
}

export async function remove(id) {
  return withLock(async () => {
    const jobs = await readQueue();
    await writeQueue(jobs.filter((j) => j.id !== id));
  });
}

/**
 * Merge fields onto an existing job (same lock as enqueue/remove).
 * Used for crash-safe intents: `offloadRaindropId` before a local delete,
 * `createAttemptedAt` before Raindrop create, `pullCreateAttemptedAt` before
 * Edge bookmark create — so a restarted drain can reclaim instead of duplicating.
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {Promise<boolean>} false if the job is no longer queued
 */
export async function patchJob(id, patch) {
  return withLock(async () => {
    const jobs = await readQueue();
    const job = jobs.find((j) => j.id === id);
    if (!job) return false;
    Object.assign(job, patch);
    await writeQueue(jobs);
    return true;
  });
}

// Jobs whose backoff window has elapsed. Folder renames are sorted ahead of
// other kinds so in-place collection rename wins over title-based path ensure.
export async function due(now) {
  const jobs = await readQueue();
  return jobs
    .filter((j) => (j.nextAttemptAt ?? 0) <= now)
    .sort((a, b) => drainJobPriority(jobKind(a)) - drainJobPriority(jobKind(b)));
}

/**
 * Defer a job with exponential backoff, or dead-letter when attempts hit the cap.
 * @param {string} id
 * @param {number} now
 * @param {{ lastError?: string }} [opts]
 * @returns {Promise<{ action: "missing"|"deferred"|"dead-lettered", attempts?: number }>}
 */
export async function defer(id, now, { lastError } = {}) {
  return withLock(async () => {
    const jobs = await readQueue();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx < 0) return { action: "missing" };
    const job = jobs[idx];
    job.attempts = (job.attempts ?? 0) + 1;

    if (job.attempts >= MAX_JOB_ATTEMPTS) {
      jobs.splice(idx, 1);
      const dead = await readDeadLetter();
      dead.unshift({
        ...job,
        lastError: lastError != null ? String(lastError) : null,
        deadAt: now,
      });
      // One set for both keys — never leave the job in neither list.
      await _writeMany({
        [KEY.QUEUE]: jobs,
        [KEY.DEAD_LETTER]: dead.slice(0, DEAD_LETTER_LIMIT),
      });
      return { action: "dead-lettered", attempts: job.attempts };
    }

    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (job.attempts - 1), MAX_BACKOFF_MS);
    job.nextAttemptAt = now + backoff;
    await writeQueue(jobs);
    return { action: "deferred", attempts: job.attempts };
  });
}

// Defer a job by an explicit delay (used for rate-limit Retry-After).
// Does not increment attempts and never dead-letters.
export async function deferUntil(id, until) {
  return patchJob(id, { nextAttemptAt: until });
}

/**
 * Push every currently-due job out to `until` so a rate-limit pause does not
 * leave a stampede of due work the moment the window opens (or on the next tick).
 * @param {number} until epoch ms
 * @param {number} [now]
 */
export async function deferAllDueUntil(until, now = Date.now()) {
  return withLock(async () => {
    const jobs = await readQueue();
    let changed = false;
    for (const job of jobs) {
      if ((job.nextAttemptAt ?? 0) <= now) {
        job.nextAttemptAt = until;
        changed = true;
      }
    }
    if (changed) await writeQueue(jobs);
  });
}

export async function clear() {
  return withLock(async () => {
    await writeQueue([]);
  });
}

/**
 * Remove every queued job matching `pred` (same lock as enqueue/remove).
 * @param {(job: object) => boolean} pred
 * @returns {Promise<number>} how many jobs were removed
 */
export async function removeWhere(pred) {
  return withLock(async () => {
    const jobs = await readQueue();
    const kept = jobs.filter((j) => !pred(j));
    if (kept.length !== jobs.length) await writeQueue(kept);
    return jobs.length - kept.length;
  });
}

/** Empty the dead-letter list without re-enqueueing. */
export async function clearDeadLetter() {
  return withLock(async () => {
    await writeDeadLetter([]);
  });
}

/**
 * Re-enqueue every dead-lettered job with attempts reset; clear the DLQ.
 * @returns {Promise<number>} how many jobs were re-enqueued
 */
export async function retryDeadLetter() {
  return withLock(async () => {
    const dead = await readDeadLetter();
    if (!dead.length) return 0;
    const jobs = await readQueue();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    let added = 0;
    for (const entry of dead) {
      const { lastError: _le, deadAt: _da, ...rest } = entry;
      const job = newJob(rest);
      if (byId.has(job.id)) continue;
      jobs.push(job);
      byId.set(job.id, job);
      added++;
    }
    // One set — avoid re-enqueued jobs still sitting in the DLQ after a partial write.
    await _writeMany({
      [KEY.QUEUE]: jobs,
      [KEY.DEAD_LETTER]: [],
    });
    return added;
  });
}
