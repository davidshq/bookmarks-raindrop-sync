// Trash hygiene snapshot: discovery debt for “safe to empty Raindrop Trash”.
//
// Apply debt (queued delete-edge) is separate — Status pending / Raindrop→Edge
// covers that. Safe-to-empty only needs a complete Trash peek with zero paired
// ids still needing enroll (not tombstoned, no queued delete-edge).
// See docs/raindrop-delete-detection-options.md and OpenSpec trash-safe-status.

import { getReconcileState, setReconcileState } from "./store.js";

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
      return "Still checking Raindrop Trash — click Continue.";
    case "unknown":
    default:
      return "Click Check Trash before emptying Raindrop Trash.";
  }
}

/** Button label for the trash hygiene control. */
export function trashSafeButtonLabel(state) {
  return state === "partial" ? "Continue" : "Check Trash";
}

/**
 * Persist trash hygiene fields onto reconcile state.
 * @param {{
 *   scanComplete: boolean,
 *   pairedPending: number,
 *   source?: "reconcile"|"check-trash",
 *   nextPage?: number,
 *   at?: number,
 * }} opts
 */
export async function writeTrashHygieneSnapshot({
  scanComplete,
  pairedPending,
  source = "reconcile",
  nextPage = 0,
  at = Date.now(),
}) {
  await setReconcileState({
    trashHygieneAt: at,
    trashScanComplete: !!scanComplete,
    trashPairedPending: Math.max(0, Number(pairedPending) || 0),
    trashHygieneSource: source === "check-trash" ? "check-trash" : "reconcile",
    trashHygieneNextPage: scanComplete ? 0 : Math.max(0, Number(nextPage) || 0),
  });
}

/**
 * Status payload fragment from reconcile / trash hygiene fields.
 * @param {{
 *   trashHygieneAt?: number|null,
 *   trashScanComplete?: boolean,
 *   trashPairedPending?: number,
 *   trashHygieneSource?: string|null,
 *   trashHygieneNextPage?: number,
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
    trashHygieneNextPage: Number(snapshot?.trashHygieneNextPage) || 0,
  };
}

/** @returns {Promise<number>} next Trash list page for an explicit Check Trash continue */
export async function getTrashHygieneNextPage() {
  const state = await getReconcileState();
  return Math.max(0, Number(state.trashHygieneNextPage) || 0);
}
