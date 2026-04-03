import { memo } from "react";
import { toast } from "sonner";
import { formatSats } from "../utils/format";

interface VtxoInfo {
  txid: string;
  vout: number;
  amount_sat: number;
  created_at: number;
  expires_at: number;
  status: "confirmed" | "preconfirmed" | "recoverable";
}

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Spendable",
  preconfirmed: "Pre-confirmed",
  recoverable: "Recoverable",
};

function expiryColor(expiresAt: number, now: number): string {
  const hoursLeft = (expiresAt - now) / 3600;
  if (hoursLeft < 24) return "theme-danger";
  if (hoursLeft < 72) return "theme-warning";
  return "theme-positive";
}

function expiryLabel(expiresAt: number, now: number): string {
  const secsLeft = expiresAt - now;
  if (secsLeft <= 0) return "Expired";
  const days = Math.floor(secsLeft / 86400);
  const hours = Math.floor((secsLeft % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((secsLeft % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function truncateTxid(txid: string): string {
  if (txid.length <= 20) return txid;
  return `${txid.slice(0, 10)}...${txid.slice(-8)}`;
}

interface VtxoCardProps {
  vtxo: VtxoInfo;
  now: number;
  expanded: boolean;
  canAct: boolean;
  onToggle: () => void;
  onAction: () => void;
}

export const VtxoCard = memo(function VtxoCard({
  vtxo,
  now,
  expanded,
  canAct,
  onToggle,
  onAction,
}: VtxoCardProps) {
  const expired = vtxo.expires_at < now;
  const expiring = (vtxo.expires_at - now) / 3600 < 72;
  const isRecoverable = vtxo.status === "recoverable";
  const showAction = canAct && (isRecoverable || expiring);

  return (
    <div
      className={`rounded-xl theme-card px-4 py-3 cursor-pointer transition-colors ${expired ? "opacity-50" : ""}`}
      onClick={onToggle}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tabular-nums">
              {formatSats(vtxo.amount_sat)}{" "}
              <span className="text-[10px] theme-text-faint">sats</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                vtxo.status === "confirmed"
                  ? "theme-accent-bg"
                  : vtxo.status === "preconfirmed"
                    ? "theme-warning-bg theme-warning"
                    : "theme-danger-bg theme-danger"
              }`}
            >
              {STATUS_LABELS[vtxo.status]}
            </span>
          </div>
          <p className="text-[10px] theme-text-muted font-mono mt-0.5">
            {truncateTxid(vtxo.txid)}:{vtxo.vout}
          </p>
        </div>
        <div className="text-right shrink-0 ml-3">
          <p className={`text-xs font-medium ${expiryColor(vtxo.expires_at, now)}`}>
            {expired ? "Expired" : expiryLabel(vtxo.expires_at, now)}
          </p>
          {showAction && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAction();
              }}
              className={`text-[10px] hover:opacity-80 font-medium mt-0.5 ${isRecoverable ? "theme-danger" : "theme-warning"}`}
            >
              {isRecoverable ? "Recover" : "Renew"}
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t theme-border overflow-hidden">
          <div className="space-y-2 text-[10px]">
            <div>
              <span className="theme-text-muted block mb-0.5">Txid</span>
              <div className="flex items-center gap-2">
                <p className="theme-text-faint font-mono break-all flex-1 min-w-0">
                  {vtxo.txid}
                </p>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await navigator.clipboard.writeText(vtxo.txid);
                      toast.success("Copied txid");
                    } catch {
                      toast.error("Failed to copy");
                    }
                  }}
                  className="shrink-0 rounded-lg theme-card-elevated px-2 py-1 theme-text-muted"
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">Created</span>
              <span className="theme-text-secondary">
                {new Date(vtxo.created_at * 1000).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="theme-text-muted">Expires</span>
              <span className="theme-text-secondary">
                {new Date(vtxo.expires_at * 1000).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export type { VtxoInfo };
