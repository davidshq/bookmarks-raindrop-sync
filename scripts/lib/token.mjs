/**
 * Raindrop test token lookup for the live scripts (integration, smoke).
 * Kept apart from test-harness.mjs so callers that only need the token do not
 * install the in-memory chrome.* mocks as an import side effect.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { RAINDROP_API } from "../../src/lib/constants.js";

/** Repository root (this file lives in scripts/lib). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Raindrop user id of the dedicated test account, kept beside the token (not
 * in the repo): RAINDROP_TEST_ACCOUNT_ID, else .tmp/raindrop_test_account_id.
 * Throws when unset so the account guard can never be silently skipped.
 * @returns {number}
 */
export function loadTestAccountId() {
  const p = path.join(REPO_ROOT, ".tmp", "raindrop_test_account_id");
  const raw =
    process.env.RAINDROP_TEST_ACCOUNT_ID ?? (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
  const id = Number(raw.trim());
  if (!raw.trim() || !Number.isInteger(id) || id <= 0) {
    throw new Error(
      "Test account id not set: put the test account's Raindrop user id in " +
        ".tmp/raindrop_test_account_id or RAINDROP_TEST_ACCOUNT_ID."
    );
  }
  return id;
}

/**
 * Abort unless `token` belongs to the test account. Call before any live write.
 * @param {string} token
 */
export async function assertTestAccount(token) {
  const expected = loadTestAccountId();
  const res = await fetch(`${RAINDROP_API}/user`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const id = (await res.json().catch(() => ({})))?.user?._id;
  if (id !== expected) {
    throw new Error(
      `Refusing to run live tests: token belongs to Raindrop user ${id ?? "?"} ` +
        `(HTTP ${res.status}), not the configured test account.`
    );
  }
}

/** RAINDROP_TOKEN, else .tmp/raindrop_token, else "". */
export function loadToken() {
  if (process.env.RAINDROP_TOKEN) return process.env.RAINDROP_TOKEN.trim();
  const p = path.join(REPO_ROOT, ".tmp", "raindrop_token");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return "";
}
