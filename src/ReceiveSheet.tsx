import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import QRCode from 'react-qr-code';
import { Drawer } from 'vaul';
import { useLnInvoice } from './hooks/useLnInvoice';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import { useSatsToFiat } from './context/FiatContext';
import { formatSats } from './utils/format';
import { launchConfetti } from './utils/confetti';
import { playSuccessSound, triggerHaptic } from './utils/receiveFeedback';

interface ReceiveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReceived?: () => void;
}

interface ReceiveAddresses {
  ark_address: string;
  boarding_address: string;
}

interface WalletBalance {
  boarding_sat: number;
}

type ReceiveType = 'Ark Transfer' | 'Boarding' | 'Lightning';

interface ReceivedPayment {
  amount_sat: number;
  type: ReceiveType;
  timestamp: Date;
}

/** Convert sats to BTC string using integer math (no floating point). */
function satsToBtc(sats: number): string {
  const whole = Math.floor(sats / 100_000_000);
  const frac = sats % 100_000_000;
  const fracStr = String(frac).padStart(8, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
}

/** Build a unified BIP21 URI including ark and lightning params when available. */
function buildBip21(
  btcAddress: string,
  arkAddress: string,
  amountSats: number | null,
  lnInvoice: string | null,
): string {
  const params: string[] = [];
  params.push(`ark=${arkAddress}`);
  if (lnInvoice) params.push(`lightning=${lnInvoice}`);
  if (amountSats !== null && amountSats > 0) {
    params.push(`amount=${satsToBtc(amountSats)}`);
  }
  return `bitcoin:${btcAddress}?${params.join('&')}`;
}

function truncateMiddle(str: string, headLen = 12, tailLen = 8): string {
  if (str.length <= headLen + tailLen + 3) return str;
  return `${str.slice(0, headLen)}...${str.slice(-tailLen)}`;
}

function CopyRow({
  label,
  value,
  truncated,
}: {
  label: string;
  value: string;
  truncated?: string;
}) {
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Failed to copy');
    }
  }, [label, value]);

  const handleShare = useCallback(async () => {
    // iOS WKWebView exposes navigator.share; Android WebView does not, so we
    // fall back to a Tauri command that fires an ACTION_SEND intent.
    if (navigator.share) {
      try {
        await navigator.share({ title: label, text: value });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }
    try {
      await invoke('share_text', { text: value });
    } catch {
      toast.error('Failed to share');
    }
  }, [label, value]);

  return (
    <div className="flex w-full items-center gap-2 rounded-xl theme-card px-4 py-2.5">
      <button
        onClick={handleCopy}
        className="flex flex-1 min-w-0 items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <p className="text-[10px] theme-text-muted mb-0.5">{label}</p>
          <p className="font-mono text-xs theme-text-secondary truncate">
            {truncated ?? truncateMiddle(value)}
          </p>
        </div>
        <svg
          className="h-4 w-4 shrink-0 theme-text-faint"
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
      <button
        onClick={handleShare}
        aria-label={`Share ${label}`}
        className="shrink-0 p-1 theme-text-faint hover:theme-text-muted transition-colors"
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v12" />
          <path d="M8 7l4-4 4 4" />
          <path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
        </svg>
      </button>
    </div>
  );
}

// ── Confirmation View ──────────────────────────────────────────────────

interface ConfirmationViewProps {
  payment: ReceivedPayment;
  onDone: () => void;
  onAutoClose: () => void;
}

interface SettleResult {
  settled: boolean;
  txid: string | null;
}

function ConfirmationView({ payment, onDone, onAutoClose }: ConfirmationViewProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [settling, setSettling] = useState(false);
  const [animateIn, setAnimateIn] = useState(false);
  const [displayAmount, setDisplayAmount] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackFired = useRef(false);

  // Entrance animation sequence
  useEffect(() => {
    requestAnimationFrame(() => setAnimateIn(true));
  }, []);

  // Animated amount counter
  useEffect(() => {
    if (!animateIn) return;
    const target = payment.amount_sat;
    const duration = 600;
    const start = performance.now();
    function tick(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayAmount(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [animateIn, payment.amount_sat]);

  // Launch confetti + sound + haptic on mount
  useEffect(() => {
    if (canvasRef.current) launchConfetti(canvasRef.current);
    if (!feedbackFired.current) {
      feedbackFired.current = true;
      playSuccessSound();
      triggerHaptic();
    }
  }, []);

  // Auto-dismiss after 3s unless details are open
  useEffect(() => {
    if (detailsOpen) {
      if (timerRef.current) clearTimeout(timerRef.current);
      return;
    }
    timerRef.current = setTimeout(onAutoClose, 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [detailsOpen, onAutoClose]);

  const handleSettle = async () => {
    setSettling(true);
    try {
      const result = await invoke<SettleResult>('settle');
      if (result.settled) {
        toast.success(`Settled into round (txid: ${result.txid})`);
      } else {
        toast.info('Nothing to settle');
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSettling(false);
    }
  };

  return (
    <div className="flex flex-col items-center relative overflow-hidden">
      {/* Confetti canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-20"
      />

      {/* Radial glow backdrop */}
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-80 rounded-full pointer-events-none transition-opacity duration-700"
        style={{
          background: 'radial-gradient(circle, rgba(190,242,100,0.15) 0%, transparent 70%)',
          opacity: animateIn ? 1 : 0,
        }}
      />

      {/* Animated checkmark with ring */}
      <div
        className="relative z-10 mt-6 mb-5 transition-all duration-500"
        style={{
          transform: animateIn ? 'scale(1)' : 'scale(0.3)',
          opacity: animateIn ? 1 : 0,
        }}
      >
        {/* Outer pulsing ring */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'conic-gradient(from 0deg, rgba(190,242,100,0.4), rgba(190,242,100,0.05), rgba(190,242,100,0.4))',
            animation: 'spin 3s linear infinite',
            margin: '-3px',
            borderRadius: '9999px',
          }}
        />
        <div className="relative rounded-full p-5" style={{ background: 'rgba(190,242,100,0.12)' }}>
          <div className="rounded-full p-4" style={{ background: 'rgba(190,242,100,0.15)' }}>
            <svg
              className="h-12 w-12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#bef264"
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
          </div>
        </div>
      </div>

      {/* Amount with counter animation */}
      <div
        className="relative z-10 text-center transition-all duration-500 delay-200"
        style={{
          transform: animateIn ? 'translateY(0)' : 'translateY(12px)',
          opacity: animateIn ? 1 : 0,
        }}
      >
        <p className="text-4xl font-bold tabular-nums tracking-tight" style={{ color: '#bef264' }}>
          +{formatSats(displayAmount)}
        </p>
        <p className="text-sm theme-text-muted mt-0.5">sats received</p>
      </div>

      {/* Type badge */}
      <div
        className="relative z-10 mt-3 mb-6 transition-all duration-500 delay-300"
        style={{
          transform: animateIn ? 'translateY(0)' : 'translateY(8px)',
          opacity: animateIn ? 1 : 0,
        }}
      >
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
          style={{ background: 'rgba(190,242,100,0.1)', color: '#bef264' }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
          {payment.type}
        </span>
      </div>

      {/* View details / Details card */}
      <div
        className="relative z-10 w-full transition-all duration-500 delay-400"
        style={{
          transform: animateIn ? 'translateY(0)' : 'translateY(8px)',
          opacity: animateIn ? 1 : 0,
        }}
      >
        {!detailsOpen ? (
          <button
            onClick={() => setDetailsOpen(true)}
            className="w-full py-2 text-xs theme-text-muted hover:theme-accent transition-colors"
          >
            View details
            <svg className="inline-block ml-1 h-3 w-3 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        ) : (
          <div
            className="w-full rounded-2xl border p-4 mb-3 space-y-3"
            style={{
              background: 'rgba(255,255,255,0.03)',
              borderColor: 'rgba(255,255,255,0.06)',
            }}
          >
            <div className="flex justify-between items-center">
              <span className="text-xs theme-text-muted">Amount</span>
              <span className="text-xs font-semibold tabular-nums theme-text">
                {formatSats(payment.amount_sat)} sats
              </span>
            </div>
            <div className="h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
            <div className="flex justify-between items-center">
              <span className="text-xs theme-text-muted">Type</span>
              <span className="text-xs font-semibold theme-text">{payment.type}</span>
            </div>
            <div className="h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
            <div className="flex justify-between items-center">
              <span className="text-xs theme-text-muted">Time</span>
              <span className="text-xs font-semibold theme-text">
                {payment.timestamp.toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            </div>
            {payment.type === 'Boarding' && (
              <>
                <div className="h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
                <button
                  disabled={settling}
                  onClick={() => void handleSettle()}
                  className="w-full rounded-xl py-2.5 text-sm font-bold text-gray-900 active:scale-95 transition-all disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #bef264, #84cc16)' }}
                >
                  {settling ? 'Settling...' : 'Settle now'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Done button */}
      {detailsOpen && (
        <button
          onClick={onDone}
          className="relative z-10 w-full rounded-2xl py-3.5 text-sm font-bold theme-text transition-all active:scale-[0.98]"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          Done
        </button>
      )}
    </div>
  );
}

// ── Main Content ───────────────────────────────────────────────────────

function ReceiveSheetContent({ onClose }: { onClose: () => void }) {
  const [addresses, setAddresses] = useState<ReceiveAddresses | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [receivedPayments, setReceivedPayments] = useState<ReceivedPayment[]>([]);
  const [currentPaymentIndex, setCurrentPaymentIndex] = useState(0);
  const initialBoardingSat = useRef<number | null>(null);

  const amountSats = /^\d+$/.test(amountInput) ? Number(amountInput) : null;
  const amountFiat = useSatsToFiat(amountSats ?? 0);
  const ln = useLnInvoice();

  const lnInvoiceForQr =
    ln.invoice && ln.invoiceAmount === amountSats ? ln.invoice : null;

  const qrValue = addresses
    ? buildBip21(
        addresses.boarding_address,
        addresses.ark_address,
        amountSats,
        lnInvoiceForQr,
      )
    : null;

  const currentPayment = receivedPayments[currentPaymentIndex] ?? null;
  const showConfirmation = currentPayment !== null;

  // Fetch addresses and start subscription
  useEffect(() => {
    let cancelled = false;
    let subscriptionStarted: Promise<unknown> = Promise.resolve();

    invoke<ReceiveAddresses>('get_receive_address')
      .then((result) => {
        if (cancelled) return;
        setAddresses(result);
        subscriptionStarted = invoke('start_receive_subscription', {
          arkAddress: result.ark_address,
        }).catch((err) => {
          console.warn('Failed to start receive subscription:', err);
        });
      })
      .catch((err) => {
        if (!cancelled) {
          const msg = typeof err === 'string' ? err : 'Failed to get addresses';
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      void subscriptionStarted.then(() =>
        invoke('stop_receive_subscription').catch((err) => {
          console.warn('Failed to stop receive subscription:', err);
        }),
      );
    };
  }, []);

  // Listen for Ark payment-received events
  useEffect(() => {
    const unlisten = listen<{ amount_sat: number }>('payment-received', (event) => {
      setReceivedPayments((prev) => [
        ...prev,
        {
          amount_sat: event.payload.amount_sat,
          type: 'Ark Transfer',
          timestamp: new Date(),
        },
      ]);
    });

    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Poll boarding balance for onchain receives
  useEffect(() => {
    // Capture initial boarding balance
    invoke<WalletBalance>('get_balance')
      .then((bal) => {
        initialBoardingSat.current = bal.boarding_sat;
      })
      .catch(() => {});

    const interval = setInterval(async () => {
      if (initialBoardingSat.current === null) return;
      try {
        const bal = await invoke<WalletBalance>('get_balance');
        const increase = bal.boarding_sat - initialBoardingSat.current;
        if (increase > 0) {
          initialBoardingSat.current = bal.boarding_sat;
          setReceivedPayments((prev) => [
            ...prev,
            {
              amount_sat: increase,
              type: 'Boarding',
              timestamp: new Date(),
            },
          ]);
        }
      } catch {
        // Balance query failed, skip
      }
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  const handleAmountChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (val === '' || /^\d+$/.test(val)) {
        setAmountInput(val);
      }
    },
    [],
  );

  const handleConfirmationDone = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleAutoClose = useCallback(() => {
    // If there are more payments queued, show the next one
    if (currentPaymentIndex < receivedPayments.length - 1) {
      setCurrentPaymentIndex((i) => i + 1);
    } else {
      onClose();
    }
  }, [currentPaymentIndex, receivedPayments.length, onClose]);

  // Show confirmation view
  if (showConfirmation) {
    return (
      <ConfirmationView
        key={currentPaymentIndex}
        payment={currentPayment}
        onDone={handleConfirmationDone}
        onAutoClose={handleAutoClose}
      />
    );
  }

  return (
    <>
      {loading && (
        <div className="flex flex-col items-center py-12">
          <svg
            className="h-8 w-8 animate-spin text-lime-300"
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
        </div>
      )}

      {error && (
        <div className="rounded-2xl theme-danger-bg p-6 text-center">
          <p className="text-sm theme-danger">{error}</p>
        </div>
      )}

      {addresses && qrValue && (
        <div className="flex flex-col items-center">
          <div className="w-full mb-4">
            <label className="block text-xs theme-text-muted mb-1.5">
              Amount (optional)
            </label>
            <div className="flex items-center gap-2 rounded-xl theme-card px-4 py-2.5">
              <input
                type="text"
                inputMode="numeric"
                placeholder="0"
                value={amountInput}
                onChange={handleAmountChange}
                className="flex-1 bg-transparent text-sm font-medium theme-text outline-none placeholder:opacity-20 tabular-nums"
              />
              <span className="text-xs theme-text-muted">sats</span>
            </div>
            {amountSats !== null && amountSats > 0 && (
              <div className="mt-1 flex justify-between gap-2">
                {amountFiat ? (
                  <p className="text-[10px] theme-text-muted tabular-nums">
                    ≈ {amountFiat}
                  </p>
                ) : (
                  <span />
                )}
                <p className="text-[10px] theme-text-faint text-right">
                  {formatSats(amountSats)} sats = {satsToBtc(amountSats)} BTC
                </p>
              </div>
            )}
          </div>

          <div className="rounded-2xl bg-white p-4 mb-4">
            {/*
              Lightning invoices push this QR to ~70+ modules per side. Keep
              the module size printable by rendering large and letting it
              scale down — 320px at level "L" (7% EC, standard for BOLT11)
              gives each module ≥4px on-screen and stays scannable from
              another device's camera.
            */}
            <QRCode
              value={qrValue}
              size={320}
              level="L"
              style={{ height: 'auto', maxWidth: '100%', width: '100%' }}
            />
          </div>

          <div className="w-full space-y-2">
            <CopyRow
              label="BIP21"
              value={qrValue}
              truncated={truncateMiddle(qrValue, 16, 12)}
            />
            <CopyRow label="BTC address" value={addresses.boarding_address} />
            <CopyRow label="Ark address" value={addresses.ark_address} />
            {ln.loading && (
              <div className="flex items-center gap-3 rounded-xl theme-card px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-[10px] theme-text-muted mb-0.5">
                    Lightning invoice
                  </p>
                  <p className="text-xs theme-text-faint">Generating...</p>
                </div>
                <svg
                  className="h-4 w-4 shrink-0 animate-spin theme-text-faint"
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
              </div>
            )}
            {ln.error && (
              <div className="rounded-xl theme-card px-4 py-2.5">
                <p className="text-[10px] theme-text-muted mb-0.5">
                  Lightning invoice
                </p>
                <p className="text-xs theme-danger/70">{ln.error}</p>
              </div>
            )}
            {lnInvoiceForQr && (
              <CopyRow label="Lightning invoice" value={lnInvoiceForQr} />
            )}
            {!ln.loading &&
              !lnInvoiceForQr &&
              amountSats !== null &&
              amountSats > 0 && (
                <button
                  onClick={() => ln.generate(amountSats)}
                  className="w-full rounded-xl theme-warning-bg px-4 py-2.5 text-xs font-medium theme-warning hover:opacity-80 transition-colors"
                >
                  Generate Lightning invoice
                </button>
              )}
          </div>
        </div>
      )}
    </>
  );
}

function ReceiveSheet({ open, onOpenChange, onReceived }: ReceiveSheetProps) {
  const kbInset = useKeyboardInset();
  const handleClose = useCallback(() => {
    onOpenChange(false);
    onReceived?.();
  }, [onOpenChange, onReceived]);

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl theme-drawer px-6 pt-6 pb-8 outline-none"
          style={{
            height: 'calc(var(--app-height) * 0.85)',
            maxHeight: kbInset > 0 ? `calc(100dvh - ${kbInset}px - 16px)` : undefined,
            bottom: kbInset,
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
          }}
        >
          <Drawer.Handle className="mx-auto mb-4 h-1 w-10 rounded-full theme-drawer-handle" />

          <Drawer.Title className="text-lg font-bold theme-text text-center mb-1">
            Receive
          </Drawer.Title>
          <Drawer.Description className="text-xs theme-text-muted text-center mb-5">
            Share an address to receive bitcoin
          </Drawer.Description>

          <div className="overflow-y-auto">
            {open && <ReceiveSheetContent onClose={handleClose} />}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export default ReceiveSheet;
