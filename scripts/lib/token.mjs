/**
 * Raindrop test token lookup for the live scripts (integration, smoke).
 * Kept apart from test-harness.mjs so callers that only need the token do not
 * install the in-memory chrome.* mocks as an import side effect.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives in scripts/lib). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** RAINDROP_TOKEN, else .tmp/raindrop_token, else "". */
export function loadToken() {
  if (process.env.RAINDROP_TOKEN) return process.env.RAINDROP_TOKEN.trim();
  const p = path.join(REPO_ROOT, ".tmp", "raindrop_token");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return "";
}
