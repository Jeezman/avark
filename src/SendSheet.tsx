import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText as readClipboard } from '@tauri-apps/plugin-clipboard-manager';
import { toast } from 'sonner';
import { Drawer } from 'vaul';
import QrScannerView from './QrScanner';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import { useSatsToFiat } from './context/FiatContext';
import { formatSats } from './utils/format';
import { parseSatAmount } from './utils/amount';
import { triggerHaptic } from './utils/receiveFeedback';
import { AmountField } from './components/AmountField';
import { RAIL_META, DEFAULT_ACCENT, type Rail } from './components/rails';
import { RailChip } from './components/RailChip';

interface SendSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offchainBalanceSat: number;
  onSuccess: () => void;
}

type AddressType = Rail | null;
type LightningKind = 'bolt11' | 'address' | null;

interface FeeEstimate {
  fee_sat: number;
}

interface DetectAddressResult {
  address_type: AddressType;
  lightning_kind?: LightningKind;
  amount_sat?: number | null;
}

interface SendResult {
  txid: string;
  /**
   * Lightning-only. When present, the VHTLC funding tx (`txid`) is on-chain
   * but the LN settlement is still routing — treat the payment as submitted,
   * not completed. The checkout screen uses this to flip to its "routing"
   * state; SendSheet surfaces different success copy.
   */
  pendingLnSwapId?: string | null;
}

type Step = 'form' | 'confirm' | 'sending' | 'success' | 'error';

const RAIL_TAG: Record<Rail, string> = {
  ark: 'instant',
  bitcoin: 'next ASP round',
  lightning: 'instant',
};

// ── Success view ─────────────────────────────────────────────────────────────

function SentView({
  amountSats,
  addressType,
  txid,
  lnPending,
  onClose,
}: {
  amountSats: number | null;
  addressType: AddressType;
  txid: string | null;
  lnPending: boolean;
  onClose: () => void;
}) {
  const [animateIn, setAnimateIn] = useState(false);
  const rail = addressType ? RAIL_META[addressType] : null;
  const accent = rail?.accent ?? DEFAULT_ACCENT;

  useEffect(() => {
    requestAnimationFrame(() => setAnimateIn(true));
    triggerHaptic();
  }, []);

  return (
    <div className="relative flex flex-col items-center overflow-hidden py-2">
      {/* glow */}
      <div
        className="pointer-events-none absolute top-0 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full transition-opacity duration-700"
        style={{
          background: `radial-gradient(circle, ${rail?.soft ?? 'rgba(190,242,100,0.14)'} 0%, transparent 70%)`,
          opacity: animateIn ? 1 : 0,
        }}
      />

      {/* animated check with ring */}
      <div
        className="relative z-10 mb-5 mt-4 transition-all duration-500"
        style={{ transform: animateIn ? 'scale(1)' : 'scale(0.3)', opacity: animateIn ? 1 : 0 }}
      >
        {!lnPending && (
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `conic-gradient(from 0deg, ${rail?.soft ?? 'rgba(190,242,100,0.4)'}, transparent, ${rail?.soft ?? 'rgba(190,242,100,0.4)'})`,
              animation: 'spin 3s linear infinite',
              margin: '-3px',
            }}
          />
        )}
        <div className="relative rounded-full p-4" style={{ background: `${accent}1f` }}>
          {lnPending ? (
            <svg className="h-11 w-11 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke={accent} strokeWidth="3" />
              <path className="opacity-90" fill={accent} d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg
              className="h-11 w-11"
              viewBox="0 0 24 24"
              fill="none"
              stroke={accent}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                strokeDasharray: 30,
                strokeDashoffset: animateIn ? 0 : 30,
                transition: 'stroke-dashoffset 0.5s ease-out 0.3s',
              }}
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          )}
        </div>
      </div>

      <p className="relative z-10 text-xl font-bold theme-text">
        {lnPending ? 'Routing…' : 'Sent'}
      </p>
      <p
        className="font-display relative z-10 mt-1 text-3xl tabular-nums"
        style={{ color: accent }}
      >
        {amountSats != null ? formatSats(amountSats) : ''}
        <span className="ml-1.5 text-base theme-text-muted">sats</span>
      </p>
      {addressType && (
        <div className="relative z-10 mt-3">
          <RailChip rail={addressType} tag={RAIL_TAG[addressType]} />
        </div>
      )}

      {lnPending && (
        <p className="relative z-10 mt-3 max-w-[260px] text-center text-xs theme-text-faint">
          Funded but still routing — it may take a minute to settle. You can close this.
        </p>
      )}

      {txid && (
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(txid);
              toast.success('Transaction ID copied');
            } catch {
              toast.error('Failed to copy');
            }
          }}
          className="relative z-10 mt-5 flex items-center gap-2 rounded-xl theme-card px-4 py-2.5"
        >
          <span className="max-w-[200px] truncate font-mono text-xs theme-text-secondary">{txid}</span>
          <svg className="h-3.5 w-3.5 shrink-0 theme-text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        </button>
      )}

      <button
        onClick={onClose}
        className="relative z-10 mt-5 w-full rounded-2xl py-3.5 text-sm font-bold text-gray-900 transition-transform active:scale-[0.98]"
        style={{ background: 'linear-gradient(135deg, #bef264, #84cc16)' }}
      >
        Done
      </button>
    </div>
  );
}

function SendSheetContent({
  offchainBalanceSat,
  onSuccess,
  onClose,
}: {
  offchainBalanceSat: number;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [addressType, setAddressType] = useState<AddressType>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [lightningKind, setLightningKind] = useState<LightningKind>(null);
  const [detectingAddress, setDetectingAddress] = useState(false);
  const [fee, setFee] = useState<FeeEstimate | null>(null);
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('form');
  const [scanning, setScanning] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [lnPending, setLnPending] = useState(false);

  const amountSats = parseSatAmount(amountInput);
  const amountFiat = useSatsToFiat(amountSats ?? 0);
  const detectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feeAbortRef = useRef<AbortController | null>(null);

  // Fire-and-forget fee fetch. Safe to call from event handlers.
  const fetchFee = useCallback((addr: string, sats: number) => {
    if (feeAbortRef.current) feeAbortRef.current.abort();
    const controller = new AbortController();
    feeAbortRef.current = controller;

    setFeeLoading(true);
    setFeeError(null);
    setFee(null);

    invoke<FeeEstimate>('estimate_onchain_send_fee', {
      address: addr,
      amountSat: sats,
    })
      .then((result) => {
        if (!controller.signal.aborted) setFee(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          const msg = typeof err === 'string' ? err : err?.message ?? 'Fee estimate unavailable';
          setFeeError(msg);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFeeLoading(false);
      });
  }, []);

  // Reset derived state when address changes and kick off detection.
  // We capture `amountInput` from the outer closure so the detection
  // callback can trigger a fee fetch with the current amount.
  const handleAddressChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>, currentAmount: string) => {
      const val = e.target.value;
      setAddress(val);
      setAddressType(null);
      setLightningKind(null);
      setAddressError(null);
      setFee(null);
      setFeeError(null);
      setFeeLoading(false);

      if (feeAbortRef.current) feeAbortRef.current.abort();
      if (detectTimerRef.current) clearTimeout(detectTimerRef.current);

      if (!val.trim()) {
        setDetectingAddress(false);
        return;
      }

      setDetectingAddress(true);
      detectTimerRef.current = setTimeout(() => {
        invoke<DetectAddressResult>('detect_address_type', {
          address: val.trim(),
        })
          .then((result) => {
            setAddressType(result.address_type);
            setLightningKind(result.lightning_kind ?? null);
            if (result.address_type === 'lightning') {
              if (result.lightning_kind === 'bolt11') {
                if (typeof result.amount_sat === 'number' && result.amount_sat > 0) {
                  setAmountInput(String(result.amount_sat));
                  setAddressError(null);
                } else {
                  setAddressError(
                    'Amountless or sub-satoshi Lightning invoices are not supported yet',
                  );
                }
              } else {
                setAddressError(
                  'Sending to Lightning addresses is not supported yet. Scan or paste a BOLT11 invoice instead.',
                );
              }
              return;
            }
            setAddressError(null);
            // Trigger fee fetch if the detected type is bitcoin.
            if (result.address_type === 'bitcoin') {
              const sats = parseSatAmount(currentAmount);
              if (sats && sats > 0) fetchFee(val.trim(), sats);
            }
          })
          .catch((err) => {
            setAddressType(null);
            setLightningKind(null);
            setAddressError(
              typeof err === 'string' ? err : 'Invalid address',
            );
          })
          .finally(() => setDetectingAddress(false));
      }, 400);
    },
    [fetchFee],
  );

  // Clean up timers on unmount.
  useEffect(() => {
    return () => {
      if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
      if (feeAbortRef.current) feeAbortRef.current.abort();
    };
  }, []);

  const handleAmountChange = useCallback(
    (
      e: React.ChangeEvent<HTMLInputElement>,
      currentAddressType: AddressType,
      currentAddress: string,
    ) => {
      const val = e.target.value;
      if (val === '' || /^\d+$/.test(val)) {
        setAmountInput(val);
        // Re-fetch fee estimate with new amount if bitcoin address.
        if (currentAddressType === 'bitcoin' && currentAddress.trim()) {
          const sats = parseSatAmount(val);
          if (sats && sats > 0) {
            fetchFee(currentAddress.trim(), sats);
          } else {
            if (feeAbortRef.current) feeAbortRef.current.abort();
            setFee(null);
            setFeeError(null);
            setFeeLoading(false);
          }
        }
      }
    },
    [fetchFee],
  );

  // Handle scanned QR code result. Parses BIP21 URIs or plain addresses.
  const handleScan = useCallback(
    (data: string) => {
      setScanning(false);
      let addr = data.trim();
      let sats: string | null = null;

      // Parse BIP21 URI: bitcoin:<address>?amount=<btc>&ark=<ark_addr>&...
      if (addr.toLowerCase().startsWith('bitcoin:')) {
        const withoutScheme = addr.slice('bitcoin:'.length);
        const qIdx = withoutScheme.indexOf('?');
        const baseAddr = qIdx >= 0 ? withoutScheme.slice(0, qIdx) : withoutScheme;
        const params = qIdx >= 0 ? new URLSearchParams(withoutScheme.slice(qIdx + 1)) : null;

        // Prefer ark address if present.
        const arkParam = params?.get('ark');
        const lightningParam = params?.get('lightning');
        addr = arkParam ?? baseAddr;
        if (!addr && lightningParam) {
          addr = `lightning:${lightningParam}`;
        }

        // Parse amount (BIP21 amount is in BTC, convert to sats).
        const amountParam = params?.get('amount');
        if (amountParam) {
          const btc = parseFloat(amountParam);
          if (!isNaN(btc) && btc > 0) {
            sats = String(Math.round(btc * 100_000_000));
          }
        }
      }

      // Set address — trigger detection via the same path as typing.
      setAddress(addr);
      setAddressType(null);
      setLightningKind(null);
      setAddressError(null);
      setFee(null);
      setFeeError(null);
      setFeeLoading(false);
      if (sats) setAmountInput(sats);

      // Detect address type.
      setDetectingAddress(true);
      invoke<DetectAddressResult>('detect_address_type', {
        address: addr,
      })
        .then((result) => {
          setAddressType(result.address_type);
          setLightningKind(result.lightning_kind ?? null);
          if (result.address_type === 'lightning') {
            if (result.lightning_kind === 'bolt11') {
              if (typeof result.amount_sat === 'number' && result.amount_sat > 0) {
                setAmountInput(String(result.amount_sat));
                setAddressError(null);
              } else {
                setAddressError(
                  'Amountless or sub-satoshi Lightning invoices are not supported yet',
                );
              }
            } else {
              setAddressError(
                'Sending to Lightning addresses is not supported yet. Scan or paste a BOLT11 invoice instead.',
              );
            }
            return;
          }
          setAddressError(null);
          const amtSats = sats ? Number(sats) : amountSats;
          if (result.address_type === 'bitcoin' && amtSats && amtSats > 0) {
            fetchFee(addr, amtSats);
          }
        })
        .catch((err) => {
          setAddressType(null);
          setLightningKind(null);
          setAddressError(typeof err === 'string' ? err : 'Invalid address');
        })
        .finally(() => setDetectingAddress(false));
    },
    [amountSats, fetchFee],
  );

  // An on-chain offboard takes its fee from change, not the sent amount, so the
  // spendable max is balance − fee (the ASP charges a flat, amount-independent
  // per-output fee)
  const bitcoinFeeSat = addressType === 'bitcoin' && fee ? Math.max(0, fee.fee_sat) : 0;
  const spendableSat = Math.max(0, offchainBalanceSat - bitcoinFeeSat);
  const insufficient = amountSats !== null && amountSats > spendableSat;
  const lnLocked = addressType === 'lightning' && lightningKind === 'bolt11';
  const hasAmount = amountSats !== null && amountSats > 0;

  const canProceed =
    addressType !== null &&
    !addressError &&
    !detectingAddress &&
    amountSats !== null &&
    amountSats > 0 &&
    amountSats <= spendableSat &&
    // On-chain needs the fee estimate loaded to verify amount + fee fits.
    (addressType !== 'bitcoin' || (fee !== null && !feeLoading));

  const reviewLabel = !address.trim()
    ? 'Enter a recipient'
    : detectingAddress
      ? 'Checking address…'
      : addressError || !addressType
        ? 'Unsupported recipient'
        : !hasAmount
          ? 'Enter an amount'
          : insufficient
            ? 'Insufficient balance'
            : 'Review payment';

  const handleReview = useCallback(() => {
    if (!canProceed) return;
    setStep('confirm');
  }, [canProceed]);

  const handleConfirm = useCallback(async () => {
    if (!amountSats || !addressType) return;
    setStep('sending');
    setSendError(null);

    try {
      let result: SendResult;
      if (addressType === 'ark') {
        result = await invoke<SendResult>('send_ark', {
          address: address.trim(),
          amountSat: amountSats,
        });
      } else if (addressType === 'lightning') {
        result = await invoke<SendResult>('send_lightning', {
          invoice: address.trim(),
        });
      } else {
        result = await invoke<SendResult>('send_onchain', {
          address: address.trim(),
          amountSat: amountSats,
        });
      }
      setTxid(result.txid);
      setLnPending(Boolean(result.pendingLnSwapId));
      setStep('success');
      onSuccess();
    } catch (err) {
      setSendError(typeof err === 'string' ? err : 'Transaction failed');
      setStep('error');
    }
  }, [address, amountSats, addressType, onSuccess]);

  const handlePaste = useCallback(async () => {
    let text = '';
    try {
      text = (await readClipboard()) ?? '';
    } catch {
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast.error("Couldn't read clipboard — paste into the field instead");
        return;
      }
    }
    text = text.trim();
    if (!text) {
      toast.error('Clipboard is empty');
      return;
    }
    handleScan(text);
  }, [handleScan]);

  const handleBack = useCallback(() => {
    setStep('form');
    setSendError(null);
  }, []);

  const rail = addressType ? RAIL_META[addressType] : null;
  const accent = rail?.accent ?? DEFAULT_ACCENT;

  // ── Form step ────────────────────────────────────────────────
  if (step === 'form') {
    if (scanning) {
      return <QrScannerView onScan={handleScan} onClose={() => setScanning(false)} />;
    }

    return (
      <div className="flex flex-col gap-5">
        {/* Recipient */}
        <div>
          <label className="mb-1.5 block px-1 text-[11px] font-semibold uppercase tracking-[0.14em] theme-text-muted">
            Recipient
          </label>
          {/* Full-width input with Scan + Paste inset on the right */}
          <div className="relative">
            <input
              type="text"
              placeholder="Ark, Bitcoin, or BOLT11 invoice"
              value={address}
              onChange={(e) => handleAddressChange(e, amountInput)}
              className="w-full rounded-2xl theme-card py-3 pl-4 pr-[92px] font-mono text-sm theme-text outline-none transition-shadow placeholder:opacity-20 focus:ring-1"
              style={{
                // @ts-expect-error CSS custom prop for the focus ring colour
                '--tw-ring-color': `${accent}66`,
              }}
            />
            <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5">
              <span className="mr-1 h-5 w-px" style={{ background: 'rgba(255,255,255,0.08)' }} />
              <button
                onClick={() => setScanning(true)}
                className="grid h-9 w-9 place-items-center rounded-xl theme-text-muted transition-colors active:opacity-60"
                aria-label="Scan QR code"
                title="Scan QR code"
              >
                <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7V5a2 2 0 012-2h2" />
                  <path d="M17 3h2a2 2 0 012 2v2" />
                  <path d="M21 17v2a2 2 0 01-2 2h-2" />
                  <path d="M7 21H5a2 2 0 01-2-2v-2" />
                  <rect x="7" y="7" width="10" height="10" rx="1" />
                </svg>
              </button>
              <button
                onClick={() => void handlePaste()}
                className="grid h-9 w-9 place-items-center rounded-xl theme-text-muted transition-colors active:opacity-60"
                aria-label="Paste from clipboard"
                title="Paste"
              >
                <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="8" y="2" width="8" height="4" rx="1" />
                  <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
                </svg>
              </button>
            </div>
          </div>
          <div className="mt-1.5 px-1">
            {detectingAddress ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] theme-text-faint">
                <span className="h-1.5 w-1.5 rounded-full bg-current" style={{ animation: 'pulse 1.2s ease-in-out infinite' }} />
                Detecting…
              </span>
            ) : addressError ? (
              <p className="text-[11px] leading-snug theme-danger">{addressError}</p>
            ) : addressType ? (
              <RailChip rail={addressType} tag={RAIL_TAG[addressType]} />
            ) : null}
          </div>
        </div>

        {/* Amount — the hero (shared with Receive) */}
        <AmountField
          label="Amount"
          value={amountInput}
          onChange={(e) => handleAmountChange(e, addressType, address)}
          disabled={lnLocked}
          accent={accent}
          invalid={insufficient}
          footer={
            <div className="mt-2 flex items-center justify-between px-1 text-[11px] tabular-nums">
              <span className="font-semibold" style={{ color: insufficient ? '#f87171' : accent }}>
                {insufficient ? 'Insufficient balance' : hasAmount ? (amountFiat ?? '') : ''}
              </span>
              <span className="flex items-center gap-2 theme-text-faint">
                <span>Bal {formatSats(offchainBalanceSat)}</span>
                {!lnLocked && (
                  <button
                    onClick={() => {
                      // For on-chain, leave room for the fee (balance − fee);
                      // if the fee isn't loaded yet this falls back to the full
                      // balance and re-fetches, so a second tap lands the real max.
                      setAmountInput(String(spendableSat));
                      if (addressType === 'bitcoin' && address.trim() && spendableSat > 0) {
                        fetchFee(address.trim(), spendableSat);
                      }
                    }}
                    className="rounded-full px-2 py-0.5 font-semibold"
                    style={{ background: 'var(--color-bg-card)', color: accent }}
                  >
                    Max
                  </button>
                )}
              </span>
            </div>
          }
        />

        {/* Fee estimate (onchain only) */}
        {addressType === 'bitcoin' && hasAmount && (
          <div className="flex items-center justify-between rounded-2xl theme-card px-4 py-3">
            <span className="text-xs theme-text-muted">Network fee</span>
            {feeLoading ? (
              <span className="text-xs theme-text-faint">Calculating…</span>
            ) : fee ? (
              <span className="text-xs font-medium theme-text-secondary tabular-nums">
                {formatSats(fee.fee_sat)} sats
              </span>
            ) : feeError ? (
              <span className="flex items-center gap-2">
                <span className="text-xs theme-warning">{feeError}</span>
                <button
                  onClick={() => fetchFee(address.trim(), amountSats!)}
                  className="shrink-0 text-[11px] theme-accent transition-colors hover:opacity-80"
                >
                  Retry
                </button>
              </span>
            ) : null}
          </div>
        )}

        <button
          disabled={!canProceed}
          onClick={handleReview}
          className="w-full rounded-2xl py-3.5 text-sm font-bold text-gray-900 transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100"
          style={{ background: 'linear-gradient(135deg, #bef264, #84cc16)' }}
        >
          {reviewLabel}
        </button>
      </div>
    );
  }

  // ── Confirm step ─────────────────────────────────────────────
  if (step === 'confirm') {
    const total = (amountSats ?? 0) + (fee && addressType === 'bitcoin' ? fee.fee_sat : 0);
    return (
      <div className="flex flex-col">
        {/* Amount-forward header */}
        <div className="mb-5 flex flex-col items-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] theme-text-muted">
            You’re sending
          </p>
          <p className="font-display mt-1.5 text-4xl tabular-nums theme-text">
            {amountSats != null ? formatSats(amountSats) : ''}
            <span className="ml-1.5 text-lg theme-text-muted">sats</span>
          </p>
          {hasAmount && amountFiat && (
            <p className="mt-1 text-sm theme-text-muted tabular-nums">≈ {amountFiat}</p>
          )}
          {addressType && (
            <div className="mt-3">
              <RailChip rail={addressType} tag={RAIL_TAG[addressType]} />
            </div>
          )}
        </div>

        {/* Details */}
        <div className="space-y-2.5 rounded-2xl theme-card px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs theme-text-muted">To</span>
            <span className="max-w-[220px] truncate font-mono text-xs theme-text-secondary">
              {address.trim()}
            </span>
          </div>
          {fee && addressType === 'bitcoin' && (
            <>
              <div className="h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
              <div className="flex items-center justify-between">
                <span className="text-xs theme-text-muted">Network fee</span>
                <span className="text-xs theme-text-secondary tabular-nums">
                  {formatSats(fee.fee_sat)} sats
                </span>
              </div>
              <div className="h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
              <div className="flex items-center justify-between">
                <span className="text-xs theme-text-muted">Total</span>
                <span className="text-xs font-semibold theme-text tabular-nums">
                  {formatSats(total)} sats
                </span>
              </div>
            </>
          )}
        </div>

        <div className="mt-5 flex gap-3">
          <button
            onClick={handleBack}
            className="flex-1 rounded-2xl theme-card-elevated py-3.5 text-sm font-bold theme-text transition-colors hover:opacity-80"
          >
            Back
          </button>
          <button
            onClick={() => void handleConfirm()}
            className="flex-1 rounded-2xl py-3.5 text-sm font-bold text-gray-900 transition-transform active:scale-[0.98]"
            style={{ background: 'linear-gradient(135deg, #bef264, #84cc16)' }}
          >
            Confirm &amp; send
          </button>
        </div>
      </div>
    );
  }

  // ── Sending step ─────────────────────────────────────────────
  if (step === 'sending') {
    return (
      <div className="flex flex-col items-center py-12">
        <div className="relative h-16 w-16">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: `conic-gradient(from 0deg, ${accent}, transparent 65%)`,
              animation: 'spin 1s linear infinite',
            }}
          />
          <div className="absolute inset-[3px] grid place-items-center rounded-full theme-drawer">
            <span className="h-2 w-2 rounded-full" style={{ background: accent }} />
          </div>
        </div>
        <p className="mt-5 text-sm theme-text-secondary">
          {addressType === 'ark'
            ? 'Sending instantly…'
            : addressType === 'bitcoin'
              ? 'Submitting offboard…'
              : 'Paying Lightning invoice…'}
        </p>
      </div>
    );
  }

  // ── Success step ─────────────────────────────────────────────
  if (step === 'success') {
    return (
      <SentView
        amountSats={amountSats}
        addressType={addressType}
        txid={txid}
        lnPending={lnPending}
        onClose={onClose}
      />
    );
  }

  // ── Error step ───────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center py-6">
      <div className="mb-4 rounded-full theme-danger-bg p-4">
        <svg className="h-8 w-8 theme-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      </div>
      <p className="mb-1 text-lg font-bold theme-text">Couldn’t send</p>
      <p className="mb-5 px-4 text-center text-sm theme-danger">{sendError}</p>
      <div className="flex w-full gap-3">
        <button
          onClick={handleBack}
          className="flex-1 rounded-2xl theme-card-elevated py-3.5 text-sm font-bold theme-text transition-colors hover:opacity-80"
        >
          Edit
        </button>
        <button
          onClick={() => void handleConfirm()}
          className="flex-1 rounded-2xl py-3.5 text-sm font-bold text-gray-900 transition-transform active:scale-[0.98]"
          style={{ background: 'linear-gradient(135deg, #bef264, #84cc16)' }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function SendSheet({
  open,
  onOpenChange,
  offchainBalanceSat,
  onSuccess,
}: SendSheetProps) {
  const kbInset = useKeyboardInset();
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl theme-drawer px-6 pt-5 pb-8 outline-none"
          style={{
            height: 'calc(var(--app-height) * 0.72)',
            maxHeight: kbInset > 0 ? `calc(100dvh - ${kbInset}px - 16px)` : undefined,
            bottom: kbInset,
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
          }}
        >
          <Drawer.Handle className="mx-auto mb-4 h-1 w-10 rounded-full theme-drawer-handle" />

          <Drawer.Title className="font-display text-center text-[22px] tracking-wide theme-text">
            Send
          </Drawer.Title>
          <Drawer.Description className="mb-5 mt-0.5 text-center text-xs theme-text-muted">
            To an Ark, Bitcoin, or Lightning destination
          </Drawer.Description>

          <div className="overflow-y-auto">
            {open && (
              <SendSheetContent
                offchainBalanceSat={offchainBalanceSat}
                onSuccess={onSuccess}
                onClose={() => onOpenChange(false)}
              />
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export default SendSheet;
