import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { useTheme } from "../context/ThemeContext";
import { PinSetupFlow, PinDisableFlow, usePinLock } from "../context/PinLockContext";
import { useFiat } from "../context/FiatContext";
import {
  AFRICAN_CURRENCY_CODES,
  formatFiat,
  SUPPORTED_FIAT_CURRENCIES,
  type BtcRate,
  type FiatCurrency,
} from "../utils/fiatRates";
import type { RateStatus } from "../context/FiatContext";

interface SettingsData {
  asp_url: string | null;
  network: string | null;
  esplora_url: string | null;
}

const PRESET_EXPLORERS = [
  { label: "Blockstream", url: "https://blockstream.info/api" },
  { label: "Mempool.space", url: "https://mempool.space/api" },
];
const PRESET_URLS = new Set(PRESET_EXPLORERS.map((e) => e.url));

function EsploraSelector({
  value,
  onChange,
  saving,
  onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  saving: boolean;
  onSave: (url: string | null) => void;
}) {
  const isCustom = value !== "" && !PRESET_URLS.has(value);
  // Blockstream is the default — saving it is equivalent to clearing
  const urlToSave = value === "https://blockstream.info/api" || value === "" ? null : value;

  return (
    <div className="rounded-2xl theme-card p-4 mt-3 space-y-3">
      <p className="text-xs theme-text-muted mb-0.5">Block Explorer (Esplora)</p>
      <div className="space-y-1.5">
        {PRESET_EXPLORERS.map((option) => (
          <button
            key={option.url}
            onClick={() => onChange(option.url)}
            className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
              value === option.url ? "theme-accent-bg" : "theme-card-elevated"
            }`}
          >
            <span className={`h-3 w-3 rounded-full border-2 shrink-0 ${
              value === option.url ? "border-current bg-current" : "theme-border"
            }`} />
            <span className="flex-1">
              <span className="font-medium">{option.label}</span>
              <span className="block text-[10px] theme-text-faint font-mono mt-0.5">{option.url}</span>
            </span>
          </button>
        ))}
        <button
          onClick={() => { if (!isCustom) onChange("https://"); }}
          className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
            isCustom ? "theme-accent-bg" : "theme-card-elevated"
          }`}
        >
          <span className={`h-3 w-3 rounded-full border-2 shrink-0 ${
            isCustom ? "border-current bg-current" : "theme-border"
          }`} />
          <span className="font-medium">Custom</span>
        </button>
      </div>
      {isCustom && (
        <input
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://your-esplora-server.com/api"
          className="w-full rounded-xl theme-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-lime-300/50 font-mono"
        />
      )}
      <button
        disabled={saving}
        onClick={() => onSave(urlToSave)}
        className="w-full rounded-xl theme-card-elevated py-2.5 text-xs font-medium theme-text-secondary hover:opacity-80 transition-opacity disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save"}
      </button>
      <p className="text-[10px] theme-text-faint">Esplora server for onchain sync. Takes effect on next app restart.</p>
    </div>
  );
}

function CurrencyPicker({
  currency,
  onChange,
}: {
  currency: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = SUPPORTED_FIAT_CURRENCIES.find((c) => c.code === currency);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setQuery("");
    };
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        close();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byName = (a: FiatCurrency, b: FiatCurrency) => a.name.localeCompare(b.name);
    const selectedEntry = SUPPORTED_FIAT_CURRENCIES.find((c) => c.code === currency);

    if (q) {
      // Flat alphabetical while searching — grouping just adds noise.
      // Selected still floats to the top if it matches the query.
      const matches = SUPPORTED_FIAT_CURRENCIES.filter(
        (c) =>
          c.code !== currency &&
          (c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)),
      ).sort(byName);
      const selectedMatches =
        selectedEntry &&
        (selectedEntry.code.toLowerCase().includes(q) ||
          selectedEntry.name.toLowerCase().includes(q));
      return selectedMatches ? [selectedEntry, ...matches] : matches;
    }

    const african: FiatCurrency[] = [];
    const rest: FiatCurrency[] = [];
    for (const c of SUPPORTED_FIAT_CURRENCIES) {
      if (c.code === currency) continue;
      (AFRICAN_CURRENCY_CODES.has(c.code) ? african : rest).push(c);
    }
    const grouped = [...african.sort(byName), ...rest.sort(byName)];
    return selectedEntry ? [selectedEntry, ...grouped] : grouped;
  }, [query, currency]);

  return (
    <div className="space-y-2" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between rounded-xl theme-card-elevated px-3 py-2.5 text-left text-sm"
      >
        <span className="flex items-center gap-2">
          <span className="text-lg leading-none">{selected?.flag ?? "🌐"}</span>
          <span className="font-medium">{selected?.code ?? currency}</span>
          <span className="theme-text-muted text-xs">— {selected?.name ?? "Unknown"}</span>
        </span>
        <svg
          className={`h-4 w-4 theme-text-faint transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {open && (
        <div className="rounded-xl theme-card-elevated p-2 space-y-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search currency"
            autoCapitalize="none"
            autoCorrect="off"
            className="w-full rounded-lg theme-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-lime-300/50"
          />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filtered.length === 0 ? (
              <p className="text-xs theme-text-muted text-center py-4">No matches</p>
            ) : (
              filtered.map((c) => {
                const active = c.code === currency;
                return (
                  <button
                    key={c.code}
                    onClick={() => {
                      onChange(c.code);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      active ? "theme-accent-bg" : "hover:opacity-80"
                    }`}
                  >
                    <span className="text-lg leading-none">{c.flag}</span>
                    <span className="font-medium w-12">{c.code}</span>
                    <span className={`text-xs ${active ? "" : "theme-text-muted"}`}>{c.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const SATS_PER_BTC = 100_000_000;

function formatQuoteTime(ts: number): string {
  // yadio has historically returned ms; guard for seconds just in case
  const ms = ts > 1e12 ? ts : ts * 1000;
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function FiatTickerCard({
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
  // Keep the last rendered price so the shimmer skeleton during a currency
  // swap takes up the exact width a real price would — no layout pop when
  // the new quote arrives.
  const [lastPrice, setLastPrice] = useState<string>("");
  if (price && price !== lastPrice) {
    setLastPrice(price);
  }

  // Derive the visible state. When a background refresh fails we keep the
  // last rate visible but mark it stale. When an initial fetch fails we
  // have no rate to show — treat as a hard failure with a retry affordance.
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

export function SettingsRoute() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [seedStep, setSeedStep] = useState<"hidden" | "confirm" | "revealed">("hidden");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [loadingSeed, setLoadingSeed] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [esploraInput, setEsploraInput] = useState("");
  const [savingEsplora, setSavingEsplora] = useState(false);
  const { pinEnabled, refreshPinStatus } = usePinLock();
  const {
    enabled: fiatEnabled,
    currency: fiatCurrency,
    rate: fiatRate,
    status: fiatStatus,
    setEnabled: setFiatEnabled,
    setCurrency: setFiatCurrency,
    refreshRate: refreshFiatRate,
  } = useFiat();
  const [pinFlow, setPinFlow] = useState<"none" | "setup" | "disable">("none");
  const [maxAttempts, setMaxAttempts] = useState(10);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await invoke<SettingsData>("settings");
      setSettings(data);
      setEsploraInput(data.esplora_url ?? "");
    } catch (e) {
      console.warn("Failed to load settings:", e);
      toast.warning("Could not load settings");
      setSettings({ asp_url: null, network: null, esplora_url: null });
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    invoke<{ max_attempts: number }>("get_pin_status")
      .then((s) => setMaxAttempts(s.max_attempts))
      .catch(() => {});
  }, [pinEnabled]);

  const handleRevealSeed = async () => {
    if (mnemonic) {
      setSeedStep("revealed");
      return;
    }
    setLoadingSeed(true);
    try {
      const words = await invoke<string>("get_mnemonic");
      setMnemonic(words);
      setSeedStep("revealed");
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to retrieve seed phrase");
    } finally {
      setLoadingSeed(false);
    }
  };

  const handleThemeToggle = (newTheme: "dark" | "light") => {
    setTheme(newTheme);
  };

  const handleDeleteWallet = async () => {
    setDeleting(true);
    try {
      await invoke("delete_wallet");
      toast.success("Wallet deleted");
      void navigate({ to: "/", replace: true });
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to delete wallet");
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  // PIN setup/disable flows render full-screen
  if (pinFlow === "setup") {
    return (
      <PinSetupFlow
        onComplete={() => { setPinFlow("none"); void refreshPinStatus(); }}
        onCancel={() => setPinFlow("none")}
      />
    );
  }
  if (pinFlow === "disable") {
    return (
      <PinDisableFlow
        onComplete={() => { setPinFlow("none"); void refreshPinStatus(); }}
        onCancel={() => setPinFlow("none")}
      />
    );
  }

  return (
    <main className="theme-text" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      {/* Header */}
      <div className="px-6 pt-4 pb-4">
        <h1 className="text-lg font-bold">Settings</h1>
      </div>

      {/* Appearance */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Appearance</h2>
        <div className="rounded-2xl theme-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">Theme</span>
            <div className="flex rounded-xl theme-card-elevated p-0.5">
              <button
                onClick={() => handleThemeToggle("dark")}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  theme === "dark" ? "theme-accent-bg" : "theme-text-muted"
                }`}
              >
                Dark
              </button>
              <button
                onClick={() => handleThemeToggle("light")}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  theme === "light" ? "theme-accent-bg" : "theme-text-muted"
                }`}
              >
                Light
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Currency */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Currency</h2>
        <FiatTickerCard
          enabled={fiatEnabled}
          onToggle={setFiatEnabled}
          currency={fiatCurrency}
          rate={fiatRate}
          status={fiatStatus}
          onRefresh={refreshFiatRate}
          onCurrencyChange={setFiatCurrency}
        />
      </div>

      {/* Security */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Security</h2>
        <div className="rounded-2xl theme-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">PIN Lock</span>
            {pinEnabled ? (
              <button
                onClick={() => setPinFlow("disable")}
                className="rounded-lg px-3 py-1 text-xs font-medium theme-accent-bg"
              >
                Enabled
              </button>
            ) : (
              <button
                onClick={() => setPinFlow("setup")}
                className="rounded-lg px-3 py-1 text-xs font-medium theme-card-elevated theme-text-muted"
              >
                Disabled
              </button>
            )}
          </div>
          {pinEnabled && (
              <div className="flex items-center justify-between">
                <span className="text-sm">Max PIN attempts</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      const prev = maxAttempts;
                      const next = Math.max(3, maxAttempts - 1);
                      setMaxAttempts(next);
                      try {
                        await invoke("set_max_pin_attempts", { max_attempts: next });
                      } catch (e) {
                        setMaxAttempts(prev);
                        toast.error(typeof e === "string" ? e : "Failed to update");
                      }
                    }}
                    disabled={maxAttempts <= 3}
                    className="h-7 w-7 rounded-lg theme-card-elevated flex items-center justify-center text-sm font-bold disabled:opacity-30"
                    aria-label="Decrease max attempts"
                  >
                    -
                  </button>
                  <span className="text-sm font-semibold w-6 text-center tabular-nums">
                    {maxAttempts}
                  </span>
                  <button
                    onClick={async () => {
                      const prev = maxAttempts;
                      const next = Math.min(10, maxAttempts + 1);
                      setMaxAttempts(next);
                      try {
                        await invoke("set_max_pin_attempts", { max_attempts: next });
                      } catch (e) {
                        setMaxAttempts(prev);
                        toast.error(typeof e === "string" ? e : "Failed to update");
                      }
                    }}
                    disabled={maxAttempts >= 10}
                    className="h-7 w-7 rounded-lg theme-card-elevated flex items-center justify-center text-sm font-bold disabled:opacity-30"
                    aria-label="Increase max attempts"
                  >
                    +
                  </button>
                </div>
              </div>
          )}
        </div>
      </div>

      {/* Wallet */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Wallet</h2>
        {seedStep === "hidden" && (
          <div className="rounded-2xl theme-card divide-y theme-divide">
            <button
              onClick={() => setSeedStep("confirm")}
              className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-left theme-card transition-colors"
            >
              <span>Back Up Seed Phrase</span>
              <svg className="h-4 w-4 theme-text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}
        {seedStep === "confirm" && (
          <div className="rounded-2xl theme-warning-bg border theme-warning-border p-4">
            <p className="text-sm font-medium theme-warning mb-2">Reveal seed phrase?</p>
            <p className="text-xs theme-text-secondary mb-1">Your seed phrase gives full access to your funds. Before continuing:</p>
            <ul className="text-xs theme-text-muted mb-4 space-y-1 list-disc list-inside">
              <li>Make sure no one can see your screen</li>
              <li>Do not screenshot or copy to clipboard</li>
              <li>Write the words down on paper only</li>
            </ul>
            <p className="text-xs theme-text-muted mb-2">
              Type <span className="font-mono font-medium theme-text">reveal my seed</span> to continue
            </p>
            <input
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder="reveal my seed"
              className="w-full rounded-xl theme-input px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-500/50 mb-4 font-mono"
            />
            <div className="flex gap-3">
              <button
                onClick={() => { setSeedStep("hidden"); setConfirmInput(""); }}
                className="flex-1 rounded-xl theme-card-elevated py-2.5 text-sm font-medium theme-text-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleRevealSeed()}
                disabled={loadingSeed || confirmInput.trim().toLowerCase() !== "reveal my seed"}
                className="flex-1 rounded-xl bg-yellow-500 py-2.5 text-sm font-bold text-gray-900 transition-colors hover:bg-yellow-400 disabled:opacity-30"
              >
                {loadingSeed ? "Loading..." : "Reveal"}
              </button>
            </div>
          </div>
        )}
        {seedStep === "revealed" && mnemonic && (
          <div className="rounded-2xl theme-warning-bg border theme-warning-border p-4">
            <p className="text-xs theme-warning mb-2 font-medium">Write these words down on paper — do not copy digitally</p>
            <p className="text-sm font-mono leading-relaxed">{mnemonic}</p>
            <p className="mt-3 text-[10px] theme-danger">Never screenshot, copy to clipboard, or store digitally. Clipboard data can be read by other apps.</p>
            <button
              onClick={() => {
                setSeedStep("hidden");
                setMnemonic(null);
                setConfirmInput("");
              }}
              className="mt-3 rounded-xl theme-card-elevated px-4 py-2 text-xs font-medium theme-text-muted hover:opacity-80 transition-opacity"
            >
              Hide seed phrase
            </button>
          </div>
        )}
      </div>

      {/* Network */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Network</h2>
        <div className="rounded-2xl theme-card p-4 space-y-3">
          <div>
            <p className="text-xs theme-text-muted mb-0.5">ASP URL</p>
            <p className="text-sm font-mono break-all">{settings?.asp_url ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs theme-text-muted mb-0.5">Network</p>
            <p className="text-sm">{settings?.network ?? "—"}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-lime-400" />
            <span className="text-xs theme-text-muted">Connected</span>
          </div>
        </div>
        <EsploraSelector
          value={esploraInput}
          onChange={setEsploraInput}
          saving={savingEsplora}
          onSave={async (url) => {
            setSavingEsplora(true);
            try {
              await invoke("set_esplora_url", { url });
              toast.success("Explorer saved — takes effect on next app restart");
            } catch (e) {
              toast.error(typeof e === "string" ? e : "Failed to save");
            } finally {
              setSavingEsplora(false);
            }
          }}
        />
      </div>

      {/* About */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">About</h2>
        <div className="rounded-2xl theme-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm theme-text-secondary">App</span>
            <span className="text-sm font-semibold">Avark</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm theme-text-secondary">Version</span>
            <span className="text-sm font-mono theme-text-muted">0.1.0</span>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="px-6 pb-8">
        <h2 className="text-xs font-semibold theme-danger uppercase tracking-wider mb-3">Danger Zone</h2>
        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="w-full rounded-2xl theme-danger-bg border theme-border px-4 py-3 text-sm font-medium theme-danger hover:opacity-80 transition-colors"
          >
            Delete Wallet
          </button>
        ) : (
          <div className="rounded-2xl theme-danger-bg border theme-border p-4">
            <p className="text-sm theme-danger font-medium mb-1">Delete your wallet?</p>
            <p className="text-xs theme-text-muted mb-4">This cannot be undone. Make sure you have backed up your seed phrase.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="flex-1 rounded-xl theme-card-elevated py-2.5 text-sm font-medium theme-text-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteWallet()}
                disabled={deleting}
                className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
