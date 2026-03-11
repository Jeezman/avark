import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import ReceiveSheet from '../ReceiveSheet';

type ConnectionState =
  | 'checking'
  | 'connecting'
  | 'loading'
  | 'connected'
  | 'error';

interface SwapRecord {
  id: string;
  status: string;
  amount_sat: number;
  has_preimage: boolean;
  created_at: number;
  is_terminal: boolean;
  is_successful_terminal: boolean;
}

interface SettleResult {
  settled: boolean;
  txid: string | null;
}

interface WalletBalance {
  onchain_confirmed_sat: number;
  onchain_pending_sat: number;
  offchain_confirmed_sat: number;
  offchain_pre_confirmed_sat: number;
  offchain_recoverable_sat: number;
  offchain_total_sat: number;
}

interface TransactionRecord {
  txid: string;
  kind: 'boarding' | 'commitment' | 'ark' | 'offboard';
  amount_sat: number;
  created_at: number | null;
  is_settled: boolean | null;
}

const DEFAULT_REFRESH_INTERVAL = 30_000;

function formatSats(sats: number): string {
  return sats.toLocaleString();
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return 'Pending';
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function txKindLabel(kind: string): string {
  switch (kind) {
    case 'boarding':
      return 'Boarding';
    case 'commitment':
      return 'Round';
    case 'ark':
      return 'Ark Transfer';
    case 'offboard':
      return 'Offboard';
    default:
      return kind;
  }
}

export function DashboardRoute() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('checking');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [swaps, setSwaps] = useState<SwapRecord[]>([]);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;
  const fetchRef = useRef<(initial?: boolean) => Promise<void>>(null!);
  const fetchIdRef = useRef(0);

  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!autoRefreshRef.current || cancelledRef.current) return;
    timerRef.current = setTimeout(() => {
      void fetchRef.current?.();
    }, DEFAULT_REFRESH_INTERVAL);
  }, []);

  const fetchData = useCallback(
    async (initial?: boolean) => {
      const id = ++fetchIdRef.current;
      setRefreshing(true);
      try {
        const [bal, txs, swapRecords] = await Promise.all([
          invoke<WalletBalance>('get_balance'),
          invoke<TransactionRecord[]>('get_transactions'),
          invoke<SwapRecord[]>('debug_list_swaps').catch(
            () => [] as SwapRecord[],
          ),
        ]);
        if (cancelledRef.current || id !== fetchIdRef.current) return;
        setBalance(bal);
        setTransactions(txs);
        setSwaps(swapRecords);
        if (initial) setConnectionState('connected');
      } catch (error) {
        if (cancelledRef.current || id !== fetchIdRef.current) return;
        const message =
          typeof error === 'string' ? error : 'Failed to fetch wallet data';
        if (initial) {
          setConnectionError(message);
          setConnectionState('error');
        } else {
          toast.error(message);
        }
      } finally {
        if (!cancelledRef.current && id === fetchIdRef.current) {
          setRefreshing(false);
          scheduleNext();
        }
      }
    },
    [scheduleNext],
  );
  useLayoutEffect(() => {
    fetchRef.current = fetchData;
  }, [fetchData]);

  const connectWallet = useCallback(() => {
    cancelledRef.current = false;
    setConnectionState('checking');
    setConnectionError(null);

    invoke<boolean>('is_wallet_loaded')
      .then((loaded) => {
        if (cancelledRef.current) return;

        if (loaded) {
          setConnectionState('loading');
          void fetchData(true);
          return;
        }

        setConnectionState('connecting');

        invoke('connect_wallet')
          .then(() => {
            if (!cancelledRef.current) {
              setConnectionState('loading');
              void fetchData(true);
            }
          })
          .catch((error) => {
            if (cancelledRef.current) return;
            const message =
              typeof error === 'string' ? error : 'Failed to connect to ASP';
            setConnectionError(message);
            setConnectionState('error');
          });
      })
      .catch((error) => {
        if (cancelledRef.current) return;
        const message =
          typeof error === 'string'
            ? error
            : 'Failed to read wallet connection state';
        setConnectionError(message);
        setConnectionState('error');
      });
  }, [fetchData]);

  // Register the sync-error listener before starting the connection so we
  // never miss an event emitted during the initial onchain sync.
  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<string>('wallet-sync-error', (event) => {
      toast.warning(event.payload);
    }).then((unlisten) => {
      // Only start the connection once the listener is confirmed registered.
      if (!cancelled) connectWallet();
      return unlisten;
    });
    return () => {
      cancelled = true;
      cancelledRef.current = true;
      void unlistenPromise.then((f) => f());
    };
  }, [connectWallet]);

  // Listen for Lightning payment received and swap error events.
  useEffect(() => {
    const unlisteners = [
      listen<{ amount_sat: number }>('payment-received', (event) => {
        toast.success(
          `Received ${event.payload.amount_sat.toLocaleString()} sats via Lightning`,
        );
        void fetchData();
      }),
      listen<string>('ln-swap-error', (event) => {
        toast.error(event.payload);
      }),
      listen<string>('ln-swap-progress', (event) => {
        toast.info(event.payload, { duration: 3000 });
      }),
    ];
    return () => {
      for (const p of unlisteners) void p.then((f) => f());
    };
  }, [fetchData]);

  // Auto-refresh: schedule or cancel based on toggle / connection state
  useEffect(() => {
    if (autoRefresh && connectionState === 'connected') {
      scheduleNext();
    } else {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [autoRefresh, connectionState, scheduleNext]);

  if (connectionState !== 'connected') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 p-8 text-white">
        {connectionState === 'error' ? (
          <>
            <div className="mb-4 rounded-full bg-red-500/10 p-4">
              <svg
                className="h-8 w-8 text-red-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <p className="mb-2 text-lg font-semibold">Connection Failed</p>
            <p className="mb-4 text-sm text-white/60">{connectionError}</p>
            <button
              className="rounded-xl bg-lime-300 px-6 py-2.5 text-sm font-bold text-gray-900 active:scale-95 transition-transform"
              onClick={connectWallet}
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <svg
              className="mb-4 h-8 w-8 animate-spin text-lime-300"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <p className="text-sm text-white/60">
              {connectionState === 'checking' && 'Checking wallet...'}
              {connectionState === 'connecting' && 'Connecting to ASP...'}
              {connectionState === 'loading' && 'Loading wallet data...'}
            </p>
          </>
        )}
      </main>
    );
  }

  const totalSat =
    (balance?.onchain_confirmed_sat ?? 0) + (balance?.offchain_total_sat ?? 0);

  return (
    <main
      className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 text-white"
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-4 pb-2">
        <h1 className="text-lg font-bold">Avark</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              autoRefresh
                ? 'bg-lime-300/20 text-lime-300'
                : 'bg-white/10 text-white/40'
            }`}
            title={autoRefresh ? 'Auto-refresh ON (30s)' : 'Auto-refresh OFF'}
          >
            {autoRefresh ? 'Auto' : 'Paused'}
          </button>
          <button
            onClick={() => void fetchData()}
            disabled={refreshing}
            className="rounded-full bg-white/10 p-2 text-white/70 hover:bg-white/15 transition-colors disabled:opacity-40"
            title="Refresh now"
          >
            <svg
              className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
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
      </div>

      <div className="px-6 pt-4 pb-4 text-center">
        <p className="text-sm text-white/50 mb-1">Total Balance</p>
        <p className="text-4xl font-bold tabular-nums">
          {formatSats(totalSat)}{' '}
          <span className="text-lg text-white/50">sats</span>
        </p>
      </div>

      <div className="flex justify-center gap-3 px-6 pb-6">
        <button
          onClick={() => setReceiveOpen(true)}
          className="flex items-center gap-2 rounded-2xl bg-lime-300 px-6 py-2.5 text-sm font-bold text-gray-900 active:scale-95 transition-transform"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          Receive
        </button>
        <button
          disabled={settling}
          onClick={async () => {
            setSettling(true);
            try {
              const result = await invoke<SettleResult>('settle');
              if (result.settled) {
                toast.success(`Settled into round (txid: ${result.txid})`);
                void fetchData();
              } else {
                toast.info(
                  'Nothing to settle — no spendable boarding UTXOs or VTXOs found',
                );
              }
            } catch (e) {
              toast.error(String(e));
            } finally {
              setSettling(false);
            }
          }}
          className="flex items-center gap-2 rounded-2xl bg-white/10 px-6 py-2.5 text-sm font-bold text-white hover:bg-white/15 active:scale-95 transition-all disabled:opacity-50"
        >
          <svg
            className={`h-4 w-4 ${settling ? 'animate-spin' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
          {settling ? 'Settling...' : 'Settle'}
        </button>
      </div>

      {/* Balance Breakdown */}
      <div className="mx-6 grid grid-cols-2 gap-3 mb-6">
        <div className="rounded-2xl bg-white/5 p-4">
          <p className="text-xs text-white/40 mb-1">Onchain</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatSats(balance?.onchain_confirmed_sat ?? 0)}
          </p>
          {(balance?.onchain_pending_sat ?? 0) > 0 && (
            <p className="text-xs text-yellow-300/70 mt-0.5">
              +{formatSats(balance!.onchain_pending_sat)} pending
            </p>
          )}
        </div>
        <div className="rounded-2xl bg-white/5 p-4">
          <p className="text-xs text-white/40 mb-1">Offchain (Ark)</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatSats(balance?.offchain_total_sat ?? 0)}
          </p>
          {(balance?.offchain_pre_confirmed_sat ?? 0) > 0 && (
            <p className="text-xs text-yellow-300/70 mt-0.5">
              {formatSats(balance!.offchain_pre_confirmed_sat)} pre-confirmed
            </p>
          )}
        </div>
      </div>

      {/* Lightning Swaps */}
      {swaps.length > 0 && (
        <div className="px-6 mb-6">
          <h2 className="text-sm font-semibold text-white/50 mb-3">
            Lightning Swaps
          </h2>
          <div className="space-y-2">
            {swaps.map((swap) => {
              const isClaimable = swap.has_preimage && !swap.is_terminal;
              const isClaiming = claimingId === swap.id;
              return (
                <div key={swap.id} className="rounded-xl bg-white/5 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium tabular-nums">
                        {formatSats(swap.amount_sat)}{' '}
                        <span className="text-[10px] text-white/30">sats</span>
                      </p>
                      <p className="text-xs text-white/40 mt-0.5">
                        {formatDate(swap.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          swap.is_successful_terminal
                            ? 'bg-lime-300/20 text-lime-300'
                            : swap.is_terminal
                            ? 'bg-red-300/20 text-red-300'
                            : 'bg-yellow-300/20 text-yellow-300'
                        }`}
                      >
                        {swap.status
                          .replace('transaction.', '')
                          .replace('swap.', '')
                          .replace('invoice.', '')}
                      </span>
                      {isClaimable && (
                        <button
                          disabled={isClaiming}
                          onClick={async () => {
                            setClaimingId(swap.id);
                            try {
                              const result = await invoke<string>(
                                'debug_claim_swap',
                                { swapId: swap.id },
                              );
                              toast.success(result);
                              void fetchData();
                            } catch (e) {
                              toast.error(String(e));
                            } finally {
                              setClaimingId(null);
                            }
                          }}
                          className="rounded-lg bg-lime-300 px-3 py-1 text-xs font-bold text-gray-900 active:scale-95 transition-transform disabled:opacity-50"
                        >
                          {isClaiming ? 'Claiming...' : 'Claim'}
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-[10px] text-white/20 mt-1 font-mono">
                    {swap.id}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Transactions */}
      <div className="px-6">
        <h2 className="text-sm font-semibold text-white/50 mb-3">
          Recent Transactions
        </h2>
        {transactions.length === 0 ? (
          <div className="rounded-2xl bg-white/5 p-8 text-center">
            <p className="text-white/40 text-sm">No transactions yet</p>
          </div>
        ) : (
          <div
            className="space-y-2"
            style={{
              paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
            }}
          >
            {transactions.map((tx, i) => (
              <div
                key={`${tx.txid}-${tx.kind}-${i}`}
                className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {txKindLabel(tx.kind)}
                    </span>
                    {tx.is_settled === false && (
                      <span className="rounded-full bg-yellow-300/20 px-2 py-0.5 text-[10px] font-medium text-yellow-300">
                        Pending
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/40 mt-0.5">
                    {formatDate(tx.created_at)}
                  </p>
                </div>
                <p
                  className={`text-sm font-semibold tabular-nums ${
                    tx.amount_sat >= 0 ? 'text-lime-300' : 'text-red-300'
                  }`}
                >
                  {tx.amount_sat >= 0 ? '+' : ''}
                  {formatSats(tx.amount_sat)}{' '}
                  <span className="text-[10px] text-white/30">sats</span>
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
      <ReceiveSheet open={receiveOpen} onOpenChange={setReceiveOpen} />
    </main>
  );
}
