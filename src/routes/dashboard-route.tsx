import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Link } from '@tanstack/react-router';
import ReceiveSheet from '../ReceiveSheet';
import SendSheet from '../SendSheet';
import { useWallet } from '../context/WalletContext';
import { formatSats } from '../utils/format';
import { TransactionRow } from '../components/TransactionRow';

interface SettleResult {
  settled: boolean;
  txid: string | null;
}

export function DashboardRoute() {
  const {
    balance,
    transactions,
    refreshing,
    autoRefresh,
    setAutoRefresh,
    fetchData,
  } = useWallet();

  const [receiveOpen, setReceiveOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [settling, setSettling] = useState(false);

  const totalSat =
    (balance?.onchain_confirmed_sat ?? 0) +
    (balance?.onchain_pending_sat ?? 0) +
    (balance?.offchain_total_sat ?? 0);

  return (
    <main
      className="theme-text"
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
                ? 'theme-accent-bg'
                : 'theme-card-elevated theme-text-muted'
            }`}
            title={autoRefresh ? 'Auto-refresh ON (30s)' : 'Auto-refresh OFF'}
          >
            {autoRefresh ? 'Auto' : 'Paused'}
          </button>
          <button
            onClick={() => void fetchData()}
            disabled={refreshing}
            className="rounded-full theme-card-elevated p-2 theme-text-secondary hover:opacity-80 transition-colors disabled:opacity-40"
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
        <p className="text-sm theme-text-muted mb-1">Total Balance</p>
        <p className="text-4xl font-bold tabular-nums">
          {formatSats(totalSat)}{' '}
          <span className="text-lg theme-text-muted">sats</span>
        </p>
      </div>

      <div className="flex justify-center gap-3 px-6 pb-6">
        <button
          onClick={() => setSendOpen(true)}
          className="flex items-center gap-2 rounded-2xl theme-card-elevated px-6 py-2.5 text-sm font-bold theme-text hover:opacity-80 active:scale-95 transition-all"
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
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
          Send
        </button>
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
      </div>

      {/* Balance Breakdown */}
      <div className="mx-6 grid grid-cols-2 gap-3 mb-6">
        <div className="rounded-2xl theme-card p-4">
          <p className="text-xs theme-text-muted mb-1">Onchain</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatSats(balance?.onchain_confirmed_sat ?? 0)}
          </p>
          {(balance?.onchain_pending_sat ?? 0) > 0 && (
            <p className="text-xs theme-warning mt-0.5">
              +{formatSats(balance!.onchain_pending_sat)} pending
            </p>
          )}
          {(balance?.boarding_sat ?? 0) > 0 && (
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
                    toast.info('Nothing to settle');
                  }
                } catch (e) {
                  toast.error(String(e));
                } finally {
                  setSettling(false);
                }
              }}
              className="text-xs theme-accent mt-1 hover:underline disabled:opacity-50"
            >
              {settling
                ? 'Settling...'
                : `+${formatSats(balance!.boarding_sat)} boarding — Tap to settle`}
            </button>
          )}
        </div>
        <div className="rounded-2xl theme-card p-4">
          <p className="text-xs theme-text-muted mb-1">Offchain (Ark)</p>
          <p className="text-lg font-semibold tabular-nums">
            {formatSats(balance?.offchain_total_sat ?? 0)}
          </p>
          {(balance?.offchain_pre_confirmed_sat ?? 0) > 0 && (
            <p className="text-xs theme-warning mt-0.5">
              {formatSats(balance!.offchain_pre_confirmed_sat)} pre-confirmed
            </p>
          )}
        </div>
      </div>

      {/* Transactions */}
      <div className="px-6">
        <h2 className="text-sm font-semibold theme-text-muted mb-3">
          Recent Transactions
        </h2>
        {transactions.length === 0 ? (
          <div className="rounded-2xl theme-card p-8 text-center">
            <p className="theme-text-muted text-sm">No transactions yet</p>
          </div>
        ) : (
          <div className="space-y-2 pb-4">
            {transactions.slice(0, 5).map((tx, i) => (
              <TransactionRow
                key={`${tx.txid}-${tx.kind}-${i}`}
                kind={tx.kind}
                amount_sat={tx.amount_sat}
                created_at={tx.created_at}
                is_settled={tx.is_settled}
              />
            ))}
            {transactions.length > 5 && (
              <Link
                to="/transactions"
                className="block w-full rounded-xl theme-card py-3 text-center text-sm font-medium theme-accent hover:opacity-80 transition-opacity"
              >
                View all transactions
              </Link>
            )}
          </div>
        )}
      </div>

      {/* <LightningSwaps swaps={swaps} onClaimed={() => void fetchData()} /> */}

      <ReceiveSheet open={receiveOpen} onOpenChange={setReceiveOpen} onReceived={() => void fetchData()} />
      <SendSheet
        open={sendOpen}
        onOpenChange={setSendOpen}
        offchainBalanceSat={balance?.offchain_total_sat ?? 0}
        onSuccess={() => void fetchData()}
      />
    </main>
  );
}
