// Parse Raindrop export.csv (id + url presence; no collection path column).

import { urlMatchKeys } from "./url-match.js";

/**
 * Minimal RFC4180 CSV parse (quoted fields, "" escapes, BOM strip).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const s = String(text || "").replace(/^\uFEFF/, "");
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Index export.csv by URL match keys → raindrop id(s).
 * @param {string} csvText
 * @returns {{
 *   byKey: Map<string, string[]>,
 *   raindropIds: Set<string>,
 *   raindropCount: number,
 * }}
 */
export function indexExportByUrl(csvText) {
  const rows = parseCsvRows(csvText);
  /** @type {Map<string, string[]>} */
  const byKey = new Map();
  const raindropIds = new Set();
  if (rows.length < 2) {
    return { byKey, raindropIds, raindropCount: 0 };
  }

  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const idIdx = header.indexOf("id");
  const urlIdx = header.indexOf("url");
  if (idIdx < 0 || urlIdx < 0) {
    throw new Error("export.csv missing id/url columns");
  }

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const url = cols[urlIdx];
    const id = cols[idIdx];
    if (!url || !id) continue;
    const rid = String(id);
    raindropIds.add(rid);
    for (const key of urlMatchKeys(url)) {
      const list = byKey.get(key) || [];
      if (!list.includes(rid)) list.push(rid);
      byKey.set(key, list);
    }
  }
  return { byKey, raindropIds, raindropCount: raindropIds.size };
}
