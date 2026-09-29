// Trash hygiene snapshot: discovery debt for “safe to empty Raindrop Trash”.
//
// Apply debt (queued delete-edge) is separate — Status pending / Raindrop→Edge
// covers that. Safe-to-empty only needs a complete Trash peek with zero paired
// ids still needing enroll (not tombstoned, no queued delete-edge).
// Check Trash sweeps Trash across clicks (reconcile-finish sweepTrash): each
// click resumes where the last stopped, and the sweep completes only after a
// head rescan finds nothing new. Ids a partial sweep found stay pending until
// enrolled. Emptying Trash early loses the Trash signal: snapshot absence
// still finds the delete only while absence deletes are enabled and the pair
// migration is complete.
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
 * Short Status line for trash-safe state (bidirectional only).
 * @param {{
 *   trashHygieneAt?: number|null,
 *   trashScanComplete?: boolean,
 *   trashPairedPending?: number,
 * }|null|undefined} snapshot
 * @param {TrashSafeState} [state]
 * @returns {string}
 */
export function formatTrashSafeNotice(snapshot, state = deriveTrashSafeState(snapshot)) {
  switch (state) {
    case "safe":
      return "Safe to empty Raindrop Trash.";
    case "waiting": {
      const n = Number(snapshot?.trashPairedPending) || 0;
      return `Don't empty Trash yet — ${n} delete(s) still syncing.`;
    }
    case "partial":
      return "Raindrop Trash scan incomplete — click Check Trash again.";
    case "unknown":
    default:
      return "Click Check Trash before emptying Raindrop Trash.";
  }
}

/** Button label for the trash hygiene control (each click continues the sweep). */
export function trashSafeButtonLabel(_state) {
  return "Check Trash";
}

/**
 * Persist trash hygiene fields onto reconcile state.
 * @param {{
 *   scanComplete: boolean,
 *   pendingIds?: string[],
 *   pairedPending?: number,
 *   source?: "reconcile"|"check-trash",
 *   at?: number,
 * }} opts
 */
export async function writeTrashHygieneSnapshot({
  scanComplete,
  pendingIds,
  pairedPending,
  source = "reconcile",
  at = Date.now(),
}) {
  const ids = Array.isArray(pendingIds) ? pendingIds.map(String) : [];
  const count = Array.isArray(pendingIds) ? ids.length : Number(pairedPending) || 0;
  await setReconcileState({
    trashHygieneAt: at,
    trashScanComplete: !!scanComplete,
    trashPairedPending: Math.max(0, count),
    trashPendingIds: ids,
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
    buttonLabel: trashSafeButtonLabel(state),
    trashHygieneAt: snapshot?.trashHygieneAt ?? null,
    trashScanComplete: !!snapshot?.trashScanComplete,
    trashPairedPending: Number(snapshot?.trashPairedPending) || 0,
    trashHygieneSource: snapshot?.trashHygieneSource ?? null,
  };
}
