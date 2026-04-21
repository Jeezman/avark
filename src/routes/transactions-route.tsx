import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useWallet } from "../context/WalletContext";
import type { TransactionRecord, SwapRecord } from "../context/WalletContext";
import { formatSats, formatDate } from "../utils/format";
import { txKindLabel } from "../components/TransactionRow";

type FilterType = "all" | "ark" | "onchain" | "lightning";

interface UnifiedTx {
  id: string;
  rawId: string;
  label: string;
  filterType: FilterType;
  amount_sat: number;
  created_at: number | null;
  status: "confirmed" | "pending" | "failed";
  statusLabel: string | null;
  canRetryClaim: boolean;
}

function txToUnified(tx: TransactionRecord, index: number): UnifiedTx {
  const filterType: FilterType =
    tx.kind === "ark" ? "ark" : "onchain";
  return {
    id: `${tx.txid}-${tx.kind}-${index}`,
    rawId: tx.txid,
    label: txKindLabel(tx.kind),
    filterType,
    amount_sat: tx.amount_sat,
    created_at: tx.created_at,
    status: tx.is_settled === false ? "pending" : "confirmed",
    statusLabel: tx.is_settled === false ? "Pending" : null,
    canRetryClaim: false,
  };
}

function swapToUnified(swap: SwapRecord): UnifiedTx {
  const shortStatus = swap.status
    .replace("transaction.", "")
    .replace("swap.", "")
    .replace("invoice.", "");
  return {
    id: `ln-${swap.id}`,
    rawId: swap.id,
    label: "Lightning",
    filterType: "lightning",
    amount_sat: swap.amount_sat,
    created_at: swap.created_at,
    status: swap.is_successful_terminal
      ? "confirmed"
      : swap.is_terminal
        ? "failed"
        : "pending",
    statusLabel: swap.is_terminal ? null : shortStatus,
    canRetryClaim: !swap.is_terminal && swap.has_preimage,
  };
}

const FILTERS: { value: FilterType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ark", label: "Ark" },
  { value: "onchain", label: "Onchain" },
  { value: "lightning", label: "Lightning" },
];

export function TransactionsRoute() {
  const { transactions, swaps, refreshing, fetchData } = useWallet();
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(20);
  const [retryingSwapId, setRetryingSwapId] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);

  const unified = useMemo(() => {
    const txItems = transactions.map(txToUnified);
    const swapItems = swaps.map(swapToUnified);
    return [...txItems, ...swapItems].sort(
      (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0),
    );
  }, [transactions, swaps]);

  const filtered = useMemo(
    () =>
      unified.filter((tx) => {
        if (filter !== "all" && tx.filterType !== filter) return false;
        if (debouncedSearch) {
          const q = debouncedSearch.toLowerCase();
          const matchesId = tx.id.toLowerCase().includes(q);
          const matchesLabel = tx.label.toLowerCase().includes(q);
          const raw = String(Math.abs(tx.amount_sat));
          const matchesAmount = raw.includes(q) || formatSats(Math.abs(tx.amount_sat)).includes(q);
          if (!matchesId && !matchesLabel && !matchesAmount) return false;
        }
        return true;
      }),
    [unified, filter, debouncedSearch],
  );

  return (
    <main className="theme-text" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-4 pb-2">
        <h1 className="text-lg font-bold">Transactions</h1>
        <button
          onClick={() => void fetchData()}
          disabled={refreshing}
          className="rounded-full theme-card-elevated p-2 theme-text-secondary hover:opacity-80 transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <svg
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
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

      {/* Search */}
      <div className="px-6 pb-3">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setVisibleCount(20); }}
          placeholder="Search by txid or amount..."
          className="w-full rounded-xl theme-input px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-lime-300/50"
        />
      </div>

      {/* Filters */}
      <div className="flex gap-2 px-6 pb-4">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => { setFilter(f.value); setVisibleCount(20); }}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filter === f.value
                ? "theme-accent-bg"
                : "theme-card-elevated theme-text-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Transaction List */}
      <div className="px-6">
        {filtered.length === 0 ? (
          <div className="rounded-2xl theme-card p-8 text-center">
            <p className="theme-text-muted text-sm">
              {debouncedSearch || filter !== "all"
                ? "No matching transactions"
                : "No transactions yet"}
            </p>
          </div>
        ) : (
          <div className="space-y-2 pb-4">
            {filtered.slice(0, visibleCount).map((tx) => {
              const isExpanded = expandedId === tx.id;
              return (
                <div
                  key={tx.id}
                  className="rounded-xl theme-card px-4 py-3 cursor-pointer transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : tx.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{tx.label}</span>
                        {tx.statusLabel && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              tx.status === "failed"
                                ? "theme-danger-bg theme-danger"
                                : "theme-warning-bg theme-warning"
                            }`}
                          >
                            {tx.statusLabel}
                          </span>
                        )}
                      </div>
                      <p className="text-xs theme-text-muted mt-0.5">{formatDate(tx.created_at)}</p>
                    </div>
                    <p
                      className={`text-sm font-semibold tabular-nums ${
                        tx.status === "failed"
                          ? "theme-negative"
                          : tx.amount_sat >= 0
                            ? "theme-positive"
                            : "theme-negative"
                      }`}
                    >
                      {tx.amount_sat >= 0 ? "+" : ""}
                      {formatSats(tx.amount_sat)}{" "}
                      <span className="text-[10px] theme-text-faint">sats</span>
                    </p>
                  </div>
                  {isExpanded && (
                    <div className="mt-2 pt-2 border-t theme-border space-y-2">
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] theme-text-faint font-mono break-all flex-1">{tx.rawId}</p>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await navigator.clipboard.writeText(tx.rawId);
                              toast.success("Copied");
                            } catch {
                              toast.error("Failed to copy");
                            }
                          }}
                          className="shrink-0 rounded-lg theme-card-elevated px-2 py-1 text-[10px] theme-text-muted"
                        >
                          Copy
                        </button>
                      </div>
                      {tx.canRetryClaim && (
                        <button
                          disabled={retryingSwapId === tx.rawId}
                          onClick={async (e) => {
                            e.stopPropagation();
                            setRetryingSwapId(tx.rawId);
                            try {
                              const result = await invoke<string>(
                                "retry_claim_swap",
                                { swapId: tx.rawId },
                              );
                              toast.success(result);
                              void fetchData();
                            } catch (err) {
                              toast.error(
                                typeof err === "string"
                                  ? err
                                  : "Retry claim failed",
                              );
                            } finally {
                              setRetryingSwapId(null);
                            }
                          }}
                          className="w-full rounded-lg bg-lime-300 px-3 py-1.5 text-xs font-bold text-gray-900 active:scale-95 transition-transform disabled:opacity-50"
                        >
                          {retryingSwapId === tx.rawId
                            ? "Retrying claim…"
                            : "Retry claim"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {filtered.length > visibleCount && (
              <button
                onClick={() => setVisibleCount((c) => c + 20)}
                className="block w-full rounded-xl theme-card py-3 text-center text-sm font-medium theme-accent hover:opacity-80 transition-opacity"
              >
                Show more ({filtered.length - visibleCount} remaining)
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
