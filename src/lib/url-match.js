// Stable URL keys for matching Edge bookmarks ↔ Raindrop links.
// Strongest key first; callers register/lookup all keys (hash/www/slash/query noise).

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
    // Second key: ignore query string (tracking params often differ).
    if (x.search) {
      x.search = "";
      let bare = x.href;
      if (bare.endsWith("/") && x.pathname !== "/") bare = bare.slice(0, -1);
      add(bare);
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
