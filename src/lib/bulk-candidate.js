// Local heuristics: should Options ask to Match-from-export before Import/Pull?
// No Raindrop API — uses scanImportScope() (same exclude / already-paired rules
// as Import enqueue).

import {
  BULK_UNPAIRED_IMPORT_THRESHOLD,
  BULK_EDGE_COUNT_THRESHOLD,
  BULK_PAIR_COVERAGE_THRESHOLD,
  SYNC_MODE,
} from "./constants.js";
import { getConfig } from "./store.js";
import { scanImportScope } from "./backfill.js";

/**
 * @typedef {{
 *   suggest: boolean,
 *   reason: 'large_unpaired' | 'low_pair_coverage' | null,
 *   unpaired: number,
 *   paired: number,
 *   edgeScanned: number,
 *   pairCoverage: number,
 * }} BulkCandidateAssessment
 */

/**
 * Count Edge URL bookmarks and how many Import would enqueue (unpaired, not excluded).
 * @returns {Promise<{ unpaired: number, paired: number, edgeScanned: number }>}
 */
export async function countImportScope() {
  const { unpaired, paired, edgeScanned } = await scanImportScope();
  return { unpaired, paired, edgeScanned };
}

/**
 * Pull-only heuristic: large Edge tree with thin pairs (not Import's unpaired queue size).
 * @param {{ unpaired: number, paired: number, edgeScanned: number }} scope
 * @returns {BulkCandidateAssessment}
 */
export function assessPullFromScope(scope) {
  const { unpaired, paired, edgeScanned } = scope;
  const inScope = unpaired + paired;
  const pairCoverage = inScope > 0 ? paired / inScope : 1;
  const base = { unpaired, paired, edgeScanned, pairCoverage };
  if (edgeScanned >= BULK_EDGE_COUNT_THRESHOLD && pairCoverage < BULK_PAIR_COVERAGE_THRESHOLD) {
    return { suggest: true, reason: "low_pair_coverage", ...base };
  }
  return { suggest: false, reason: null, ...base };
}

/**
 * Import heuristic: a large unpaired queue, else the Pull coverage rule.
 * @param {{ unpaired: number, paired: number, edgeScanned: number }} scope
 * @returns {BulkCandidateAssessment}
 */
export function assessFromScope(scope) {
  const pull = assessPullFromScope(scope);
  if (scope.unpaired >= BULK_UNPAIRED_IMPORT_THRESHOLD) {
    return { ...pull, suggest: true, reason: "large_unpaired" };
  }
  return pull;
}

/** @returns {Promise<BulkCandidateAssessment>} */
export async function assessImportBulkCandidate() {
  return assessFromScope(await countImportScope());
}

/**
 * Pull candidate: bidirectional + low pair coverage only
 * (Match reduces pull-create dupes). Does not use unpaired Import threshold.
 * @returns {Promise<BulkCandidateAssessment>}
 */
export async function assessPullBulkCandidate() {
  const config = await getConfig();
  if (config.syncMode !== SYNC_MODE.BIDIRECTIONAL) {
    return assessPullFromScope({ unpaired: 0, paired: 0, edgeScanned: 0 });
  }
  return assessPullFromScope(await countImportScope());
}

/**
 * Short explanation for confirm dialogs.
 * @param {BulkCandidateAssessment} a
 * @param {'import' | 'pull'} [op='import']
 */
export function formatBulkCandidatePrompt(a, op = "import") {
  const pct = Math.round((a.pairCoverage || 0) * 100);
  if (a.reason === "large_unpaired") {
    return (
      `This would queue about ${a.unpaired} unpaired bookmark(s) ` +
      `(${a.paired} already paired, ${a.edgeScanned} scanned).\n\n` +
      `Match from Raindrop export first so overlapping URLs are paired instead of re-uploaded?`
    );
  }
  const coverage = `Library looks large with low pair coverage (${a.paired} paired / ~${a.unpaired + a.paired} in-scope, ${pct}%).\n\n`;
  if (op === "pull") {
    return (
      coverage +
      `Match from Raindrop export first so URLs that already exist locally are paired before Pull?`
    );
  }
  return (
    coverage + `Match from Raindrop export first so overlapping URLs are paired before continuing?`
  );
}
