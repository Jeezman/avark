import { useEffect, useMemo, useRef, useState } from "react";
import {
  AFRICAN_CURRENCY_CODES,
  SUPPORTED_FIAT_CURRENCIES,
  type FiatCurrency,
} from "../../utils/fiatRates";

export function CurrencyPicker({
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
