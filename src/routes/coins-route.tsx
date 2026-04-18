import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { formatSats } from "../utils/format";
import { useWallet } from "../context/WalletContext";
import { VtxoCard } from "../components/VtxoCard";
import type { VtxoInfo } from "../components/VtxoCard";

interface FeeEstimate {
  fee_sat: number;
}

interface RenewResult {
  renewed: boolean;
  txid: string | null;
}

type SortKey = "expiry" | "amount";
type FilterStatus = "all" | "confirmed" | "preconfirmed" | "recoverable";

const FILTERS: { value: FilterStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "confirmed", label: "Spendable" },
  { value: "preconfirmed", label: "Pre-confirmed" },
  { value: "recoverable", label: "Recoverable" },
];

function isExpiring(expiresAt: number): boolean {
  const now = Date.now() / 1000;
  return (expiresAt - now) / 3600 < 72;
}

export function CoinsRoute() {
  const {
    fetchData,
    vtxos,
    vtxosLoaded,
    refreshingVtxos,
    fetchVtxos,
  } = useWallet();
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [sortKey, setSortKey] = useState<SortKey>("expiry");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [quickRenew, setQuickRenew] = useState(false);
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [showRenewConfirm, setShowRenewConfirm] = useState(false);
  const [pendingRenewTargets, setPendingRenewTargets] = useState<VtxoInfo[] | null>(null);

  const loading = !vtxosLoaded;

  // On mount, refresh in the background. fetchVtxos() (no-arg) skips the
  // network call when the cache is still fresh, so re-navigating between
  // tabs is cheap; first-ever mount triggers the full load.
  useEffect(() => {
    void fetchVtxos();
  }, [fetchVtxos]);

  const nowSecs = useMemo(() => Date.now() / 1000, [vtxos]);

  const filtered = useMemo(() => {
    let result = vtxos;
    if (filter !== "all") {
      result = result.filter((v) => v.status === filter);
    }
    return [...result].sort((a, b) => {
      if (sortKey === "expiry") return a.expires_at - b.expires_at;
      return b.amount_sat - a.amount_sat;
    });
  }, [vtxos, filter, sortKey]);

  const expiringVtxos = useMemo(
    () => vtxos.filter((v) => v.status !== "recoverable" && isExpiring(v.expires_at)),
    [vtxos],
  );

  const recoverableVtxos = useMemo(
    () => vtxos.filter((v) => v.status === "recoverable"),
    [vtxos],
  );

  const startRenew = useCallback(async (targets: VtxoInfo[]) => {
    if (renewing) return;
    if (targets.length === 0) {
      toast.info("Nothing to renew");
      return;
    }

    if (quickRenew) {
      // Skip confirmation
      setRenewing(true);
      const outpoints = targets.map((v) => `${v.txid}:${v.vout}`);
      try {
        const result = await invoke<RenewResult>("renew_vtxos", { outpoints });
        if (result.renewed) {
          toast.success(`${outpoints.length} VTXO${outpoints.length > 1 ? "s" : ""} renewed${result.txid ? ` (txid: ${result.txid})` : ""}`);
          void fetchVtxos(true);
          void fetchData();
        } else {
          toast.info("Nothing to renew");
        }
      } catch (e) {
        toast.error(typeof e === "string" ? e : "Failed to renew VTXOs");
      } finally {
        setRenewing(false);
      }
      return;
    }

    setRenewing(true);
    setPendingRenewTargets(targets);
    const outpoints = targets.map((v) => `${v.txid}:${v.vout}`);
    try {
      const fee = await invoke<FeeEstimate>("estimate_renew_fees", { outpoints });
      setFeeEstimate(fee);
      setShowRenewConfirm(true);
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to estimate fees");
      setPendingRenewTargets(null);
    } finally {
      setRenewing(false);
    }
  }, [renewing, quickRenew, fetchVtxos, fetchData]);

  const confirmRenew = useCallback(async () => {
    const targets = pendingRenewTargets ?? [];
    const outpoints = targets.map((v) => `${v.txid}:${v.vout}`);
    setRenewing(true);
    setShowRenewConfirm(false);
    setPendingRenewTargets(null);
    try {
      const result = await invoke<RenewResult>("renew_vtxos", { outpoints });
      if (result.renewed) {
        toast.success(`${outpoints.length} VTXO${outpoints.length > 1 ? "s" : ""} renewed${result.txid ? ` (txid: ${result.txid})` : ""}`);
        void fetchVtxos(true);
        void fetchData();
      } else {
        toast.info("Nothing to renew");
      }
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to renew VTXOs");
    } finally {
      setRenewing(false);
    }
  }, [pendingRenewTargets, fetchVtxos, fetchData]);

  if (loading) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-8 theme-text">
        <svg className="mb-4 h-8 w-8 animate-spin text-lime-300" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-sm theme-text-muted">Loading VTXOs...</p>
      </main>
    );
  }

  return (
    <main className="theme-text overflow-x-hidden" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      <div className="flex items-center justify-between px-6 pt-4 pb-2">
        <h1 className="text-lg font-bold">Coins</h1>
        <button
          onClick={() => void fetchVtxos(true)}
          disabled={refreshingVtxos}
          className="rounded-full theme-card-elevated p-2 theme-text-secondary hover:opacity-80 transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <svg
            className={`h-4 w-4 ${refreshingVtxos ? "animate-spin" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* Action buttons */}
      {!showRenewConfirm && (expiringVtxos.length > 0 || recoverableVtxos.length > 0) && (
        <div className="px-6 pb-3 space-y-2">
          {recoverableVtxos.length > 0 && (
            <button
              onClick={() => void startRenew(recoverableVtxos)}
              disabled={renewing}
              className="w-full rounded-xl theme-danger-bg py-2.5 text-sm font-medium theme-danger hover:opacity-80 transition-opacity disabled:opacity-50"
            >
              {renewing ? "Recovering..." : `Recover ${recoverableVtxos.length} VTXO${recoverableVtxos.length > 1 ? "s" : ""} (${formatSats(recoverableVtxos.reduce((sum, v) => sum + v.amount_sat, 0))} sats)`}
            </button>
          )}
          {expiringVtxos.length > 0 && (
            <button
              onClick={() => void startRenew(expiringVtxos)}
              disabled={renewing}
              className="w-full rounded-xl theme-warning-bg py-2.5 text-sm font-medium theme-warning hover:opacity-80 transition-opacity disabled:opacity-50"
            >
              {renewing ? "Renewing..." : `Renew ${expiringVtxos.length} expiring VTXO${expiringVtxos.length > 1 ? "s" : ""}`}
            </button>
          )}
        </div>
      )}

      {/* Renew Confirmation */}
      {showRenewConfirm && (
        <div className="mx-6 mb-3 rounded-2xl theme-warning-bg border theme-warning-border p-4">
          <p className="text-sm font-medium theme-warning mb-2">Renew VTXOs?</p>
          <p className="text-xs theme-text-secondary mb-1">
            This settles all eligible VTXOs into the next ASP round.
          </p>
          {feeEstimate && (
            <p className="text-xs theme-text-muted mb-3">
              Estimated fee: {formatSats(Math.abs(feeEstimate.fee_sat))} sats
            </p>
          )}
          <button
            onClick={() => setQuickRenew(!quickRenew)}
            className="flex items-center gap-2 mb-3 py-1 -mx-1 px-1 rounded-lg"
          >
            <span className={`h-4 w-4 rounded border-2 shrink-0 transition-colors ${
              quickRenew ? "border-current bg-current theme-accent" : "theme-border"
            }`} />
            <span className="text-[10px] theme-text-muted text-left">Quick renew (skip confirmation next time)</span>
          </button>
          <div className="flex gap-3">
            <button
              onClick={() => { setShowRenewConfirm(false); setPendingRenewTargets(null); }}
              className="flex-1 rounded-xl theme-card-elevated py-2.5 text-sm font-medium theme-text-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void confirmRenew()}
              disabled={renewing}
              className="flex-1 rounded-xl bg-yellow-500 py-2.5 text-sm font-bold text-gray-900 transition-colors hover:bg-yellow-400 disabled:opacity-50"
            >
              {renewing ? "Renewing..." : "Renew"}
            </button>
          </div>
        </div>
      )}

      {/* Filters + Sort */}
      <div className="flex items-center gap-2 px-6 pb-4 overflow-x-auto scrollbar-none">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              filter === f.value
                ? "theme-accent-bg"
                : "theme-card-elevated theme-text-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="shrink-0 w-px h-4 theme-border border-l mx-1" />
        {(["expiry", "amount"] as SortKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setSortKey(key)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              sortKey === key ? "theme-accent-bg" : "theme-card-elevated theme-text-muted"
            }`}
          >
            {key === "expiry" ? "Expiry" : "Amount"}
          </button>
        ))}
      </div>

      {/* VTXO List */}
      <div className="px-6">
        <h2 className="text-sm font-semibold theme-text-muted mb-3">
          VTXOs ({filtered.length})
        </h2>
        {filtered.length === 0 ? (
          <div className="rounded-2xl theme-card p-8 text-center">
            <p className="theme-text-muted text-sm">
              {filter !== "all" ? "No matching VTXOs" : "No VTXOs"}
            </p>
          </div>
        ) : (
          <div className="space-y-2 pb-4">
            {filtered.map((vtxo) => {
              const key = `${vtxo.txid}:${vtxo.vout}`;
              return (
                <VtxoCard
                  key={key}
                  vtxo={vtxo}
                  now={nowSecs}
                  expanded={expandedId === key}
                  canAct={!showRenewConfirm && !renewing}
                  onToggle={() => setExpandedId(expandedId === key ? null : key)}
                  onAction={() => void startRenew([vtxo])}
                />
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
