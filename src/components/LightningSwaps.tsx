import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { SwapRecord } from '../context/WalletContext';
import { formatSats, formatDate } from '../utils/format';

interface LightningSwapsProps {
  swaps: SwapRecord[];
  onClaimed: () => void;
}

export function LightningSwaps({ swaps, onClaimed }: LightningSwapsProps) {
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const sortedSwaps = useMemo(
    () => [...swaps].sort((a, b) => b.created_at - a.created_at),
    [swaps],
  );

  if (swaps.length === 0) return null;

  return (
    <div className="px-6 mb-6">
      <h2 className="text-sm font-semibold theme-text-muted mb-3">
        Lightning Swaps
      </h2>
      <div className="space-y-2">
        {sortedSwaps.map((swap) => {
          const isClaimable = swap.has_preimage && !swap.is_terminal;
          const isClaiming = claimingId === swap.id;
          return (
            <div key={swap.id} className="rounded-xl theme-card px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium tabular-nums">
                    {formatSats(swap.amount_sat)}{' '}
                    <span className="text-[10px] theme-text-faint">sats</span>
                  </p>
                  <p className="text-xs theme-text-muted mt-0.5">
                    {formatDate(swap.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      swap.is_successful_terminal
                        ? 'theme-accent-bg'
                        : swap.is_terminal
                        ? 'theme-danger-bg theme-danger'
                        : 'theme-warning-bg theme-warning'
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
                          onClaimed();
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
              <p className="text-[10px] theme-text-faint mt-1 font-mono">
                {swap.id}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
