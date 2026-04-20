import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Drawer } from 'vaul';
import QrScannerView from './QrScanner';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import { useSatsToFiat } from './context/FiatContext';
import { formatSats } from './utils/format';

interface SendSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offchainBalanceSat: number;
  onSuccess: () => void;
}

type AddressType = 'ark' | 'bitcoin' | 'lightning' | null;
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
}

type Step = 'form' | 'confirm' | 'sending' | 'success' | 'error';

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

  const amountSats = /^\d+$/.test(amountInput) ? Number(amountInput) : null;
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
              const sats = /^\d+$/.test(currentAmount)
                ? Number(currentAmount)
                : null;
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
          const sats = /^\d+$/.test(val) ? Number(val) : null;
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

  const canProceed =
    addressType !== null &&
    !addressError &&
    !detectingAddress &&
    amountSats !== null &&
    amountSats > 0 &&
    amountSats <= offchainBalanceSat;

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
      setStep('success');
      onSuccess();
    } catch (err) {
      setSendError(typeof err === 'string' ? err : 'Transaction failed');
      setStep('error');
    }
  }, [address, amountSats, addressType, onSuccess]);

  const handleBack = useCallback(() => {
    setStep('form');
    setSendError(null);
  }, []);

  // ── Form step ────────────────────────────────────────────────
  if (step === 'form') {
    if (scanning) {
      return (
        <QrScannerView
          onScan={handleScan}
          onClose={() => setScanning(false)}
        />
      );
    }

    return (
      <div className="flex flex-col gap-4">
        {/* Address input */}
        <div>
          <label className="block text-xs theme-text-muted mb-1.5">
            Recipient address
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Ark, Bitcoin, or BOLT11 invoice"
              value={address}
              onChange={(e) => handleAddressChange(e, amountInput)}
              className="flex-1 min-w-0 rounded-xl theme-card px-4 py-3 text-sm theme-text outline-none placeholder:opacity-20 font-mono"
            />
            <button
              onClick={() => setScanning(true)}
              className="shrink-0 rounded-xl theme-card px-3 py-3 theme-text-muted hover:opacity-80 transition-colors"
              title="Scan QR code"
            >
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7V5a2 2 0 012-2h2" />
                <path d="M17 3h2a2 2 0 012 2v2" />
                <path d="M21 17v2a2 2 0 01-2 2h-2" />
                <path d="M7 21H5a2 2 0 01-2-2v-2" />
                <rect x="7" y="7" width="10" height="10" rx="1" />
              </svg>
            </button>
          </div>
          {detectingAddress && (
            <p className="text-[10px] theme-text-faint mt-1">
              Detecting address type...
            </p>
          )}
          {addressError && (
            <p className="text-[10px] theme-danger mt-1">{addressError}</p>
          )}
          {addressType && !addressError && (
            <p className="text-[10px] theme-accent mt-1">
              {addressType === 'ark'
                ? 'Ark payment — instant'
                : addressType === 'bitcoin'
                  ? 'Onchain — requires ASP round'
                  : lightningKind === 'bolt11'
                    ? 'Lightning invoice'
                    : 'Lightning address unsupported'}
            </p>
          )}
        </div>

        {/* Amount input */}
        <div>
          <label className="block text-xs theme-text-muted mb-1.5">Amount</label>
          <div className="flex items-center gap-2 rounded-xl theme-card px-4 py-3">
            <input
              type="text"
              inputMode="numeric"
              placeholder="0"
              value={amountInput}
              onChange={(e) => handleAmountChange(e, addressType, address)}
              disabled={addressType === 'lightning' && lightningKind === 'bolt11'}
              className="flex-1 bg-transparent text-sm font-medium theme-text outline-none placeholder:opacity-20 tabular-nums"
            />
            <span className="text-xs theme-text-muted">sats</span>
          </div>
          <div className="flex justify-between mt-1">
            <p className="text-[10px] theme-text-faint">
              Available: {formatSats(offchainBalanceSat)} sats
            </p>
            {amountSats !== null && amountSats > offchainBalanceSat && (
              <p className="text-[10px] theme-danger">Insufficient funds</p>
            )}
          </div>
          {amountSats !== null && amountSats > 0 && amountFiat && (
            <p className="text-[10px] theme-text-muted mt-0.5 tabular-nums">
              ≈ {amountFiat}
            </p>
          )}
          <button
            onClick={() => {
              setAmountInput(String(offchainBalanceSat));
              if (addressType === 'bitcoin' && address.trim() && offchainBalanceSat > 0) {
                fetchFee(address.trim(), offchainBalanceSat);
              }
            }}
            className="text-[10px] theme-accent hover:opacity-80 mt-0.5 transition-colors"
          >
            Send max
          </button>
        </div>

        {/* Fee estimate (onchain only) */}
        {addressType === 'bitcoin' &&
          amountSats !== null &&
          amountSats > 0 && (
            <div className="rounded-xl theme-card px-4 py-2.5">
              <p className="text-[10px] theme-text-muted mb-0.5">
                Estimated fee
              </p>
              {feeLoading && (
                <p className="text-xs theme-text-faint">Calculating...</p>
              )}
              {fee && (
                <p className="text-xs theme-text-secondary">
                  {formatSats(fee.fee_sat)} sats
                </p>
              )}
              {feeError && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs theme-warning">{feeError}</p>
                  <button
                    onClick={() => fetchFee(address.trim(), amountSats!)}
                    className="shrink-0 text-[10px] theme-accent hover:opacity-80 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          )}

        <button
          disabled={!canProceed}
          onClick={handleReview}
          className="w-full rounded-xl bg-lime-300 py-3 text-sm font-bold text-gray-900 active:scale-[0.98] transition-transform disabled:opacity-30 disabled:active:scale-100"
        >
          Review
        </button>
      </div>
    );
  }

  // ── Confirm step ─────────────────────────────────────────────
  if (step === 'confirm') {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-xl theme-card px-4 py-3 space-y-2">
          <div className="flex justify-between">
            <span className="text-xs theme-text-muted">To</span>
            <span className="text-xs theme-text-secondary font-mono max-w-[200px] truncate">
              {address.trim()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs theme-text-muted">Type</span>
            <span className="text-xs theme-text-secondary">
              {addressType === 'ark'
                ? 'Ark (instant)'
                : addressType === 'bitcoin'
                  ? 'Onchain (offboard)'
                  : 'Lightning'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs theme-text-muted">Amount</span>
            <span className="text-xs theme-text font-medium">
              {amountSats != null ? formatSats(amountSats) : ''} sats
            </span>
          </div>
          {fee && addressType === 'bitcoin' && (
            <>
              <div className="flex justify-between">
                <span className="text-xs theme-text-muted">Fee</span>
                <span className="text-xs theme-text-secondary">
                  {formatSats(fee.fee_sat)} sats
                </span>
              </div>
              <div className="border-t theme-border pt-2 flex justify-between">
                <span className="text-xs theme-text-muted">Total</span>
                <span className="text-xs theme-text font-medium">
                  {formatSats((amountSats ?? 0) + fee.fee_sat)} sats
                </span>
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleBack}
            className="flex-1 rounded-xl theme-card-elevated py-3 text-sm font-bold theme-text hover:opacity-80 transition-colors"
          >
            Back
          </button>
          <button
            onClick={() => void handleConfirm()}
            className="flex-1 rounded-xl bg-lime-300 py-3 text-sm font-bold text-gray-900 active:scale-[0.98] transition-transform"
          >
            Confirm
          </button>
        </div>
      </div>
    );
  }

  // ── Sending step ─────────────────────────────────────────────
  if (step === 'sending') {
    return (
      <div className="flex flex-col items-center py-8">
        <svg
          className="h-8 w-8 animate-spin text-lime-300 mb-4"
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
        <p className="text-sm theme-text-secondary">
          {addressType === 'ark'
            ? 'Sending...'
            : addressType === 'bitcoin'
              ? 'Submitting offboard...'
              : 'Paying Lightning invoice...'}
        </p>
      </div>
    );
  }

  // ── Success step ─────────────────────────────────────────────
  if (step === 'success') {
    return (
      <div className="flex flex-col items-center py-6">
        <div className="mb-4 rounded-full bg-lime-300/10 p-4">
          <svg
            className="h-8 w-8 text-lime-300"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <p className="text-lg font-bold theme-text mb-1">Sent!</p>
        <p className="text-sm theme-text-muted mb-4">
          {amountSats != null ? formatSats(amountSats) : ''} sats{' '}
          {addressType === 'ark'
            ? 'via Ark'
            : addressType === 'bitcoin'
              ? 'onchain'
              : 'via Lightning'}
        </p>
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
            className="flex items-center gap-2 rounded-xl theme-card px-4 py-2.5 transition-colors mb-4"
          >
            <span className="font-mono text-xs theme-text-secondary max-w-[200px] truncate">
              {txid}
            </span>
            <svg
              className="h-3.5 w-3.5 shrink-0 theme-text-faint"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          </button>
        )}
        <button
          onClick={onClose}
          className="w-full rounded-xl bg-lime-300 py-3 text-sm font-bold text-gray-900 active:scale-[0.98] transition-transform"
        >
          Done
        </button>
      </div>
    );
  }

  // ── Error step ───────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center py-6">
      <div className="mb-4 rounded-full theme-danger-bg p-4">
        <svg
          className="h-8 w-8 theme-danger"
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
      <p className="text-lg font-bold theme-text mb-1">Failed</p>
      <p className="text-sm theme-danger mb-4 text-center px-4">
        {sendError}
      </p>
      <div className="flex gap-3 w-full">
        <button
          onClick={handleBack}
          className="flex-1 rounded-xl theme-card-elevated py-3 text-sm font-bold theme-text hover:opacity-80 transition-colors"
        >
          Edit
        </button>
        <button
          onClick={() => void handleConfirm()}
          className="flex-1 rounded-xl bg-lime-300 py-3 text-sm font-bold text-gray-900 active:scale-[0.98] transition-transform"
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
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl theme-drawer px-6 pt-6 pb-8 outline-none"
          style={{
            height: 'calc(var(--app-height) * 0.65)',
            maxHeight: kbInset > 0 ? `calc(100dvh - ${kbInset}px - 16px)` : undefined,
            bottom: kbInset,
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
          }}
        >
          <Drawer.Handle className="mx-auto mb-4 h-1 w-10 rounded-full theme-drawer-handle" />

          <Drawer.Title className="text-lg font-bold theme-text text-center mb-1">
            Send
          </Drawer.Title>
          <Drawer.Description className="text-xs theme-text-muted text-center mb-5">
            Send bitcoin to an Ark address, Bitcoin address, or Lightning invoice
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
