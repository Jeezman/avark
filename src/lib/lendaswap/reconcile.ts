/**
 * On-startup reconciliation for LendaSwap swaps.
 *
 * Replaces the Rust-side `reconcile_pending`. 
 * When a swap entry/history/checkout screen mounts, we fetch every
 * non-terminal row from the Rust DB and refresh each via the TS SDK — so
 * statuses that flipped while avark was closed (e.g. `awaiting_payment` →
 * `processing`) catch up before the user sees the UI.
 *
 * Module-level memoization ensures the reconciler only fires once per app
 * session regardless of how many routes call it. A full remount (cold start,
 * wallet switch) recreates the module scope and lets it fire again.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTerminalSwapStatus, refreshSwap } from "./client";

interface MinimalSwapRow {
  id: string;
  lendaswap_id: string;
  status: string;
}

const MAX_ROWS = 100;

let reconcilePromise: Promise<void> | null = null;

/**
 * Idempotent per-session. First call runs the reconciliation; subsequent
 * calls return the in-flight or completed promise.
 */
export function reconcilePendingSwaps(): Promise<void> {
  if (!reconcilePromise) {
    reconcilePromise = runReconcile();
  }
  return reconcilePromise;
}

async function runReconcile(): Promise<void> {
  let rows: MinimalSwapRow[] = [];
  try {
    rows = await invoke<MinimalSwapRow[]>("list_lendaswap_swaps", {
      limit: MAX_ROWS,
      offset: 0,
      status: null,
    });
  } catch (e) {
    console.warn("[lendaswap/reconcile] failed to load pending swaps:", e);
    return;
  }

  const pending = rows.filter((r) => !isTerminalSwapStatus(r.status));
  if (pending.length === 0) return;
  console.info(
    `[lendaswap/reconcile] refreshing ${pending.length} non-terminal swap(s)`,
  );

  for (const row of pending) {
    try {
      await refreshSwap(row.id, row.lendaswap_id);
    } catch (e) {
      console.warn(
        `[lendaswap/reconcile] refresh failed for ${row.id}:`,
        e,
      );
      // Keep going — one bad row shouldn't block the rest.
    }
  }
}

/**
 * Test/dev escape hatch. Not exposed to the UI.
 */
export function resetReconcile(): void {
  reconcilePromise = null;
}
