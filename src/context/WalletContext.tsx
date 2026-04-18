import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import type { VtxoInfo } from "../components/VtxoCard";

export type ConnectionState =
  | "checking"
  | "connecting"
  | "loading"
  | "connected"
  | "error";

export interface WalletBalance {
  onchain_confirmed_sat: number;
  onchain_pending_sat: number;
  offchain_confirmed_sat: number;
  offchain_pre_confirmed_sat: number;
  offchain_recoverable_sat: number;
  offchain_total_sat: number;
  boarding_sat: number;
}

export interface TransactionRecord {
  txid: string;
  kind: "boarding" | "commitment" | "ark" | "offboard";
  amount_sat: number;
  created_at: number | null;
  is_settled: boolean | null;
}

export interface SwapRecord {
  id: string;
  status: string;
  amount_sat: number;
  has_preimage: boolean;
  created_at: number;
  is_terminal: boolean;
  is_successful_terminal: boolean;
}

const DEFAULT_REFRESH_INTERVAL = 30_000;
// VTXOs are expensive-ish to fetch — keep the cache fresh for this long
// before a passive mount-time call actually hits the backend. Explicit
// refreshes (the refresh button, post-renew invalidation) bypass this.
const VTXOS_STALE_TIME_MS = 30_000;

interface WalletContextValue {
  connectionState: ConnectionState;
  connectionError: string | null;
  balance: WalletBalance | null;
  transactions: TransactionRecord[];
  swaps: SwapRecord[];
  refreshing: boolean;
  autoRefresh: boolean;
  setAutoRefresh: (v: boolean | ((prev: boolean) => boolean)) => void;
  fetchData: () => Promise<void>;
  connectWallet: () => void;
  vtxos: VtxoInfo[];
  vtxosLoaded: boolean;
  refreshingVtxos: boolean;
  /**
   * Fetch the VTXO list. Passive calls (no arg) skip the fetch when the
   * cache is still fresh (< VTXOS_STALE_TIME_MS). Pass `true` to force a
   * refetch — use after mutations like renew/recover.
   */
  fetchVtxos: (force?: boolean) => Promise<void>;
}

const WalletContext = createContext<WalletContextValue>(null!);

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("checking");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [swaps, setSwaps] = useState<SwapRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [vtxos, setVtxos] = useState<VtxoInfo[]>([]);
  const [vtxosLoaded, setVtxosLoaded] = useState(false);
  const [refreshingVtxos, setRefreshingVtxos] = useState(false);
  const lastVtxosFetchRef = useRef(0);
  const cancelledRef = useRef(false);
  const fetchIdRef = useRef(0);

  const fetchData = useCallback(
    async (initial?: boolean) => {
      const id = ++fetchIdRef.current;
      setRefreshing(true);
      try {
        const [balResult, txsResult, swapsResult] = await Promise.allSettled([
          invoke<WalletBalance>("get_balance"),
          invoke<TransactionRecord[]>("get_transactions"),
          invoke<SwapRecord[]>("debug_list_swaps"),
        ]);
        if (cancelledRef.current || id !== fetchIdRef.current) return;

        if (balResult.status === "fulfilled") {
          setBalance(balResult.value);
        } else if (!initial) {
          toast.error("Failed to fetch balance");
        }

        if (txsResult.status === "fulfilled") {
          setTransactions(txsResult.value);
        } else if (!initial) {
          toast.error("Failed to fetch transactions");
        }

        setSwaps(
          swapsResult.status === "fulfilled" ? swapsResult.value : [],
        );

        if (initial) {
          // Only block initial load if balance fails — that's the critical data.
          // Transactions and swaps failing is non-fatal.
          if (balResult.status === "rejected") {
            const message =
              typeof balResult.reason === "string"
                ? balResult.reason
                : "Failed to fetch wallet data";
            setConnectionError(message);
            setConnectionState("error");
          } else {
            setConnectionState("connected");
          }
        }
      } catch (error) {
        if (cancelledRef.current || id !== fetchIdRef.current) return;
        const message =
          typeof error === "string" ? error : "Failed to fetch wallet data";
        if (initial) {
          setConnectionError(message);
          setConnectionState("error");
        } else {
          toast.error(message);
        }
      } finally {
        if (!cancelledRef.current && id === fetchIdRef.current) {
          setRefreshing(false);
        }
      }
    },
    [],
  );

  const fetchVtxos = useCallback(async (force = false) => {
    if (!force) {
      const age = Date.now() - lastVtxosFetchRef.current;
      if (lastVtxosFetchRef.current > 0 && age < VTXOS_STALE_TIME_MS) return;
    }
    setRefreshingVtxos(true);
    try {
      const res = await invoke<{ vtxos: VtxoInfo[] }>("get_vtxos");
      if (cancelledRef.current) return;
      setVtxos(res.vtxos);
      setVtxosLoaded(true);
      lastVtxosFetchRef.current = Date.now();
    } catch (e) {
      if (cancelledRef.current) return;
      toast.error(typeof e === "string" ? e : "Failed to fetch VTXOs");
    } finally {
      if (!cancelledRef.current) setRefreshingVtxos(false);
    }
  }, []);

  const connectWallet = useCallback(() => {
    cancelledRef.current = false;
    setConnectionState("checking");
    setConnectionError(null);

    invoke<boolean>("is_wallet_loaded")
      .then((loaded) => {
        if (cancelledRef.current) return;

        if (loaded) {
          setConnectionState("loading");
          void fetchData(true);
          return;
        }

        setConnectionState("connecting");

        invoke("connect_wallet")
          .then(() => {
            if (!cancelledRef.current) {
              setConnectionState("loading");
              void fetchData(true);
            }
          })
          .catch((error) => {
            if (cancelledRef.current) return;
            const message =
              typeof error === "string" ? error : "Failed to connect to ASP";
            setConnectionError(message);
            setConnectionState("error");
          });
      })
      .catch((error) => {
        if (cancelledRef.current) return;
        const message =
          typeof error === "string"
            ? error
            : "Failed to read wallet connection state";
        setConnectionError(message);
        setConnectionState("error");
      });
  }, [fetchData]);

  // Register the sync-error listener before starting the connection
  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<string>("wallet-sync-error", (event) => {
      toast.warning(event.payload);
    }).then((unlisten) => {
      if (!cancelled) connectWallet();
      return unlisten;
    });
    return () => {
      cancelled = true;
      cancelledRef.current = true;
      void unlistenPromise.then((f) => f());
    };
  }, [connectWallet]);

  // Listen for Lightning payment received and swap error events
  useEffect(() => {
    const unlisteners = [
      listen<{ amount_sat: number }>("payment-received", (event) => {
        toast.success(
          `Received ${event.payload.amount_sat.toLocaleString()} sats`,
        );
        setTimeout(() => void fetchData(), 1500);
      }),
      listen<string>("ln-swap-error", (event) => {
        toast.error(event.payload);
      }),
      listen<string>("ln-swap-progress", (event) => {
        toast.info(event.payload, { duration: 3000 });
      }),
    ];
    return () => {
      for (const p of unlisteners) void p.then((f) => f());
    };
  }, [fetchData]);

  // Auto-refresh: schedule next poll only after current fetch completes,
  useEffect(() => {
    if (!autoRefresh || connectionState !== "connected") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        fetchData().finally(() => {
          if (!cancelled) poll();
        });
      }, DEFAULT_REFRESH_INTERVAL);
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [autoRefresh, connectionState, fetchData]);

  return (
    <WalletContext.Provider
      value={{
        connectionState,
        connectionError,
        balance,
        transactions,
        swaps,
        refreshing,
        autoRefresh,
        setAutoRefresh,
        fetchData: () => fetchData(),
        connectWallet,
        vtxos,
        vtxosLoaded,
        refreshingVtxos,
        fetchVtxos,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
