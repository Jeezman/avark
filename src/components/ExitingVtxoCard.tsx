import { memo } from "react";
import { formatCountdown, formatSats } from "../utils/format";
import type { UnrolledVtxoMaturity } from "./recovery/SweepForm";

function truncateTxid(txid: string): string {
  if (txid.length <= 20) return txid;
  return `${txid.slice(0, 10)}...${txid.slice(-8)}`;
}

/**
 * A VTXO mid unilateral-exit: its exit tree is on-chain and the coin is no
 * longer offchain-spendable, but the CSV delay hasn't elapsed so it isn't
 * sweepable yet either.
 */
export const ExitingVtxoCard = memo(function ExitingVtxoCard({
  vtxo,
  now,
}: {
  vtxo: UnrolledVtxoMaturity;
  now: number;
}) {
  const remaining = vtxo.csvMatureAt !== null ? vtxo.csvMatureAt - now : null;

  return (
    <div className="rounded-xl px-4 py-3 theme-card opacity-60">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tabular-nums">
              {formatSats(vtxo.amountSat)}{" "}
              <span className="text-[10px] theme-text-faint">sats</span>
            </span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium theme-card-elevated theme-text-muted">
              Exiting
            </span>
          </div>
          <p className="text-[10px] theme-text-muted font-mono mt-0.5">
            {truncateTxid(vtxo.txid)}:{vtxo.vout}
          </p>
        </div>
        <div className="text-right shrink-0 ml-3">
          <p className="text-xs font-medium theme-text-muted">
            {vtxo.mature
              ? "Ready to sweep"
              : remaining !== null
                ? `Sweepable in ${formatCountdown(remaining)}`
                : "Awaiting confirmation"}
          </p>
          <p className="text-[10px] theme-text-faint mt-0.5">
            Settings → Emergency exit
          </p>
        </div>
      </div>
    </div>
  );
});
