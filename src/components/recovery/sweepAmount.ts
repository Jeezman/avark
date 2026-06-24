// Rough fee buffer for the form's "max after fee" *prefill* only. The backend
// sizes the real fee from the live fee rate and clamps the sent amount to
// whatever's left after it, so this no longer has to be exact — it just seeds a
// sensible default the user can edit. (In a high-fee mempool the actual amount
// received may be a little lower than this suggests.)
export const SWEEP_FEE_BUFFER_SATS = 1000;

/** Most sats that can leave a sweep of `totalSat` worth of mature outputs. */
export function maxSweepSat(totalSat: number): number {
  return Math.max(0, totalSat - SWEEP_FEE_BUFFER_SATS);
}

/**
 * True when the mature pool can't produce any acceptable sweep: even sending
 * the whole pool minus the fee would land below the ASP's dust limit. The
 * only way out is waiting for more outputs to mature into the pool.
 */
export function poolBelowDust(totalSat: number, dustSat: number): boolean {
  return maxSweepSat(totalSat) < dustSat;
}

export type SweepAmountError =
  | { kind: "invalid" }
  | { kind: "belowDust"; dustSat: number }
  | { kind: "exceedsMax"; maxSat: number };

/**
 * Why `amountSat` can't be swept from a pool of `totalSat`, or `null` if it
 * can. Mirrors the SDK's `send_on_chain` checks (dust floor, fixed fee) so
 * the form rejects impossible amounts before invoking the backend.
 */
export function sweepAmountError(
  amountSat: number,
  totalSat: number,
  dustSat: number,
): SweepAmountError | null {
  if (!Number.isInteger(amountSat) || amountSat <= 0) {
    return { kind: "invalid" };
  }
  if (amountSat < dustSat) {
    return { kind: "belowDust", dustSat };
  }
  const maxSat = maxSweepSat(totalSat);
  if (amountSat > maxSat) {
    return { kind: "exceedsMax", maxSat };
  }
  return null;
}
