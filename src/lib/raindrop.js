// Authenticated Raindrop.io REST client.
//
// Covers token check, collections, raindrop create/list/update/delete.
// Edge-owned writes only ever send link/title/collection (plus pleaseParse on
// create). Never send empty tags/notes — that would clear Raindrop-rich fields.
//
// Error types the drain reacts to:
//   AuthError      -> token bad/expired: halt deletions, keep jobs queued.
//   RateLimitError -> HTTP 429 *or* remaining budget exhausted: back off until
//                     `retryAt`, keep jobs queued. Prefer pausing before 429.
//   RaindropError  -> other HTTP failures; `status` is set when known.
//                     Response bodies are summarized (HTML error pages collapse
//                     to a short phrase; long JSON/text is capped).
//
// isNotFoundError() is the single “resource already gone” check (prefer
// status === 404; message fallback for mocks / older throws).
// raindropCollectionId() is the single collection-id extractor ($id || id).
//
// X-RateLimit-Reset is normalized once via #parseResetAt (epoch ms or seconds).

import { RAINDROP_API, RATE_LIMIT_FALLBACK_MS, RATE_LIMIT_RESERVE } from "./constants.js";

export class AuthError extends Error {}
export class RateLimitError extends Error {
  /**
   * @param {number} retryAt epoch ms when Raindrop work may resume
   * @param {{ proactive?: boolean }} [opts]
   */
  constructor(retryAt, { proactive = false } = {}) {
    super(
      proactive
        ? "Raindrop rate limit budget low; pausing before 429"
        : "Raindrop rate limit (HTTP 429)"
    );
    this.retryAt = retryAt;
    this.proactive = proactive;
  }
}
export class RaindropError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null }} [opts]
   */
  constructor(message, { status = null } = {}) {
    super(message);
    this.status = status;
  }
}

/**
 * True when the error means the raindrop/resource is already gone (HTTP 404).
 * Prefer `err.status`; fall back to a word-boundary 404 in the message for
 * test doubles that throw plain Errors.
 * @param {unknown} err
 */
export function isNotFoundError(err) {
  if (!err || typeof err !== "object") return false;
  const status = /** @type {{ status?: unknown }} */ (err).status;
  if (typeof status === "number") return status === 404;
  const message = /** @type {{ message?: unknown }} */ (err).message;
  return typeof message === "string" && /\b404\b/.test(message);
}

/**
 * Collection id from a raindrop item. API payloads use `collection.$id`;
 * some mocks / older shapes use `collection.id`.
 * @param {{ collection?: { $id?: unknown, id?: unknown } }|null|undefined} item
 * @returns {unknown}
 */
export function raindropCollectionId(item) {
  return item?.collection?.$id ?? item?.collection?.id;
}

/**
 * Compact body for activity-log errors. Cloudflare/App Platform HTML pages are
 * replaced with a short phrase; other bodies are single-lined and capped.
 * @param {string} text
 * @param {number} status
 * @returns {string}
 */
export function summarizeHttpErrorBody(text, status) {
  const t = (text || "").trim();
  if (!t) return "";
  if (/<!DOCTYPE/i.test(t) || /<html[\s>]/i.test(t)) {
    if (status === 521) return "(Cloudflare: origin web server down)";
    if (status === 502 || status === 503 || status === 504) {
      return "(upstream unavailable)";
    }
    return "(HTML error page)";
  }
  const oneLine = t.replace(/\s+/g, " ");
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
}

export class RaindropClient {
  constructor(token) {
    this.token = token;
    /** @type {number|null} */
    this._remaining = null;
    /** @type {number|null} epoch ms from X-RateLimit-Reset */
    this._resetAt = null;
    /** @type {{ noteRequest: (client: RaindropClient, n?: number) => void }|null} */
    this._budget = null;
  }

  /** Latest X-RateLimit-Remaining, or null if never observed. */
  get remaining() {
    return this._remaining;
  }

  /** Latest X-RateLimit-Reset as epoch ms, or null. */
  get resetAt() {
    return this._resetAt;
  }

  /**
   * Seed remaining/reset from a persisted rate window (SW restart).
   * @param {{ remaining?: number|null, resetAt?: number|null }} window
   */
  hydrateRateWindow(window) {
    if (window?.remaining != null && !Number.isNaN(Number(window.remaining))) {
      this._remaining = Number(window.remaining);
    }
    if (window?.resetAt != null && !Number.isNaN(Number(window.resetAt))) {
      this._resetAt = Number(window.resetAt);
    }
  }

  /**
   * Attach a per-wake budget so each HTTP call updates spendable.
   * @param {{ noteRequest: (client: RaindropClient, n?: number) => void }|null} budget
   */
  bindBudget(budget) {
    this._budget = budget;
  }

  /**
   * True when the last response left little quota — callers should stop the
   * current tick and wait for `pauseUntil()` rather than risk a hard 429.
   */
  shouldPause() {
    return this._remaining != null && this._remaining <= RATE_LIMIT_RESERVE;
  }

  /** Epoch ms to wait until after a soft (header) pause. */
  pauseUntil() {
    if (this._resetAt != null && this._resetAt > Date.now()) return this._resetAt;
    return Date.now() + RATE_LIMIT_FALLBACK_MS;
  }

  async request(method, path, body) {
    const res = await fetch(`${RAINDROP_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    this.#noteRateHeaders(res);
    this._budget?.noteRequest(this);

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Raindrop rejected the token (HTTP ${res.status})`);
    }
    if (res.status === 429) {
      throw new RateLimitError(Date.now() + this.#retryAfterMs(res));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = summarizeHttpErrorBody(text, res.status);
      throw new RaindropError(
        detail
          ? `Raindrop ${method} ${path} failed: ${res.status} ${detail}`
          : `Raindrop ${method} ${path} failed: ${res.status}`,
        { status: res.status }
      );
    }
    // DELETE may return an empty body.
    if (res.status === 204) return {};
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  /**
   * Parse X-RateLimit-Reset to epoch ms. Raindrop usually sends seconds;
   * values already in ms (> 1e12) pass through unchanged.
   * @returns {number|null}
   */
  #parseResetAt(res) {
    const reset = res.headers.get("X-RateLimit-Reset");
    if (reset == null || Number.isNaN(Number(reset))) return null;
    const n = Number(reset);
    return n > 1e12 ? n : n * 1000;
  }

  #noteRateHeaders(res) {
    const remaining = res.headers.get("X-RateLimit-Remaining");
    if (remaining != null && !Number.isNaN(Number(remaining))) {
      this._remaining = Number(remaining);
    }
    const resetAt = this.#parseResetAt(res);
    if (resetAt != null) this._resetAt = resetAt;
  }

  #retryAfterMs(res) {
    const retryAfter = res.headers.get("Retry-After");
    if (retryAfter && !Number.isNaN(Number(retryAfter))) {
      return Number(retryAfter) * 1000;
    }
    const resetAt = this.#parseResetAt(res);
    if (resetAt != null) {
      const ms = resetAt - Date.now();
      if (ms > 0) return ms;
    }
    return RATE_LIMIT_FALLBACK_MS;
  }

  /** Throw RateLimitError when headers say we should stop making more calls. */
  throwIfShouldPause() {
    if (!this.shouldPause()) return;
    throw new RateLimitError(this.pauseUntil(), { proactive: true });
  }

  // Confirms the token works and returns the account user object.
  async getUser() {
    const data = await this.request("GET", "/user");
    return data.user;
  }

  // Top-level (root) collections.
  async getRootCollections() {
    const data = await this.request("GET", "/collections");
    return data.items ?? [];
  }

  // All nested (child) collections across the account.
  async getChildCollections() {
    const data = await this.request("GET", "/collections/childrens");
    return data.items ?? [];
  }

  // Create a collection. Pass parentId = null for a root-level collection.
  async createCollection(title, parentId) {
    const body = { title };
    if (parentId != null) body.parent = { $id: parentId };
    const data = await this.request("POST", "/collection", body);
    return data.item;
  }

  /**
   * Field-selective collection update (e.g. Edge folder rename → title only).
   * @param {number|string} id
   * @param {{ title?: string }} [fields]
   */
  async updateCollection(id, { title } = {}) {
    const body = {};
    if (title != null) body.title = title;
    if (Object.keys(body).length === 0) return null;
    const data = await this.request("PUT", `/collection/${id}`, body);
    return data.item;
  }

  // Create a raindrop (bookmark) inside a collection. `pleaseParse` asks
  // Raindrop to enrich metadata (cover, excerpt) from the link. Rich fields
  // are intentionally omitted so we never clear tags/notes/highlights.
  async createRaindrop({ link, title, collectionId }) {
    const data = await this.request("POST", "/raindrop", {
      link,
      title: title || link,
      collection: { $id: collectionId },
      pleaseParse: {},
    });
    return data.item;
  }

  /**
   * List raindrops in a collection (paginated).
   * Use collectionId `-99` for Trash (soft-deleted items); `0` for all except Trash.
   * @param {number|string} collectionId
   * @param {{ page?: number, perPage?: number, nested?: boolean, search?: string }} [opts]
   */
  async listRaindrops(
    collectionId,
    { page = 0, perPage = 50, nested = false, search = undefined } = {}
  ) {
    const params = new URLSearchParams({
      page: String(page),
      perpage: String(Math.min(perPage, 50)),
    });
    if (nested) params.set("nested", "true");
    if (search != null && String(search).trim() !== "") {
      params.set("search", String(search));
    }
    const data = await this.request("GET", `/raindrops/${collectionId}?${params}`);
    return {
      items: data.items ?? [],
      count: data.count ?? data.items?.length ?? 0,
    };
  }

  /**
   * Library-wide search (collection `0` = all except Trash). Callers MUST
   * hard-filter hits (e.g. urlMatchKeys) — Raindrop search is not exact-URL.
   * @param {string} query
   * @param {{ perPage?: number }} [opts]
   */
  async searchRaindrops(query, { perPage = 50 } = {}) {
    return this.listRaindrops(0, { page: 0, perPage, search: query });
  }

  async getRaindrop(id) {
    const data = await this.request("GET", `/raindrop/${id}`);
    return data.item;
  }

  /**
   * Field-selective update for Edge-owned fields only.
   * Never pass tags/notes/highlights/cover/excerpt — empty values clear them.
   */
  async updateRaindrop(id, { link, title, collectionId } = {}) {
    const body = {};
    if (link != null) body.link = link;
    if (title != null) body.title = title;
    if (collectionId != null) body.collection = { $id: collectionId };
    if (Object.keys(body).length === 0) return null;
    const data = await this.request("PUT", `/raindrop/${id}`, body);
    return data.item;
  }

  /** Soft-delete: moves the raindrop to Trash (not permanent). */
  async deleteRaindrop(id) {
    await this.request("DELETE", `/raindrop/${id}`);
  }

  /**
   * Full-library CSV dump (`collectionId` 0 = all except Trash). One request;
   * columns include id/url but not collection path — use for presence only.
   * @param {number|string} [collectionId=0]
   * @returns {Promise<string>} raw CSV text
   */
  async exportRaindropsCsv(collectionId = 0) {
    const data = await this.request("GET", `/raindrops/${collectionId}/export.csv`);
    if (typeof data?.raw === "string" && data.raw.length) return data.raw;
    throw new RaindropError("Raindrop export.csv did not return CSV text");
  }
}
