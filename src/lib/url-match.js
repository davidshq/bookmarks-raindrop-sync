// Stable URL keys for matching Edge bookmarks ↔ Raindrop links.
// Strongest (exact) key first; an optional second key drops known tracking
// params (utm_*, fbclid, si, …). Only tracking params are dropped: a query
// that selects content (watch?v=A vs watch?v=B, item?id=1 vs item?id=2) is
// part of the URL's identity and never produces a shared key. Lookups still
// prefer the exact key and accept a loose hit only when it is the sole
// candidate (resolveIndexedUrls).

/** Query params that only track the visit, never select the content. */
const TRACKING_PARAM =
  /^(utm(_\w+)?|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_ga|_gl|si|ref_src)$/i;

/**
 * `search` without tracking params, keeping the rest verbatim (no
 * re-encoding, so the result lines up with other URLs' exact keys).
 * @param {string} search e.g. "?v=A&utm_source=x"
 */
function stripTrackingParams(search) {
  const kept = search
    .slice(1)
    .split("&")
    .filter((part) => {
      const name = part.split("=")[0];
      let decoded = name;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, " "));
      } catch {
        // malformed escape: compare the raw name
      }
      return part !== "" && !TRACKING_PARAM.test(decoded);
    });
  return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * @param {string} u
 * @returns {string[]}
 */
export function urlMatchKeys(u) {
  const keys = [];
  const add = (s) => {
    if (s && !keys.includes(s)) keys.push(s);
  };
  try {
    const x = new URL(u);
    x.hash = "";
    x.hostname = x.hostname.replace(/^www\./i, "").toLowerCase();
    x.protocol = x.protocol.toLowerCase();
    // Lowercase host only — keep path/query case (some servers care).
    let href = x.href;
    if (href.endsWith("/") && x.pathname !== "/") {
      href = href.slice(0, -1);
      x.href = href;
    }
    add(href);
    // Second key: same URL without tracking params.
    if (x.search) {
      const search = stripTrackingParams(x.search);
      if (search !== x.search) {
        x.search = search;
        let clean = x.href;
        if (clean.endsWith("/") && x.pathname !== "/") clean = clean.slice(0, -1);
        add(clean);
      }
    }
  } catch {
    add(
      String(u || "")
        .trim()
        .replace(/#.*$/, "")
        .replace(/\/$/, "")
        .toLowerCase()
    );
  }
  return keys;
}

/**
 * How `candidateUrl` relates to `url` under urlMatchKeys.
 * @param {string} url
 * @param {string} candidateUrl
 * @returns {'exact'|'loose'|null}
 */
export function urlMatchKind(url, candidateUrl) {
  const want = urlMatchKeys(url);
  const got = urlMatchKeys(candidateUrl || "");
  if (!want.length || !got.length) return null;
  if (want[0] === got[0]) return "exact";
  if (want.some((k) => got.includes(k))) return "loose";
  return null;
}

/**
 * Resolve ids from a urlMatchKeys-indexed map for `url`.
 * Exact (primary) key wins. The tracking-stripped key is used only when it
 * maps to a single id; a lookup without tracking params likewise accepts a
 * single tracking variant filed under its exact key. Callers must not rewrite
 * `link` on a loose match.
 *
 * @param {Map<string, string[]>|Record<string, string[]>} byUrlKey
 * @param {string} url
 * @param {(id: string) => string|null|undefined} primaryKeyOf
 *   Primary urlMatchKeys entry for each candidate (separates exact hits
 *   from tracking variants filed under the same key).
 * @returns {{ ids: string[], match: 'exact'|'loose'|'none' }}
 */
export function resolveIndexedUrls(byUrlKey, url, primaryKeyOf) {
  const keys = urlMatchKeys(url);
  if (!keys.length || !byUrlKey) return { ids: [], match: "none" };
  const bucket = (key) => {
    if (!key) return [];
    const raw = typeof byUrlKey.get === "function" ? byUrlKey.get(key) : byUrlKey[key];
    return raw || [];
  };

  const exactKey = keys[0];
  const underExact = [];
  const seenExact = new Set();
  for (const id of bucket(exactKey)) {
    const s = String(id);
    if (seenExact.has(s)) continue;
    seenExact.add(s);
    underExact.push(s);
  }
  const exactIds = underExact.filter((id) => primaryKeyOf(id) === exactKey);
  if (exactIds.length) return { ids: exactIds, match: "exact" };

  // Loose: tracking-stripped key when present; otherwise the exact key's other
  // occupants (the lookup had no tracking params; its variants are filed there).
  const looseIds = [];
  const seenLoose = new Set();
  const looseBuckets = keys[1] ? [keys[1]] : underExact.length ? [exactKey] : [];
  for (const key of looseBuckets) {
    for (const id of key === exactKey ? underExact : bucket(key)) {
      const s = String(id);
      if (seenLoose.has(s)) continue;
      seenLoose.add(s);
      looseIds.push(s);
    }
  }
  if (looseIds.length === 1) return { ids: looseIds, match: "loose" };
  return { ids: [], match: "none" };
}

/**
 * True when two URLs are the same bookmark target after the browser's own
 * normalization (WHATWG URL parsing, which Chromium applies on bookmark
 * create/update). Raindrop keeps links verbatim, so `https://example.com`
 * there becomes `https://example.com/` in the browser; a raw string compare
 * then reports a difference on every reconcile and writes the same URL back
 * forever (WebAwesome: 228 identical pull-updates, Sep 18–28 2026).
 * Deliberately stricter than urlMatchKeys: query, case of path, and `www.`
 * still count as real differences.
 * @param {string} a
 * @param {string} b
 */
export function sameBookmarkUrl(a, b) {
  if ((a || "") === (b || "")) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
