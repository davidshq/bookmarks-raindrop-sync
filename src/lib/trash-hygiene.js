// Trash hygiene snapshot: discovery debt for “safe to empty Raindrop Trash”.
//
// Apply debt (queued delete-edge) is separate — Status pending / Raindrop→Edge
// covers that. Safe-to-empty only needs a complete Trash peek with zero paired
// ids still needing enroll (not tombstoned, no queued delete-edge).
// See docs/raindrop-delete-detection-options.md and OpenSpec trash-safe-status.

import { setReconcileState } from "./store.js";

/** @typedef {"safe"|"waiting"|"partial"|"unknown"} TrashSafeState */

/**
 * Derive Status display state from a trash hygiene snapshot.
 * Never `safe` unless the last peek completed and paired-pending is 0.
 *
 * @param {{
 *   trashHygieneAt?: number|null,
 *   trashScanComplete?: boolean,
 *   trashPairedPending?: number,
 * }|null|undefined} snapshot
 * @returns {TrashSafeState}
 */
export function deriveTrashSafeState(snapshot) {
  if (snapshot == null || snapshot.trashHygieneAt == null) return "unknown";
  if (!snapshot.trashScanComplete) return "partial";
  const pending = Number(snapshot.trashPairedPending) || 0;
  if (pending > 0) return "waiting";
  return "safe";
}

/**
 * User-facing Status line for trash-safe state (bidirectional only).
 * @param {{
 *   trashHygieneAt?: number|null,
 *   trashScanComplete?: boolean,
 *   trashPairedPending?: number,
 * }|null|undefined} snapshot
 * @param {TrashSafeState} [state]
 * @returns {string}
 */
export function formatTrashSafeNotice(snapshot, state = deriveTrashSafeState(snapshot)) {
  const when =
    snapshot?.trashHygieneAt != null
      ? ` (as of ${new Date(snapshot.trashHygieneAt).toLocaleString()})`
      : "";
  switch (state) {
    case "safe":
      return `Safe to empty Raindrop Trash${when}. Discovery debt is clear; queued local deletes may still finish.`;
    case "waiting": {
      const n = Number(snapshot?.trashPairedPending) || 0;
      return (
        `Waiting on Trash sync: ${n} paired item(s) still need enroll${when}. ` +
        `Do not empty Raindrop Trash yet.`
      );
    }
    case "partial":
      return (
        `Trash peek incomplete${when} — deeper than we scanned this pass. ` +
        `Check Trash or wait for more heartbeats before emptying.`
      );
    case "unknown":
    default:
      return "Trash not checked yet — Check Trash or wait for a Raindrop pull before emptying Trash.";
  }
}

/**
 * Persist trash hygiene fields onto reconcile state.
 * @param {{
 *   scanComplete: boolean,
 *   pairedPending: number,
 *   source?: "reconcile"|"check-trash",
 *   at?: number,
 * }} opts
 */
export async function writeTrashHygieneSnapshot({
  scanComplete,
  pairedPending,
  source = "reconcile",
  at = Date.now(),
}) {
  await setReconcileState({
    trashHygieneAt: at,
    trashScanComplete: !!scanComplete,
    trashPairedPending: Math.max(0, Number(pairedPending) || 0),
    trashHygieneSource: source === "check-trash" ? "check-trash" : "reconcile",
  });
}

/**
 * Status payload fragment from reconcile / trash hygiene fields.
 * @param {{
 *   trashHygieneAt?: number|null,
 *   trashScanComplete?: boolean,
 *   trashPairedPending?: number,
 *   trashHygieneSource?: string|null,
 * }|null|undefined} snapshot
 */
export function buildTrashSafePayload(snapshot) {
  const state = deriveTrashSafeState(snapshot);
  return {
    state,
    notice: formatTrashSafeNotice(snapshot, state),
    trashHygieneAt: snapshot?.trashHygieneAt ?? null,
    trashScanComplete: !!snapshot?.trashScanComplete,
    trashPairedPending: Number(snapshot?.trashPairedPending) || 0,
    trashHygieneSource: snapshot?.trashHygieneSource ?? null,
  };
}
