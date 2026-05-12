import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import QRCode from "react-qr-code";
import { formatLendaSwapError } from "../utils/lendaswapErrors";
import {
  claim as sdkClaim,
  isTerminalSwapStatus,
  refreshSwap as sdkRefreshSwap,
} from "../lib/lendaswap/client";
import { reconcilePendingSwaps } from "../lib/lendaswap/reconcile";
import { TokenMark } from "../components/swap/SwapIcons";

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

interface WalletBalance {
  offchain_total_sat: number;
  offchain_confirmed_sat: number;
  offchain_pre_confirmed_sat: number;
  onchain_confirmed_sat: number;
  boarding_sat: number;
}

const POLL_INTERVAL_MS = 5000;
const FAST_POLL_INTERVAL_MS = 2000;
const FAST_POLL_WINDOW_MS = 60_000;
const ETHERSCAN_TX_BASE = "https://etherscan.io/tx/";
// Mirrors `DISMISS_MIN_AGE_SECS` on the Rust side. The UI uses it to decide
// whether to even render the dismiss footer; Rust enforces the real gate.
const DISMISS_MIN_AGE_SECS = 10 * 60;

function formatSendError(e: unknown): string {
  if (typeof e === "string") return e;
  return formatLendaSwapError(e);
}

/**
 * Recognizes the Boltz-side "a swap with this invoice exists already" error.
 * Boltz dedupes submarine swaps by BOLT11 payment_hash, so retapping pay
 * after a prior attempt always hits this. It means the first attempt is
 * still pending or has already been recorded by Boltz — not that payment
 * has completed. Treat it as "in flight, wait for polling to resolve."
 */
function isBoltzDuplicateError(msg: string): boolean {
  return /swap with this invoice exists already/i.test(msg);
}

function tokenLabel(id: string): string {
  return id.replace("_eth", "").toUpperCase();
}

function truncateAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// The TokenMark component only accepts the two stablecoins we ship. A new
// status-driven screen should never hit a different id, but we guard anyway.
function isSupportedTokenId(id: string): id is "usdc_eth" | "usdt_eth" {
  return id === "usdc_eth" || id === "usdt_eth";
}

export function SwapCheckoutRoute() {
  // Code-based route — typed params aren't registered, so we read untyped.
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();

  const [swap, setSwap] = useState<SwapRecord | null>(null);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  // Tracks the "Boltz already has a submarine swap for this invoice" state.
  // Triggered by the first payment attempt — the second tap hits a duplicate
  // error and we must NOT let the user re-submit a fresh invoice (which
  // would risk double-spending if the first attempt eventually succeeds).
  // Cleared naturally when polling flips the LendaSwap status past
  // `awaiting_payment` (see effect below).
  const [boltzInFlight, setBoltzInFlight] = useState(false);

  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSubmitted, setClaimSubmitted] = useState(false);

  const [dismissing, setDismissing] = useState(false);

  // Polling cadence is dynamic — after a claim is submitted we burst-poll at
  // 2s to catch the processing→completed transition, then fall back to 5s.
  const [pollIntervalMs, setPollIntervalMs] = useState(POLL_INTERVAL_MS);
  const fastPollResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // User-controlled QR disclosure in the *sufficient-balance* branch, where
  // paying from avark is the primary action and the external QR is secondary.
  // When balance is insufficient the QR is always rendered, and this toggle
  // is ignored — see the render split below.
  const [showQr, setShowQr] = useState(false);

  // Initial load reads the locally-cached row from Rust — fast, no network.
  // Subsequent refreshes (see `refreshSwap` below) go through the TS SDK.
  const loadLocal = useCallback(async () => {
    try {
      const s = await invoke<SwapRecord>("get_lendaswap_swap", { id });
      setSwap(s);
      return s;
    } catch (e) {
      setLoadError(formatLendaSwapError(e));
      return null;
    }
  }, [id]);

  // Refresh via the SDK, which hits LendaSwap + updates the Rust DB row and
  // returns the latest state. Only useful after the initial row is loaded
  // (we need its `lendaswap_id`). Silent failures during polling avoid
  // flooding the user with toasts for transient network blips.
  const refreshSwap = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!swap) return null;
      try {
        const fresh = await sdkRefreshSwap(swap.id, swap.lendaswap_id);
        setSwap(fresh);
        return fresh;
      } catch (e) {
        if (!opts.silent) setLoadError(formatLendaSwapError(e));
        return null;
      }
    },
    [swap]
  );

  const refreshBalance = useCallback(async () => {
    try {
      const b = await invoke<WalletBalance>("get_balance");
      setBalance(b);
    } catch {
      // Balance is nice-to-have here; a failure just leaves the pay-from-avark
      // button disabled until we can fetch it. Don't derail the screen.
    }
  }, []);

  useEffect(() => {
    void loadLocal();
    void refreshBalance();
  }, [loadLocal, refreshBalance]);

  // Catch up any swap statuses that flipped while the app was closed. Memoized
  // per session — a cold-start into this route via a deep-link still benefits.
  useEffect(() => {
    void reconcilePendingSwaps();
  }, []);

  useEffect(() => {
    return () => {
      if (fastPollResetRef.current) {
        clearTimeout(fastPollResetRef.current);
        fastPollResetRef.current = null;
      }
    };
  }, []);

  // Poll while the swap is non-terminal. setInterval callback runs async, so
  // the setState inside stays clear of `set-state-in-effect`. Interval length
  // is driven by `pollIntervalMs` so a post-claim "fast burst" can narrow it
  // without restarting this effect on every status tick.
  const status = swap?.status ?? null;
  useEffect(() => {
    if (!status || isTerminalSwapStatus(status)) return;
    const handle = setInterval(() => {
      void refreshSwap({ silent: true });
    }, pollIntervalMs);
    return () => clearInterval(handle);
  }, [status, refreshSwap, pollIntervalMs]);

  // Clear the "Boltz in flight" lock as soon as the swap leaves awaiting_payment
  // — polling caught the status change, so the first pay attempt is no longer
  // a hazard to double-pay.
  useEffect(() => {
    if (status && status !== "awaiting_payment" && boltzInFlight) {
      setBoltzInFlight(false);
    }
  }, [status, boltzInFlight]);

  // Auto-advance to claim once the server has funded the HTLC. We keep the
  // claim UI on this same route (status-driven rendering) so "navigate" is a
  // no-op visually — US-007 will render the claim section in place. A ref
  // guards against re-firing on every re-render.
  const advancedRef = useRef(false);
  useEffect(() => {
    if (status === "processing" && !advancedRef.current) {
      advancedRef.current = true;
      toast.success("Swap processing — ready to claim");
    }
    if (status && status !== "processing") {
      advancedRef.current = false;
    }
  }, [status]);

  const sufficientBalance =
    swap !== null &&
    balance !== null &&
    balance.offchain_total_sat >= swap.source_amount_sats;

  // Time-based gate for the "Dismiss swap" footer. Only `awaiting_payment`
  // swaps are dismissable (the Rust command enforces the real check, but we
  // hide the button for fresh swaps to avoid tempting a premature dismiss).
  // Recomputed every re-render; polling + status ticks refresh this often
  // enough for the 10-min threshold to feel live.
  const swapAgeSecs =
    swap !== null ? Math.max(0, Math.floor(Date.now() / 1000) - swap.created_at) : 0;
  const canDismiss =
    swap !== null &&
    swap.status === "awaiting_payment" &&
    swapAgeSecs >= DISMISS_MIN_AGE_SECS;

  async function payFromAvark() {
    if (!swap) return;
    setPaying(true);
    setPayError(null);

    try {
      // Rust caps the settlement wait at 30s. On success we get either a
      // fully-paid result (no `pendingLnSwapId`) or a pending marker — both
      // are `Ok`. Only real errors (bad invoice, Boltz duplicate, actual
      // routing failure) throw.
      const result = await invoke<{
        txid: string;
        pendingLnSwapId?: string | null;
      }>("send_lightning", { invoice: swap.ln_invoice });

      if (result.pendingLnSwapId) {
        // VHTLC funded, LN still routing. Hand off to the polling-driven
        // in-flight panel rather than claiming success prematurely.
        setBoltzInFlight(true);
      } else {
        toast.success("Invoice paid");
      }
      // Refresh immediately; polling covers subsequent transitions.
      await refreshSwap({ silent: true });
      await refreshBalance();
    } catch (e) {
      const msg = formatSendError(e);
      if (isBoltzDuplicateError(msg)) {
        // Previous attempt is still in flight on Boltz — don't surface the raw
        // error and don't let the user re-submit. Polling will flip status.
        setBoltzInFlight(true);
        setPayError(null);
      } else {
        setPayError(msg);
        toast.error(msg);
      }
    } finally {
      setPaying(false);
    }
  }

  async function claim() {
    if (!swap) return;
    setClaiming(true);
    setClaimError(null);
    try {
      await sdkClaim(swap.id, swap.lendaswap_id);
      setClaimSubmitted(true);
      toast.success("Claim submitted — waiting for on-chain confirmation");
      await refreshSwap({ silent: true });
      setPollIntervalMs(FAST_POLL_INTERVAL_MS);
      if (fastPollResetRef.current) clearTimeout(fastPollResetRef.current);
      fastPollResetRef.current = setTimeout(() => {
        fastPollResetRef.current = null;
        setPollIntervalMs(POLL_INTERVAL_MS);
      }, FAST_POLL_WINDOW_MS);
    } catch (e) {
      const msg = formatLendaSwapError(e);
      setClaimError(msg);
      toast.error(msg);
    } finally {
      setClaiming(false);
    }
  }

  function copyInvoice() {
    if (!swap) return;
    navigator.clipboard
      .writeText(swap.ln_invoice)
      .then(() => toast.success("Invoice copied"))
      .catch(() => toast.error("Copy failed"));
  }

  function copyAddress() {
    if (!swap) return;
    navigator.clipboard
      .writeText(swap.destination_address)
      .then(() => toast.success("Address copied"))
      .catch(() => toast.error("Copy failed"));
  }

  async function dismissSwap() {
    if (!swap) return;
    setDismissing(true);
    try {
      const fresh = await invoke<SwapRecord>("dismiss_lendaswap_swap", { id: swap.id });
      setSwap(fresh);
      toast.success("Swap dismissed");
    } catch (e) {
      toast.error(formatLendaSwapError(e));
    } finally {
      setDismissing(false);
    }
  }

  function startNewSwap() {
    navigate({ to: "/swap" });
  }

  return (
    <div
      className="theme-text flex flex-col min-h-[calc(100dvh-3.5rem)] px-5 pb-10"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.25rem)" }}
    >
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-3 min-w-0">
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
          <div className="min-w-0">
            <h1 className="font-display text-[24px] leading-none tracking-wide theme-text">
              Checkout
            </h1>
            <p className="text-[10px] theme-text-muted mt-1 tracking-[0.18em] uppercase">
              Claim ticket
            </p>
          </div>
        </div>
        {swap && <StatusPulse status={swap.status} />}
      </header>

      {loadError && (
        <p
          className="mb-3 rounded-xl theme-card-elevated border theme-border px-3 py-2 text-[12px] theme-danger"
          role="alert"
        >
          {loadError}
        </p>
      )}

      {swap && (
        <>
          <InvoiceHero swap={swap} onCopyAddress={copyAddress} />

          {/* Status-driven body */}
          {isTerminalSwapStatus(swap.status) ? (
            <TerminalSection swap={swap} onStartNew={startNewSwap} />
          ) : swap.status === "processing" ? (
            <ProcessingSection
              swap={swap}
              claiming={claiming}
              claimError={claimError}
              claimSubmitted={claimSubmitted}
              onClaim={claim}
            />
          ) : boltzInFlight ? (
            <>
              <BoltzInFlightSection
                onRefresh={() => {
                  void refreshSwap();
                  void refreshBalance();
                }}
              />
              <PayExternallyCompact
                swap={swap}
                showQr={showQr}
                toggleQr={() => setShowQr((v) => !v)}
                onCopy={copyInvoice}
              />
            </>
          ) : sufficientBalance ? (
            <>
              <PayFromAvarkPrimary
                swap={swap}
                balance={balance}
                paying={paying}
                error={payError}
                onPay={payFromAvark}
              />
              <PayExternallyCompact
                swap={swap}
                showQr={showQr}
                toggleQr={() => setShowQr((v) => !v)}
                onCopy={copyInvoice}
              />
            </>
          ) : (
            <>
              <PayExternallyPrimary swap={swap} onCopy={copyInvoice} />
              <PayFromAvarkMuted swap={swap} balance={balance} />
            </>
          )}

          {canDismiss && (
            <DismissFooter dismissing={dismissing} onDismiss={dismissSwap} />
          )}
        </>
      )}
    </div>
  );
}

// ── Invoice hero ─────────────────────────────────────────────────────────────

function InvoiceHero({
  swap,
  onCopyAddress,
}: {
  swap: SwapRecord;
  onCopyAddress: () => void;
}) {
  return (
    <div className="invoice-surface relative rounded-[28px] border theme-border overflow-hidden">
      {/* Top accent stripe — orange→lime echoes the swap direction identity. */}
      <div
        className="absolute inset-x-0 top-0 h-[2px] pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, var(--color-bitcoin), var(--color-accent))",
          opacity: 0.75,
        }}
        aria-hidden="true"
      />

      {/* RECEIVE — hero */}
      <div className="relative px-5 pt-6 pb-5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.22em] theme-text-muted mb-3">
          You&rsquo;ll receive
        </div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="font-display text-[40px] leading-none theme-text tabular-nums">
            {swap.target_amount}
          </span>
          <span className="inline-flex items-center gap-1.5 theme-accent-bg rounded-full pl-1 pr-3 py-0.5 text-[12px] font-semibold">
            {isSupportedTokenId(swap.target_token) && (
              <TokenMark id={swap.target_token} className="h-5 w-5" />
            )}
            {tokenLabel(swap.target_token)}
          </span>
        </div>
        <div className="mt-2 text-[10px] theme-text-muted uppercase tracking-[0.18em]">
          on Ethereum
        </div>
      </div>

      <div className="perforation mx-5" aria-hidden="true" />

      {/* PAY */}
      <div className="relative px-5 py-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.22em] theme-text-muted mb-2">
          You pay
        </div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-display text-[28px] leading-none theme-btc tabular-nums">
            {swap.source_amount_sats.toLocaleString()}
          </span>
          <span className="text-[13px] font-semibold theme-text-muted">sats</span>
        </div>
        <div className="mt-1.5 text-[10px] theme-text-muted uppercase tracking-[0.18em]">
          BTC · Lightning
        </div>
      </div>

      <div className="perforation mx-5" aria-hidden="true" />

      {/* DESTINATION */}
      <div className="relative px-5 py-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] theme-text-muted mb-1">
            To
          </div>
          <div className="font-mono text-[13px] theme-text tabular-nums tracking-tight truncate">
            {truncateAddress(swap.destination_address)}
          </div>
        </div>
        <button
          type="button"
          onClick={onCopyAddress}
          aria-label="Copy destination address"
          title="Copy address"
          className="h-9 w-9 shrink-0 rounded-full theme-card-elevated border theme-border flex items-center justify-center theme-text-muted hover:theme-text transition-colors"
        >
          <CopyIcon />
        </button>
      </div>
    </div>
  );
}

// ── Status pulse pill ────────────────────────────────────────────────────────

function StatusPulse({ status }: { status: string }) {
  const label = status.replace(/_/g, " ");
  // Map each status to a tone + whether it should pulse. Completed/refunded
  // are terminal-positive, failed/expired are terminal-negative, awaiting/
  // processing are in-flight (pulse).
  const tone =
    status === "completed"
      ? "accent"
      : status === "failed" || status === "expired"
        ? "danger"
        : status === "refunded"
          ? "warning"
          : "accent";
  const pulsing = !isTerminalSwapStatus(status);

  const dotColor =
    tone === "accent"
      ? "var(--color-accent)"
      : tone === "danger"
        ? "var(--color-danger)"
        : "var(--color-warning)";

  const textClass =
    tone === "danger"
      ? "theme-danger"
      : tone === "warning"
        ? "theme-warning"
        : "theme-accent";

  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border theme-border theme-card-elevated pl-2 pr-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${textClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${pulsing ? "live-dot" : ""}`}
        style={{ background: dotColor }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

// ── Action: pay-from-avark (primary, when balance suffices) ─────────────────

function PayFromAvarkPrimary({
  swap,
  balance,
  paying,
  error,
  onPay,
}: {
  swap: SwapRecord;
  balance: WalletBalance | null;
  paying: boolean;
  error: string | null;
  onPay: () => void;
}) {
  return (
    <div className="mt-4 rounded-3xl theme-card border theme-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          Pay from avark
        </span>
        {balance && (
          <span className="text-[11px] theme-text-muted tabular-nums">
            {balance.offchain_total_sat.toLocaleString()} sats available
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onPay}
        disabled={paying}
        className="rounded-full theme-button-primary py-3.5 text-[15px] font-bold disabled:opacity-50"
      >
        {paying ? "Paying…" : `Pay ${swap.source_amount_sats.toLocaleString()} sats`}
      </button>
      {error && (
        <p className="text-[11px] theme-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Action: pay-externally (primary, when balance is short) ─────────────────

function PayExternallyPrimary({
  swap,
  onCopy,
}: {
  swap: SwapRecord;
  onCopy: () => void;
}) {
  return (
    <div className="mt-4 rounded-3xl theme-card border theme-border p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          Scan to pay
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] theme-accent uppercase tracking-[0.14em]">
          <span
            className="live-dot h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-accent)" }}
            aria-hidden="true"
          />
          Awaiting
        </span>
      </div>

      <p className="text-[12px] theme-text-secondary leading-snug">
        Open any Lightning wallet and scan the code below, or copy the invoice
        to paste into a remote wallet.
      </p>

      {/* QR — functional white bg for scanner contrast. Framed in a subtle
          card so it reads as a deliberate module, not a floating rectangle. */}
      <div
        className="self-center rounded-2xl p-3 border theme-border"
        style={{ background: "#ffffff" }}
      >
        <QRCode value={swap.ln_invoice} size={220} />
      </div>

      <button
        type="button"
        onClick={onCopy}
        className="rounded-full theme-card-elevated border theme-border py-3 text-[13px] font-semibold theme-text inline-flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
      >
        <CopyIcon />
        Copy invoice
      </button>
    </div>
  );
}

// ── Action: pay-from-avark (muted, when balance is short) ───────────────────

function PayFromAvarkMuted({
  swap,
  balance,
}: {
  swap: SwapRecord;
  balance: WalletBalance | null;
}) {
  const shortfall =
    balance !== null
      ? Math.max(0, swap.source_amount_sats - balance.offchain_total_sat)
      : 0;

  return (
    <div className="mt-4 rounded-3xl theme-card-elevated border theme-border p-4 flex flex-col gap-3 opacity-90">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          Or pay from avark
        </span>
        {balance && (
          <span className="text-[11px] theme-text-muted tabular-nums">
            {balance.offchain_total_sat.toLocaleString()} sats available
          </span>
        )}
      </div>
      {balance && (
        <div className="flex items-start gap-2">
          <svg
            className="h-4 w-4 mt-0.5 shrink-0 theme-warning"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <p className="text-[12px] theme-text-secondary leading-snug">
            You need{" "}
            <span className="font-semibold theme-text tabular-nums">
              {shortfall.toLocaleString()} sats
            </span>{" "}
            more to cover this payment.
          </p>
        </div>
      )}
      <Link
        to="/dashboard"
        className="self-start inline-flex items-center gap-1.5 text-[12px] theme-accent font-semibold"
      >
        Top up via Receive
        <svg
          className="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </Link>
    </div>
  );
}

// ── Dismiss footer (manual "give up" on a stale awaiting_payment swap) ─────

function DismissFooter({
  dismissing,
  onDismiss,
}: {
  dismissing: boolean;
  onDismiss: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mt-4 rounded-3xl theme-card-elevated border theme-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          Give up on this swap
        </span>
      </div>
      <p className="text-[12px] theme-text-secondary leading-snug">
        LendaSwap hasn&rsquo;t seen a payment on this invoice. If Boltz has
        already refunded your sats (check <span className="font-semibold">Settings → Recovery</span>),
        you can mark this swap expired locally so it stops pestering you.
      </p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start text-[12px] theme-text-muted underline underline-offset-2"
        >
          Dismiss this swap
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={dismissing}
            className="rounded-full py-2 px-4 text-[12px] font-semibold theme-danger theme-danger-bg border theme-border disabled:opacity-50"
          >
            {dismissing ? "Dismissing…" : "Yes, mark expired"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={dismissing}
            className="rounded-full py-2 px-4 text-[12px] theme-text-muted"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ── Boltz in-flight (after a pay attempt that hit the duplicate error) ─────

function BoltzInFlightSection({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="mt-4 rounded-3xl theme-card border theme-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          Payment in flight
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] theme-accent uppercase tracking-[0.14em]">
          <span
            className="live-dot h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-accent)" }}
            aria-hidden="true"
          />
          Routing
        </span>
      </div>
      <p className="text-[12px] theme-text-secondary leading-snug">
        Your first tap started a Lightning payment via Boltz. It can take up to
        a minute to route. The status above will update automatically once it
        settles — don&rsquo;t retap, and don&rsquo;t start a new swap (that
        would risk double-paying).
      </p>
      <button
        type="button"
        onClick={onRefresh}
        className="rounded-full theme-card-elevated border theme-border py-2.5 text-[12px] font-semibold theme-text inline-flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
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
        Refresh now
      </button>
      <Link
        to="/recover/ln"
        className="self-start inline-flex items-center gap-1.5 text-[11px] theme-text-muted underline underline-offset-2"
      >
        Inspect or refund stuck swaps
        <svg
          className="h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </Link>
    </div>
  );
}

// ── Action: pay-externally (compact, when Pay-from-avark is primary) ────────

function PayExternallyCompact({
  swap,
  showQr,
  toggleQr,
  onCopy,
}: {
  swap: SwapRecord;
  showQr: boolean;
  toggleQr: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="mt-4 rounded-3xl theme-card-elevated border theme-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          Or scan externally
        </span>
        <button
          type="button"
          onClick={toggleQr}
          className="text-[11px] theme-accent font-semibold"
        >
          {showQr ? "Hide QR" : "Show QR"}
        </button>
      </div>
      {showQr && (
        <div
          className="self-center rounded-2xl p-3 border theme-border"
          style={{ background: "#ffffff" }}
        >
          <QRCode value={swap.ln_invoice} size={200} />
        </div>
      )}
      <button
        type="button"
        onClick={onCopy}
        className="rounded-full theme-card border theme-border py-2.5 text-[12px] font-semibold theme-text inline-flex items-center justify-center gap-2"
      >
        <CopyIcon />
        Copy invoice
      </button>
    </div>
  );
}

// ── Processing (claim) ───────────────────────────────────────────────────────

function ProcessingSection({
  swap,
  claiming,
  claimError,
  claimSubmitted,
  onClaim,
}: {
  swap: SwapRecord;
  claiming: boolean;
  claimError: string | null;
  claimSubmitted: boolean;
  onClaim: () => void;
}) {
  const hasTxHash = swap.claim_tx_hash !== null && swap.claim_tx_hash !== "";
  const awaiting = claimSubmitted || hasTxHash;

  return (
    <div className="mt-4 rounded-3xl theme-card border theme-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          {awaiting ? "Awaiting confirmation" : "Ready to claim"}
        </span>
      </div>

      {!awaiting && (
        <>
          <p className="text-[12px] theme-text-secondary leading-snug">
            Your sats have been accepted. Tap claim to release{" "}
            <span className="font-semibold theme-text">
              {swap.target_amount} {tokenLabel(swap.target_token)}
            </span>{" "}
            to{" "}
            <span className="font-mono theme-text">
              {truncateAddress(swap.destination_address)}
            </span>
            . LendaSwap submits the on-chain transaction gaslessly via Gelato —
            no wallet signature needed.
          </p>
          <button
            type="button"
            onClick={onClaim}
            disabled={claiming}
            className="rounded-full theme-button-primary py-3.5 text-[15px] font-bold disabled:opacity-50"
          >
            {claiming ? "Submitting claim…" : "Claim stablecoins"}
          </button>
          {claimError && (
            <p className="text-[11px] theme-danger" role="alert">
              {claimError}
            </p>
          )}
        </>
      )}

      {awaiting && (
        <>
          <p className="text-[12px] theme-text-secondary leading-snug">
            Gelato is broadcasting your claim on Ethereum. This usually confirms
            within a minute but can take longer at peak gas.
          </p>
          {hasTxHash ? (
            <ClaimTxLink hash={swap.claim_tx_hash!} />
          ) : (
            <div className="inline-flex items-center gap-2 text-[11px] theme-text-muted">
              <span
                className="h-1.5 w-1.5 rounded-full shimmer-skeleton"
                aria-hidden="true"
              />
              Waiting for transaction hash…
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ClaimTxLink({ hash }: { hash: string }) {
  return (
    <a
      href={`${ETHERSCAN_TX_BASE}${hash}`}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-[11px] theme-accent font-semibold break-all"
    >
      <svg
        className="h-3.5 w-3.5 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
      <span className="font-mono">{hash}</span>
    </a>
  );
}

// ── Terminal ─────────────────────────────────────────────────────────────────

function TerminalSection({
  swap,
  onStartNew,
}: {
  swap: SwapRecord;
  onStartNew: () => void;
}) {
  const [title, body] =
    swap.status === "completed"
      ? [
          "Swap complete",
          `${swap.target_amount} ${tokenLabel(swap.target_token)} is in your wallet.`,
        ]
      : swap.status === "refunded"
        ? ["Swap refunded", "Your sats were returned. No action needed."]
        : swap.status === "expired"
          ? [
              "Invoice expired",
              "The Lightning invoice timed out before payment was seen. Start a new swap to retry.",
            ]
          : [
              "Swap failed",
              "Something went wrong and the swap couldn't complete. Start a new swap to retry.",
            ];
  return (
    <div className="mt-4 rounded-3xl theme-card border theme-border p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
          {title}
        </span>
      </div>
      <p className="text-[12px] theme-text-secondary leading-snug">{body}</p>
      {swap.claim_tx_hash && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
            Claim tx
          </span>
          <ClaimTxLink hash={swap.claim_tx_hash} />
        </div>
      )}
      <button
        type="button"
        onClick={onStartNew}
        className="mt-1 rounded-full theme-button-primary py-3 text-[14px] font-bold"
      >
        Start new swap
      </button>
    </div>
  );
}

// ── Iconography ──────────────────────────────────────────────────────────────

function CopyIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}
