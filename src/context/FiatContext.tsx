import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  fetchBtcRate,
  formatFiat,
  SUPPORTED_FIAT_CURRENCIES,
  type BtcRate,
} from "../utils/fiatRates";

interface FiatSettingsPayload {
  fiat_enabled: boolean;
  fiat_currency: string;
}

export type RateStatus = "loading" | "ready" | "error";

interface FiatContextValue {
  enabled: boolean;
  currency: string;
  rate: BtcRate | null;
  status: RateStatus;
  setEnabled: (enabled: boolean) => void;
  setCurrency: (code: string) => void;
  refreshRate: () => void;
}

const DEFAULT_CURRENCY = "USD";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const FiatContext = createContext<FiatContextValue>({
  enabled: true,
  currency: DEFAULT_CURRENCY,
  rate: null,
  status: "loading",
  setEnabled: () => {},
  setCurrency: () => {},
  refreshRate: () => {},
});

export function useFiat() {
  return useContext(FiatContext);
}

function isSupported(code: string): boolean {
  return SUPPORTED_FIAT_CURRENCIES.some((c) => c.code === code);
}

export function FiatProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(true);
  const [currency, setCurrencyState] = useState<string>(DEFAULT_CURRENCY);
  const [rate, setRate] = useState<BtcRate | null>(null);
  const [status, setStatus] = useState<RateStatus>("loading");

  // Track the currency whose rate we're currently fetching so concurrent
  // switches (user taps A then B quickly) don't race and clobber each other.
  const inFlightCurrencyRef = useRef<string | null>(null);

  const loadRate = useCallback(
    async (code: string, options?: { silent?: boolean }) => {
      inFlightCurrencyRef.current = code;
      if (!options?.silent) setStatus("loading");
      const next = await fetchBtcRate(code);
      if (inFlightCurrencyRef.current !== code) return;
      if (next) {
        setRate(next);
        setStatus("ready");
      } else {
        setStatus("error");
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    invoke<FiatSettingsPayload>("settings")
      .then((s) => {
        if (cancelled) return;
        setEnabledState(s.fiat_enabled);
        const code = isSupported(s.fiat_currency) ? s.fiat_currency : DEFAULT_CURRENCY;
        setCurrencyState(code);
        if (s.fiat_enabled) {
          void loadRate(code);
        }
      })
      .catch(() => {
        if (cancelled) return;
        void loadRate(DEFAULT_CURRENCY);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRate]);

  // Periodic background refresh.
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      void loadRate(currency, { silent: true });
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, currency, loadRate]);

  const setEnabled = useCallback(
    (next: boolean) => {
      setEnabledState(next);
      invoke("set_fiat_enabled", { enabled: next }).catch((e) => {
        console.warn("set_fiat_enabled failed:", e);
        toast.error("Couldn't save fiat setting");
      });
      if (next && !rate) {
        void loadRate(currency);
      }
    },
    [currency, rate, loadRate],
  );

  const setCurrency = useCallback(
    (code: string) => {
      if (!isSupported(code) || code === currency) return;
      setCurrencyState(code);
      setRate(null);
      invoke("set_fiat_currency", { currency: code }).catch((e) => {
        console.warn("set_fiat_currency failed:", e);
        toast.error("Couldn't save currency preference");
      });
      void loadRate(code);
    },
    [currency, loadRate],
  );

  const refreshRate = useCallback(() => {
    void loadRate(currency);
  }, [currency, loadRate]);

  const value = useMemo<FiatContextValue>(
    () => ({ enabled, currency, rate, status, setEnabled, setCurrency, refreshRate }),
    [enabled, currency, rate, status, setEnabled, setCurrency, refreshRate],
  );

  return <FiatContext.Provider value={value}>{children}</FiatContext.Provider>;
}

export function useSatsToFiat(sats: number): string | null {
  const { enabled, currency, rate } = useFiat();
  if (!enabled || !rate) return null;
  return formatFiat(sats, rate.rate, currency);
}
