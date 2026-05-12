import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { WalletConnectButton } from "../components/WalletConnectButton";
import { useWalletConnect } from "../context/WalletConnectContext";
import { formatLendaSwapError } from "../utils/lendaswapErrors";
import {
  BtcMark,
  SwapDirectionIcon,
  TokenMark,
} from "../components/swap/SwapIcons";
import {
  type AvarkQuote,
  createSwap,
  getQuote,
  type TargetTokenId,
} from "../lib/lendaswap/client";
import { reconcilePendingSwaps } from "../lib/lendaswap/reconcile";

const TOKENS = [
  { id: "usdc_eth", label: "USDC", chain: "Ethereum" },
  { id: "usdt_eth", label: "USDT", chain: "Ethereum" },
] as const;
type TokenId = TargetTokenId;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RATE_DEBOUNCE_MS = 300;

export function SwapRoute() {
  const navigate = useNavigate();
  const { address: connectedAddress, status: wcStatus } = useWalletConnect();

  const [amountSats, setAmountSats] = useState("");
  const [token, setToken] = useState<TokenId>("usdc_eth");
  const [destMode, setDestMode] = useState<"paste" | "connected">("paste");
  const [pastedAddress, setPastedAddress] = useState("");

  const [rate, setRate] = useState<AvarkQuote | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // True when the last submit was rejected by the Boltz-Arkade preflight.
  // Disables the submit CTA until the user changes their inputs (new quote
  // → effect below clears this flag). Prevents the "tap button → get same
  // error → tap again" loop.
  const [bridgeUnavailable, setBridgeUnavailable] = useState(false);

  // Countdown ticker: one interval updates `nowSec` once per second.
  // `setNow` runs inside the interval callback (not synchronously in the
  // effect body), so it stays clear of `react-hooks/set-state-in-effect`.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Catch up any swap statuses that flipped while the app was closed.
  // Memoized per session — cheap to call on every mount of this route.
  useEffect(() => {
    void reconcilePendingSwaps();
  }, []);

  const parsedAmount = parseAmountSats(amountSats);
  const destinationAddress =
    destMode === "connected" ? (connectedAddress ?? "") : pastedAddress.trim();

  const addressValid = EVM_ADDRESS_RE.test(destinationAddress);
  const rateMatchesInput =
    rate !== null &&
    rate.sourceAmountSats === parsedAmount &&
    rate.targetToken === token;
  const secondsLeft = rateMatchesInput ? Math.max(0, rate!.expiresAt - nowSec) : null;
  const rateFresh = secondsLeft !== null && secondsLeft > 0;

  // Strict `>` on min because the server rejects the quoted min itself
  // (it reports `minAmountSats` as the floor of the disallowed range, not
  // the smallest accepted amount). Max stays non-strict until we observe
  // similar off-by-one behavior there.
  const withinBounds =
    rateMatchesInput &&
    parsedAmount !== null &&
    parsedAmount > rate!.minAmountSats &&
    parsedAmount <= rate!.maxAmountSats;

  const canSubmit =
    !submitting &&
    !bridgeUnavailable &&
    addressValid &&
    parsedAmount !== null &&
    rateFresh &&
    withinBounds;

  const fetchRate = useCallback(async (tok: TokenId, amount: number) => {
    setRateLoading(true);
    setRateError(null);
    try {
      const r = await getQuote(tok, amount);
      setRate(r);
    } catch (e) {
      setRateError(formatLendaSwapError(e));
    } finally {
      setRateLoading(false);
    }
  }, []);

  // Debounced rate fetch — each input change schedules a fetch 300ms out,
  // previous pending fetches are cancelled. setState only fires inside the
  // async callback so we stay off the set-state-in-effect warning.
  useEffect(() => {
    if (parsedAmount === null) return;
    const handle = setTimeout(() => {
      void fetchRate(token, parsedAmount);
    }, RATE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [parsedAmount, token, fetchRate]);

  // Auto-refresh at expiry: schedule a one-shot fetch keyed on the current
  // rate's expiry. A ref guards against back-to-back refreshes if the clock
  // is already past expiry (e.g. tab was backgrounded).
  const refreshInflightRef = useRef(false);
  useEffect(() => {
    if (!rate || !rateMatchesInput) return;
    const delayMs = Math.max(0, rate.expiresAt * 1000 - Date.now());
    const handle = setTimeout(() => {
      if (refreshInflightRef.current) return;
      refreshInflightRef.current = true;
      void fetchRate(rate.targetToken, rate.sourceAmountSats).finally(() => {
        refreshInflightRef.current = false;
      });
    }, delayMs);
    return () => clearTimeout(handle);
  }, [rate, rateMatchesInput, fetchRate]);

  async function handleSubmit() {
    if (!canSubmit || parsedAmount === null || rate === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const swap = await createSwap({
        targetToken: token,
        amountSats: parsedAmount,
        targetAddress: destinationAddress,
        quote: rate,
      });
      navigate({ to: "/swap/checkout/$id", params: { id: swap.id } });
    } catch (e) {
      const msg = formatLendaSwapError(e);
      setSubmitError(msg);
      if (isBridgeUnavailableError(msg)) {
        setBridgeUnavailable(true);
      }
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Auto-dismiss the inline submit error after a few seconds — the toast has
  // already fired, and an always-visible red banner next to a muted CTA is
  // visually loud. Users who miss the toast can still tell something failed
  // from the CTA label + disabled state.
  useEffect(() => {
    if (!submitError) return;
    const handle = setTimeout(() => setSubmitError(null), 6000);
    return () => clearTimeout(handle);
  }, [submitError]);

  // Reset the bridge-unavailable flag as soon as a new rate is fetched —
  // signals the user has moved on (different amount, token, or retry after
  // backoff) and we can let them try again.
  useEffect(() => {
    if (rate && bridgeUnavailable) {
      setBridgeUnavailable(false);
    }
  }, [rate, bridgeUnavailable]);

  function useConnectedAddress() {
    if (!connectedAddress) return;
    setDestMode("connected");
  }

  function switchToPaste() {
    setDestMode("paste");
  }

  const belowMin =
    rateMatchesInput && parsedAmount !== null && parsedAmount <= rate!.minAmountSats;
  const aboveMax =
    rateMatchesInput && parsedAmount !== null && parsedAmount > rate!.maxAmountSats;

  return (
    <div
      className="theme-text flex flex-col min-h-[calc(100dvh-3.5rem)] px-5 pb-28"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.25rem)" }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h1 className="font-display text-[26px] leading-none tracking-wide theme-text">
            Swap
          </h1>
          <p className="text-[11px] theme-text-muted mt-1 tracking-wider uppercase">
            Bitcoin <span className="mx-1">→</span> Stablecoin
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            to="/swap/history"
            aria-label="Swap history"
            title="Swap history"
            className="h-8 w-8 rounded-full theme-card-elevated border theme-border flex items-center justify-center theme-text-muted hover:theme-text transition-colors"
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
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </Link>
          <WalletConnectButton />
        </div>
      </header>

      {/* ── Unified swap panel ──────────────────────────────────────────── */}
      <div className="swap-surface relative rounded-[28px] border theme-border overflow-hidden">
        {/* YOU PAY */}
        <div className="relative px-5 pt-5 pb-8">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
              You pay
            </span>
            <span className="theme-btc-bg inline-flex items-center gap-1.5 rounded-full pl-1.5 pr-2.5 py-0.5 text-[11px] font-semibold">
              <BtcMark className="h-4 w-4" />
              BTC · Lightning
            </span>
          </div>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={amountSats}
            onChange={(e) => setAmountSats(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="0"
            aria-label="Amount in sats"
            className="w-full bg-transparent font-display text-[44px] leading-none tabular-nums focus:outline-none theme-text placeholder:theme-text-faint"
          />
          <div className="mt-2 flex items-center justify-between text-[12px]">
            <span className="theme-text-muted tabular-nums">
              {parsedAmount !== null ? `${parsedAmount.toLocaleString()} sats` : "sats"}
            </span>
            {rateMatchesInput && rate && (
              <span className="theme-text-muted tabular-nums">
                min {rate.minAmountSats.toLocaleString()} · max {rate.maxAmountSats.toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* Swap direction indicator — visually bridges the two panels */}
        <div className="relative h-0 z-10">
          <div
            className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t theme-border"
            aria-hidden="true"
          />
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-11 w-11 rounded-full flex items-center justify-center"
            style={{
              background:
                "linear-gradient(135deg, var(--color-bitcoin-bg), var(--color-accent-bg))",
              boxShadow:
                "0 0 0 4px var(--color-bg-primary), 0 4px 16px rgba(0,0,0,0.25)",
            }}
            aria-hidden="true"
          >
            <SwapDirectionIcon className="h-4 w-4 theme-text" />
          </div>
        </div>

        {/* YOU RECEIVE */}
        <div className="relative px-5 pt-8 pb-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
              You receive
            </span>
            <RateStatus
              loading={rateLoading}
              error={rateError}
              rate={rateMatchesInput ? rate : null}
              secondsLeft={secondsLeft}
            />
          </div>

          {/* Token picker */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            {TOKENS.map((t) => {
              const active = token === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setToken(t.id)}
                  aria-pressed={active}
                  className={`relative flex items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-sm font-semibold transition-all active:scale-[0.98] ${
                    active
                      ? "theme-accent-bg border theme-border"
                      : "theme-card-elevated theme-text-muted border border-transparent"
                  }`}
                  style={
                    active
                      ? { borderColor: "var(--color-accent)" }
                      : undefined
                  }
                >
                  <span className="flex items-center gap-2">
                    <TokenMark id={t.id} className="h-6 w-6" />
                    <span className={active ? "theme-text" : ""}>{t.label}</span>
                  </span>
                  {active && (
                    <svg
                      className="h-4 w-4 theme-text"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          {/* Receive amount */}
          <div className="flex items-baseline justify-between">
            <span
              className={`font-display text-[34px] leading-none tabular-nums ${
                rateMatchesInput && rate ? "theme-text" : "theme-text-faint"
              }`}
            >
              {rateMatchesInput && rate ? rate.targetAmount : "—"}
            </span>
            <span className="text-[11px] theme-text-muted uppercase tracking-[0.14em]">
              on Ethereum
            </span>
          </div>

          {(belowMin || aboveMax) && (
            <p className="mt-3 text-[12px] theme-danger">
              {belowMin
                ? `Must be more than ${rate!.minAmountSats.toLocaleString()} sats.`
                : `Must be at most ${rate!.maxAmountSats.toLocaleString()} sats.`}
            </p>
          )}
          {rateError && !rateLoading && (
            <p className="mt-3 text-[12px] theme-danger">{rateError}</p>
          )}
        </div>
      </div>

      {/* ── Destination address ─────────────────────────────────────────── */}
      <div className="mt-4 rounded-3xl theme-card border theme-border p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
            Destination
          </span>
          <div className="inline-flex rounded-full theme-card p-0.5 text-[11px] font-semibold">
            <button
              type="button"
              onClick={switchToPaste}
              aria-pressed={destMode === "paste"}
              className={`rounded-full px-3 py-1 transition-colors ${
                destMode === "paste" ? "theme-text" : "theme-text-muted"
              }`}
              style={
                destMode === "paste"
                  ? { background: "var(--color-bg-card-hover)" }
                  : undefined
              }
            >
              Paste
            </button>
            <button
              type="button"
              onClick={useConnectedAddress}
              disabled={!connectedAddress}
              aria-pressed={destMode === "connected"}
              className={`rounded-full px-3 py-1 transition-colors disabled:opacity-40 ${
                destMode === "connected" ? "theme-text" : "theme-text-muted"
              }`}
              style={
                destMode === "connected"
                  ? { background: "var(--color-bg-card-hover)" }
                  : undefined
              }
            >
              Wallet
            </button>
          </div>
        </div>

        {destMode === "paste" ? (
          <>
            <input
              type="text"
              value={pastedAddress}
              onChange={(e) => setPastedAddress(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Destination EVM address"
              className="w-full bg-transparent font-mono text-[13px] focus:outline-none theme-text placeholder:theme-text-faint"
            />
            <div className="mt-3 flex items-start gap-2 rounded-xl theme-card-elevated px-3 py-2">
              <svg
                className="h-3.5 w-3.5 mt-0.5 shrink-0 theme-text-muted"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
              <p className="text-[11px] leading-snug theme-text-muted">
                Claiming requires a signature from this address's owner.
              </p>
            </div>
            {pastedAddress.length > 0 && !addressValid && (
              <p className="mt-2 text-[11px] theme-danger">Not a valid EVM address.</p>
            )}
          </>
        ) : (
          <>
            <div className="font-mono text-[13px] break-all theme-text min-h-[1.4em]">
              {connectedAddress ?? (
                <span className="theme-text-faint">
                  Connect a wallet above to auto-fill.
                </span>
              )}
            </div>
            {destMode === "connected" && wcStatus !== "connected" && (
              <p className="mt-2 text-[11px] theme-danger">
                Wallet disconnected — reconnect to continue.
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Fee breakdown (only when we have a matched live rate) ───────── */}
      {rateMatchesInput && rate && (
        <div className="mt-4 rounded-3xl theme-card border theme-border p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] theme-text-muted">
              Fees
            </span>
            <span className="text-[11px] theme-text-muted tabular-nums">
              {(rate.networkFee + rate.protocolFee).toLocaleString()} sats total
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <FeeTile label="Network" value={rate.networkFee.toLocaleString()} unit="sats" />
            <FeeTile label="Protocol" value={rate.protocolFee.toLocaleString()} unit="sats" />
            <FeeTile label="Service" value={rate.serviceFee.toLocaleString()} unit="sats" />
          </div>
        </div>
      )}

      <div className="flex-1" />

      {/* ── Sticky primary CTA above bottom nav ─────────────────────────── */}
      <div
        className="fixed left-0 right-0 px-5 pointer-events-none"
        style={{
          bottom: "calc(3.5rem + env(safe-area-inset-bottom, 0px))",
          paddingTop: "16px",
          paddingBottom: "12px",
          background:
            "linear-gradient(to top, var(--color-bg-primary) 60%, transparent 100%)",
        }}
      >
        {submitError && (
          <p
            className="mb-2 text-center text-[11px] theme-danger pointer-events-auto"
            role="alert"
          >
            {submitError}
          </p>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full rounded-full theme-button-primary py-3.5 text-[15px] font-bold pointer-events-auto disabled:opacity-40"
        >
          {submitButtonLabel({
            submitting,
            canSubmit,
            parsedAmount,
            addressValid,
            rateFresh,
            withinBounds,
            rateMatchesInput,
            bridgeUnavailable,
          })}
        </button>
      </div>
    </div>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────────

function RateStatus({
  loading,
  error,
  rate,
  secondsLeft,
}: {
  loading: boolean;
  error: string | null;
  rate: AvarkQuote | null;
  secondsLeft: number | null;
}) {
  if (loading && !rate) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] theme-text-muted">
        <span className="h-1.5 w-1.5 rounded-full theme-text-muted shimmer-skeleton" />
        Fetching…
      </span>
    );
  }
  if (error && !loading) {
    return <span className="text-[11px] theme-danger">Quote error</span>;
  }
  if (!rate) {
    return (
      <span className="text-[11px] theme-text-faint uppercase tracking-wider">
        Awaiting
      </span>
    );
  }
  if (secondsLeft === null || secondsLeft <= 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] theme-warning">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--color-warning)" }}
        />
        Refreshing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] theme-accent tabular-nums">
      <span
        className="live-dot h-1.5 w-1.5 rounded-full"
        style={{ background: "var(--color-accent)" }}
      />
      Live · {secondsLeft}s
    </span>
  );
}

function FeeTile({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="rounded-xl theme-card-elevated px-3 py-2.5">
      <div className="text-[10px] theme-text-muted uppercase tracking-wider mb-0.5">
        {label}
      </div>
      <div className="text-[13px] font-semibold tabular-nums theme-text">{value}</div>
      <div className="text-[10px] theme-text-faint">{unit}</div>
    </div>
  );
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function submitButtonLabel({
  submitting,
  canSubmit,
  parsedAmount,
  addressValid,
  rateFresh,
  withinBounds,
  rateMatchesInput,
  bridgeUnavailable,
}: {
  submitting: boolean;
  canSubmit: boolean;
  parsedAmount: number | null;
  addressValid: boolean;
  rateFresh: boolean;
  withinBounds: boolean;
  rateMatchesInput: boolean;
  bridgeUnavailable: boolean;
}): string {
  if (submitting) return "Creating swap…";
  if (bridgeUnavailable) return "Bridge unavailable — try again soon";
  if (canSubmit && parsedAmount !== null) {
    return `Swap ${parsedAmount.toLocaleString()} sats`;
  }
  if (parsedAmount === null) return "Enter an amount";
  if (!addressValid) return "Enter destination address";
  if (!rateMatchesInput || !rateFresh) return "Fetching quote…";
  if (!withinBounds) return "Adjust amount";
  return "Create swap";
}

/**
 * Matches the Boltz-Arkade preflight rejection thrown by `createSwap` in
 * `src/lib/lendaswap/client.ts`. Used to flip the UI into a "bridge down,
 * don't retap" state rather than just flashing a toast.
 */
function isBridgeUnavailableError(msg: string): boolean {
  return /lightning bridge is currently unavailable/i.test(msg);
}

function parseAmountSats(input: string): number | null {
  const v = parseInt(input, 10);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}
