// Chromium bookmark top-root roles ↔ canonical Raindrop titles.
//
// Local browsers disagree on labels (Edge: Favorites bar / Other favorites;
// Chrome: Bookmarks bar / Other bookmarks). Raindrop always stores the
// Chrome-style canonical titles so one account works across Chromium browsers.
// Nested user folder titles are never rewritten.

/** Canonical Raindrop title for the bookmarks toolbar root. */
export const CANONICAL_TOOLBAR = "Bookmarks bar";

/** Canonical Raindrop title for the “other bookmarks” root. */
export const CANONICAL_OTHER = "Other bookmarks";

/** Legacy sync-root collection title from the Edge-branded product. */
export const LEGACY_ROOT_NAME = "Edge";

/** Default sync-root collection title for new installs. */
export const DEFAULT_ROOT_NAME = "Bookmarks";

const TOOLBAR_ALIASES = new Set([
  "favorites bar",
  "bookmarks bar",
  "bookmarks toolbar",
]);

const OTHER_ALIASES = new Set(["other favorites", "other bookmarks"]);

/**
 * Classify a folder title as a Chromium top-root role, or null if ordinary.
 * Uses an explicit alias list so a Raindrop collection named only "Other"
 * is not treated as the browser’s other-bookmarks root.
 * @param {string|null|undefined} title
 * @returns {"toolbar"|"other"|null}
 */
export function rootRole(title) {
  const t = (title || "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (OTHER_ALIASES.has(lower)) return "other";
  if (TOOLBAR_ALIASES.has(lower)) return "toolbar";
  // Locale / odd Chromium variants: "X bar" / "X toolbar" as whole title.
  if (/^(bookmarks?|favorites?)(\s+bar|\s+toolbar)$/i.test(t)) return "toolbar";
  if (/^other\s+(bookmarks|favorites)$/i.test(t)) return "other";
  return null;
}

/**
 * Map a local (or Raindrop) root title to the canonical Raindrop spelling.
 * Non-root titles are returned unchanged.
 * @param {string|null|undefined} title
 * @returns {string}
 */
export function canonicalRootTitle(title) {
  const role = rootRole(title);
  if (role === "toolbar") return CANONICAL_TOOLBAR;
  if (role === "other") return CANONICAL_OTHER;
  return title == null ? "" : String(title);
}

/**
 * True when two titles name the same top-root role (or are equal ignoring case).
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 */
export function rootTitlesEqual(a, b) {
  if ((a || "").toLowerCase() === (b || "").toLowerCase()) return true;
  const ra = rootRole(a);
  const rb = rootRole(b);
  return ra != null && ra === rb;
}

/**
 * Rewrite the first path segment when it is a known toolbar/other root.
 * @param {string[]} segments
 * @returns {string[]}
 */
export function canonicalizeUploadSegments(segments) {
  const segs = segments || [];
  if (!segs.length) return [];
  const [first, ...rest] = segs;
  if (!rootRole(first)) return [...segs];
  return [canonicalRootTitle(first), ...rest];
}

/**
 * Find a local top root matching a Raindrop (or local) title via alias equality.
 * @param {Array<{ id: string, title?: string }>} topRoots
 * @param {string} title
 * @returns {{ id: string, title?: string }|null}
 */
export function findTopRootByAlias(topRoots, title) {
  const tops = topRoots || [];
  return tops.find((t) => rootTitlesEqual(t.title, title)) || null;
}
