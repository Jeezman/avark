import { useState } from "react";
import { formatFiat, type BtcRate } from "../../utils/fiatRates";
import type { RateStatus } from "../../context/FiatContext";
import { formatQuoteTime } from "../../utils/format";
import { CurrencyPicker } from "./CurrencyPicker";

const SATS_PER_BTC = 100_000_000;

export function FiatTickerCard({
  enabled,
  onToggle,
  currency,
  rate,
  status,
  onRefresh,
  onCurrencyChange,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  currency: string;
  rate: BtcRate | null;
  status: RateStatus;
  onRefresh: () => void;
  onCurrencyChange: (code: string) => void;
}) {
  const price = enabled && rate ? formatFiat(SATS_PER_BTC, rate.rate, currency) : null;
  const [lastPrice, setLastPrice] = useState<string>("");
  if (price && price !== lastPrice) {
    setLastPrice(price);
  }

  // Derive the visible state. When a background refresh fails we keep the
  // last rate visible but mark it stale.
  const tickerState: "off" | "live" | "loading" | "stale" | "failed" = !enabled
    ? "off"
    : status === "ready" && rate
      ? "live"
      : status === "error" && rate
        ? "stale"
        : status === "error"
          ? "failed"
          : "loading";

  const badge =
    tickerState === "live"
      ? { label: "Live", color: "var(--color-accent)", text: "theme-accent", pulse: false, ping: true }
      : tickerState === "loading"
        ? { label: "Syncing", color: "var(--color-accent)", text: "theme-accent", pulse: true, ping: false }
        : tickerState === "stale"
          ? { label: "Stale", color: "var(--color-warning)", text: "theme-warning", pulse: false, ping: false }
          : tickerState === "failed"
            ? { label: "Failed", color: "var(--color-danger)", text: "theme-danger", pulse: false, ping: false }
            : { label: "Off", color: "var(--color-text-faint)", text: "theme-text-muted", pulse: false, ping: false };

  return (
    <div className="rounded-2xl theme-card p-4 space-y-4">
      {/* Header: status badge + segmented ON / OFF */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
            {badge.ping && (
              <span
                className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping"
                style={{ background: badge.color }}
              />
            )}
            <span
              className={`relative inline-flex rounded-full h-1.5 w-1.5 ${
                badge.pulse ? "animate-pulse" : ""
              }`}
              style={{ background: badge.color }}
            />
          </span>
          <span
            className={`text-[10px] font-mono font-semibold tracking-[0.2em] uppercase ${badge.text} ${
              badge.pulse ? "animate-pulse" : ""
            }`}
          >
            {badge.label}
          </span>
        </div>
        <div className="flex rounded-xl theme-card-elevated p-0.5" role="group" aria-label="Fiat display">
          <button
            onClick={() => onToggle(true)}
            aria-pressed={enabled}
            className={`rounded-lg px-3 py-1 text-[11px] font-mono font-semibold tracking-wider transition-colors ${
              enabled ? "theme-accent-bg" : "theme-text-muted"
            }`}
          >
            ON
          </button>
          <button
            onClick={() => onToggle(false)}
            aria-pressed={!enabled}
            className={`rounded-lg px-3 py-1 text-[11px] font-mono font-semibold tracking-wider transition-colors ${
              !enabled ? "theme-accent-bg" : "theme-text-muted"
            }`}
          >
            OFF
          </button>
        </div>
      </div>

      {/* Quote readout */}
      <div className="pt-0.5">
        {tickerState === "live" && price && rate ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-2xl font-semibold tracking-tight theme-text truncate">
                {price}
              </span>
              <span className="text-[11px] theme-text-faint shrink-0">/ BTC</span>
            </div>
            <p className="text-[10px] font-mono theme-text-faint tracking-wide">
              quoted {formatQuoteTime(rate.timestamp)} · yadio.io
            </p>
          </div>
        ) : tickerState === "stale" && price && rate ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-2xl font-semibold tracking-tight theme-text truncate opacity-70">
                {price}
              </span>
              <span className="text-[11px] theme-text-faint shrink-0">/ BTC</span>
            </div>
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-mono theme-warning tracking-wide">
                last quote {formatQuoteTime(rate.timestamp)} · refresh failed
              </p>
              <button
                onClick={onRefresh}
                className="text-[10px] font-mono theme-accent underline underline-offset-2 hover:opacity-80"
              >
                retry
              </button>
            </div>
          </div>
        ) : tickerState === "failed" ? (
          <div className="space-y-2">
            <div className="flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-sm font-semibold tracking-wide theme-danger uppercase">
                Couldn't reach yadio.io
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={onRefresh}
                className="flex items-center gap-1.5 rounded-lg theme-card-elevated px-3 py-1.5 text-[11px] font-mono font-semibold tracking-wider theme-text hover:opacity-80 transition-opacity"
              >
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                RETRY
              </button>
              <p className="text-[10px] font-mono theme-text-faint tracking-wide">
                check your connection
              </p>
            </div>
          </div>
        ) : tickerState === "loading" ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 font-mono tabular-nums">
              <span
                className="relative inline-block"
                aria-label="Fetching quote"
                role="status"
              >
                {/* Invisible sizer — matches the footprint of the real price */}
                <span className="invisible text-2xl font-semibold tracking-tight">
                  {lastPrice || "$00,000.00"}
                </span>
                <span className="shimmer-skeleton absolute inset-y-1 inset-x-0 rounded-md" />
              </span>
              <span className="text-[11px] theme-text-faint shrink-0">/ BTC</span>
            </div>
            <p className="text-[10px] font-mono theme-text-faint tracking-wide">
              updating · yadio.io
            </p>
          </div>
        ) : (
          <div className="space-y-1 opacity-70">
            <div className="flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-2xl font-semibold tracking-tight theme-text-faint">
                — — —
              </span>
              <span className="text-[11px] theme-text-faint">/ BTC</span>
            </div>
            <p className="text-[10px] font-mono theme-text-faint tracking-wide">
              fiat equivalents hidden beneath sat amounts
            </p>
          </div>
        )}
      </div>

      {enabled && (
        <>
          <div className="border-t theme-border -mx-4" />
          <CurrencyPicker currency={currency} onChange={onCurrencyChange} />
        </>
      )}
    </div>
  );
}
