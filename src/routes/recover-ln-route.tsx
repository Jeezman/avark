import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

interface SubmarineSwapRecord {
  id: string;
  amount_sat: number;
  payment_hash: string;
  created_at: number;
  local_status: string;
  boltz_status: string | null;
  is_terminal: boolean;
  is_successful_terminal: boolean;
  is_refundable: boolean;
  is_expired_timelock: boolean;
}

type Tone = "accent" | "danger" | "warning" | "muted";

interface StatusView {
  label: string;
  tone: Tone;
  action: "refund" | "wait" | "done-success" | "done-refunded" | "done-failed";
}

function classify(swap: SubmarineSwapRecord): StatusView {
  // If our local storage already recorded the refund (we broadcast the refund
  // tx ourselves).
  if (swap.local_status === "transaction.refunded") {
    return { label: "Refunded", tone: "muted", action: "done-refunded" };
  }

  // Otherwise prefer the fresh Boltz status when available; fall back to the
  // local cache for older swaps where Boltz was unreachable.
  const status = swap.boltz_status ?? swap.local_status;

  if (swap.is_successful_terminal) {
    return { label: "Paid", tone: "accent", action: "done-success" };
  }
  if (status === "transaction.refunded") {
    return { label: "Refunded", tone: "muted", action: "done-refunded" };
  }
  if (swap.is_refundable) {
    // Funds locked AND refundable. Messaging differs for timelock vs coop.
    return {
      label: swap.is_expired_timelock ? "Timelock expired" : "Failed — refundable",
      tone: "warning",
      action: "refund",
    };
  }
  if (swap.is_terminal) {
    // Terminal but not successful and not refundable — e.g. `transaction.failed`
    // might have been handled and funds returned. Treat as done.
    return { label: humanizeStatus(status), tone: "danger", action: "done-failed" };
  }
  // In-flight.
  return { label: humanizeStatus(status), tone: "accent", action: "wait" };
}

function humanizeStatus(s: string): string {
  return s.replace(/\./g, " · ").replace(/_/g, " ");
}

function relativeAge(unixSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, nowSec - unixSec);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

export function RecoverLnRoute() {
  const [rows, setRows] = useState<SubmarineSwapRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refundingId, setRefundingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await invoke<SubmarineSwapRecord[]>(
        "list_pending_submarine_swaps",
      );
      setRows(data);
    } catch (e) {
      const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
      setLoadError(msg);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefund(swapId: string) {
    setRefundingId(swapId);
    try {
      const txid = await invoke<string>("refund_submarine_swap", { swapId });
      toast.success(`Refunded (txid: ${txid.slice(0, 10)}…)`);
      // Reload to reflect the new state.
      await load();
    } catch (e) {
      const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
      toast.error(msg);
    } finally {
      setRefundingId(null);
    }
  }

  return (
    <div
      className="theme-text flex flex-col min-h-[calc(100dvh-3.5rem)] px-5 pb-10"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.25rem)" }}
    >
      <header className="flex items-center gap-3 mb-5">
        <Link
          to="/swap"
          aria-label="Back to swap"
          title="Back"
          className="h-9 w-9 shrink-0 rounded-full theme-card-elevated border theme-border flex items-center justify-center theme-text-muted hover:theme-text transition-colors"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[22px] leading-none tracking-wide theme-text">
            Stuck Lightning payments
          </h1>
          <p className="text-[10px] theme-text-muted mt-1 tracking-[0.18em] uppercase">
            Submarine swaps · recovery
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          aria-label="Refresh list"
          title="Refresh"
          className="h-9 w-9 shrink-0 rounded-full theme-card-elevated border theme-border flex items-center justify-center theme-text-muted hover:theme-text transition-colors"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
      </header>

      <p className="mb-4 text-[12px] theme-text-secondary leading-snug">
        Any Lightning payment sent from avark funds a Boltz submarine swap.
        If a payment didn&rsquo;t complete, the sats are still locked in a
        refundable HTLC. This page lists each swap and lets you refund when
        Boltz has marked it failed.
      </p>

      {loadError && (
        <p
          className="mb-3 rounded-xl theme-card-elevated border theme-border px-3 py-2 text-[12px] theme-danger"
          role="alert"
        >
          {loadError}
        </p>
      )}

      {rows === null && !loadError && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-3xl theme-card border theme-border p-4 h-[104px] shimmer-skeleton"
            />
          ))}
        </div>
      )}

      {rows !== null && rows.length === 0 && (
        <div className="rounded-3xl theme-card border theme-border p-6 flex flex-col items-center gap-2 text-center">
          <div
            className="h-14 w-14 rounded-full flex items-center justify-center"
            style={{ background: "var(--color-accent-bg)" }}
            aria-hidden="true"
          >
            <svg
              className="h-6 w-6 theme-accent"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div className="font-display text-[18px] theme-text">All clear</div>
          <p className="text-[12px] theme-text-muted leading-snug max-w-xs">
            No Lightning payments are stuck. Anything you sent recently has
            either settled or was fully refunded.
          </p>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <SwapCard
              key={r.id}
              swap={r}
              view={classify(r)}
              refunding={refundingId === r.id}
              onRefund={() => onRefund(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SwapCard({
  swap,
  view,
  refunding,
  onRefund,
}: {
  swap: SubmarineSwapRecord;
  view: StatusView;
  refunding: boolean;
  onRefund: () => void;
}) {
  return (
    <div className="rounded-3xl theme-card border theme-border p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-display text-[24px] leading-none theme-text tabular-nums">
              {swap.amount_sat.toLocaleString()}
            </span>
            <span className="text-[11px] theme-text-muted font-semibold">sats</span>
          </div>
          <div className="mt-1 text-[10px] theme-text-faint uppercase tracking-[0.14em]">
            {relativeAge(swap.created_at)} · {swap.payment_hash.slice(0, 8)}…
          </div>
        </div>
        <StatusPill tone={view.tone} label={view.label} pulsing={view.action === "wait"} />
      </div>

      {view.action === "refund" && (
        <button
          type="button"
          onClick={onRefund}
          disabled={refunding}
          className="rounded-full theme-button-primary py-3 text-[13px] font-bold disabled:opacity-50"
        >
          {refunding
            ? "Refunding…"
            : swap.is_expired_timelock
              ? "Refund (timelock expired)"
              : "Refund now"}
        </button>
      )}

      {view.action === "wait" && (
        <p className="text-[11px] theme-text-muted leading-snug">
          Boltz is still routing this payment. Check back in a minute.
        </p>
      )}

      {view.action === "done-success" && (
        <p className="text-[11px] theme-text-muted leading-snug">
          Boltz delivered this Lightning payment. Funds left avark as intended.
        </p>
      )}

      {view.action === "done-refunded" && (
        <p className="text-[11px] theme-text-muted leading-snug">
          Refund already broadcast — sats back in your wallet.
        </p>
      )}

      {view.action === "done-failed" && (
        <p className="text-[11px] theme-text-muted leading-snug">
          Swap is in a terminal state with no refund available.
        </p>
      )}
    </div>
  );
}

function StatusPill({
  tone,
  label,
  pulsing,
}: {
  tone: Tone;
  label: string;
  pulsing: boolean;
}) {
  const textClass =
    tone === "danger"
      ? "theme-danger"
      : tone === "warning"
        ? "theme-warning"
        : tone === "muted"
          ? "theme-text-muted"
          : "theme-accent";
  const dotVar =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warning"
        ? "var(--color-warning)"
        : tone === "muted"
          ? "var(--color-text-muted)"
          : "var(--color-accent)";
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border theme-border theme-card-elevated px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${textClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${pulsing ? "live-dot" : ""}`}
        style={{ background: dotVar }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}
