import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { TokenMark } from "../components/swap/SwapIcons";
import { formatLendaSwapError } from "../utils/lendaswapErrors";
import { reconcilePendingSwaps } from "../lib/lendaswap/reconcile";

interface SwapRecord {
  id: string;
  lendaswap_id: string;
  direction: string;
  source_amount_sats: number;
  target_token: string;
  target_amount: string;
  destination_address: string;
  ln_invoice: string;
  network_fee: number;
  protocol_fee: number;
  service_fee: number;
  status: string;
  claim_tx_hash: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const PAGE_SIZE = 20;

export function SwapHistoryRoute() {
  // `rows` and `reachedEnd` are merged into one state object so the initial
  // fetch can commit both in a single render — the alternative (two back-to-back
  // setState calls inside the effect's .then()) trips `react-hooks/set-state-in-effect`.
  const [list, setList] = useState<{
    rows: SwapRecord[] | null;
    reachedEnd: boolean;
  }>({ rows: null, reachedEnd: false });
  const rows = list.rows;
  const reachedEnd = list.reachedEnd;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(
    async (offset: number): Promise<SwapRecord[] | null> => {
      try {
        const page = await invoke<SwapRecord[]>("list_lendaswap_swaps", {
          limit: PAGE_SIZE,
          offset,
          status: null,
        });
        return page;
      } catch (e) {
        const msg = formatLendaSwapError(e);
        setLoadError(msg);
        toast.error(msg);
        return null;
      }
    },
    []
  );

  // Wrapping the initial-fetch setState in a useCallback keeps it out of the
  // effect's synchronous scope, which is where the `react-hooks/set-state-in-effect`
  // rule lives. Matches the `fetchRate` pattern in swap-route.tsx.
  const loadFirstPage = useCallback(async () => {
    const page = await loadPage(0);
    if (page === null) return;
    setList({ rows: page, reachedEnd: page.length < PAGE_SIZE });
  }, [loadPage]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  // Catch up any swap statuses that flipped while the app was closed. Memoized
  // per session — safe to fire here as well as on /swap without double work.
  useEffect(() => {
    void reconcilePendingSwaps();
  }, []);

  const loadMore = useCallback(async () => {
    if (!rows || reachedEnd || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadPage(rows.length);
      if (page === null) return;
      setList({
        rows: [...rows, ...page],
        reachedEnd: page.length < PAGE_SIZE,
      });
    } finally {
      setLoadingMore(false);
    }
  }, [rows, reachedEnd, loadingMore, loadPage]);

  return (
    <div
      className="theme-text flex flex-col min-h-[calc(100dvh-3.5rem)] px-5 pb-10"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.25rem)" }}
    >
      <header className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-[26px] leading-none tracking-wide theme-text">
            History
          </h1>
          <p className="text-[11px] theme-text-muted mt-1 tracking-wider uppercase">
            Every swap, newest first
          </p>
        </div>
        <Link
          to="/swap"
          className="text-[11px] theme-text-muted underline underline-offset-2"
        >
          New swap
        </Link>
      </header>

      {loadError && !rows && (
        <p className="theme-danger text-sm" role="alert">
          {loadError}
        </p>
      )}

      {rows === null && !loadError && <SkeletonRows />}

      {rows !== null && rows.length === 0 && <EmptyState />}

      {rows !== null && rows.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((swap) => (
              <HistoryRow key={swap.id} swap={swap} />
            ))}
          </ul>
          {!reachedEnd && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-4 self-center rounded-full theme-card-elevated border theme-border px-4 py-2 text-[12px] font-semibold theme-text disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
          {reachedEnd && (
            <p className="mt-4 text-center text-[11px] theme-text-faint uppercase tracking-wider">
              End of history
            </p>
          )}
        </>
      )}
    </div>
  );
}

function HistoryRow({ swap }: { swap: SwapRecord }) {
  const navigate = useNavigate();
  const token = swap.target_token as "usdc_eth" | "usdt_eth";

  function open() {
    // Every status lands on the same checkout route — that route dispatches
    // per-status (pay → claim → terminal). One deep-link target covers the
    // three PRD sub-cases (awaiting_payment → checkout, processing → claim,
    // terminal → read-only detail).
    navigate({ to: "/swap/checkout/$id", params: { id: swap.id } });
  }

  return (
    <li>
      <button
        type="button"
        onClick={open}
        className="w-full rounded-2xl theme-card border theme-border p-3 flex items-center gap-3 text-left active:scale-[0.99] transition-transform hover:theme-card-elevated"
      >
        <TokenMark id={token} className="h-9 w-9" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-display text-[15px] theme-text tabular-nums">
              {swap.target_amount}{" "}
              <span className="text-[11px] theme-text-muted">
                {tokenLabel(swap.target_token)}
              </span>
            </span>
            <StatusPill status={swap.status} />
          </div>
          <div className="flex items-center justify-between gap-2 mt-1">
            <span className="text-[11px] theme-text-muted tabular-nums">
              {swap.source_amount_sats.toLocaleString()} sats
            </span>
            <span className="text-[11px] theme-text-faint tabular-nums">
              {relativeTime(swap.created_at)}
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "bg-green-500/10 text-green-600"
      : status === "failed" || status === "expired"
        ? "bg-red-500/10 text-red-600"
        : status === "refunded"
          ? "bg-amber-500/10 text-amber-600"
          : status === "processing"
            ? "bg-blue-500/10 text-blue-600"
            : "theme-card-elevated theme-text-muted";
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0 ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 theme-text-muted">
      <div
        className="h-16 w-16 rounded-full flex items-center justify-center"
        style={{
          background:
            "linear-gradient(135deg, var(--color-bitcoin-bg), var(--color-accent-bg))",
        }}
        aria-hidden="true"
      >
        <svg
          className="h-7 w-7 theme-text"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <p className="text-sm theme-text">No swaps yet</p>
      <p className="text-[12px] max-w-[28ch]">
        When you swap sats for stablecoins, each one will show up here.
      </p>
      <Link
        to="/swap"
        className="mt-1 rounded-full theme-button-primary px-5 py-2 text-[13px] font-bold"
      >
        Start a swap
      </Link>
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="rounded-2xl theme-card border theme-border p-3 flex items-center gap-3"
        >
          <div className="h-9 w-9 rounded-full shimmer-skeleton" />
          <div className="flex-1 flex flex-col gap-2">
            <div className="h-3 w-1/2 rounded-full shimmer-skeleton" />
            <div className="h-2.5 w-1/3 rounded-full shimmer-skeleton" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function tokenLabel(id: string): string {
  return id.replace("_eth", "").toUpperCase();
}

/**
 * Tight relative-time formatter. We don't pull in a date library for one
 * use; the phrasing matches what a user scanning a ledger expects.
 */
function relativeTime(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86_400) return `${Math.floor(diff / 86_400)}d ago`;
  // Longer than a week — show an absolute date.
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
