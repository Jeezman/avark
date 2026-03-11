import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import QRCode from 'react-qr-code';
import { Drawer } from 'vaul';

interface ReceiveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ReceiveAddresses {
  ark_address: string;
  boarding_address: string;
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

  return (
    <button
      onClick={handleCopy}
      className="flex w-full items-center justify-between gap-3 rounded-xl bg-white/5 px-4 py-2.5 hover:bg-white/10 transition-colors text-left"
    >
      <div className="min-w-0">
        <p className="text-[10px] text-white/40 mb-0.5">{label}</p>
        <p className="font-mono text-xs text-white/70 truncate">
          {truncated ?? truncateMiddle(value)}
        </p>
      </div>
      <svg
        className="h-4 w-4 shrink-0 text-white/30"
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
  );
}

interface LnState {
  invoice: string | null;
  invoiceAmount: number | null;
  loading: boolean;
  error: string | null;
  generate: (amountSats: number) => void;
}

/**
 * Hook that generates a Lightning invoice on demand (not automatically).
 * Each call to `generate` creates a real Boltz swap, so it must only be
 * triggered by explicit user action.
 */
function useLnInvoice(): LnState {
  const [invoice, setInvoice] = useState<string | null>(null);
  const [invoiceAmount, setInvoiceAmount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const generate = useCallback((amountSats: number) => {
    if (amountSats <= 0) return;
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    setInvoice(null);

    invoke<string>('get_ln_invoice', { amountSat: amountSats })
      .then((inv) => {
        if (id === fetchIdRef.current) {
          setInvoice(inv);
          setInvoiceAmount(amountSats);
        }
      })
      .catch((err) => {
        if (id === fetchIdRef.current) {
          setError(typeof err === 'string' ? err : 'Failed to create invoice');
          setInvoiceAmount(null);
        }
      })
      .finally(() => {
        if (id === fetchIdRef.current) setLoading(false);
      });
  }, []);

  return { invoice, invoiceAmount, loading, error, generate };
}

function ReceiveSheetContent() {
  const [addresses, setAddresses] = useState<ReceiveAddresses | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState('');

  const amountSats = /^\d+$/.test(amountInput) ? Number(amountInput) : null;
  const ln = useLnInvoice();

  // Show the invoice in the BIP21 URI only if it matches the current amount
  const lnInvoiceForQr =
    ln.invoice && ln.invoiceAmount === amountSats ? ln.invoice : null;

  // Unified BIP21 URI: always includes ark address, adds lightning when available
  const qrValue = addresses
    ? buildBip21(
        addresses.boarding_address,
        addresses.ark_address,
        amountSats,
        lnInvoiceForQr,
      )
    : null;

  useEffect(() => {
    let cancelled = false;

    invoke<ReceiveAddresses>('get_receive_address')
      .then((result) => {
        if (!cancelled) setAddresses(result);
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
    };
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
        <div className="rounded-2xl bg-red-500/10 p-6 text-center">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {addresses && qrValue && (
        <div className="flex flex-col items-center">
          <div className="w-full mb-4">
            <label className="block text-xs text-white/40 mb-1.5">
              Amount (optional)
            </label>
            <div className="flex items-center gap-2 rounded-xl bg-white/5 px-4 py-2.5">
              <input
                type="text"
                inputMode="numeric"
                placeholder="0"
                value={amountInput}
                onChange={handleAmountChange}
                className="flex-1 bg-transparent text-sm font-medium text-white outline-none placeholder:text-white/20 tabular-nums"
              />
              <span className="text-xs text-white/40">sats</span>
            </div>
            {amountSats !== null && amountSats > 0 && (
              <p className="text-[10px] text-white/30 mt-1 text-right">
                {amountSats.toLocaleString()} sats = {satsToBtc(amountSats)} BTC
              </p>
            )}
          </div>

          <div className="rounded-2xl bg-white p-4 mb-4">
            <QRCode value={qrValue} size={200} level="M" />
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
              <div className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-[10px] text-white/40 mb-0.5">
                    Lightning invoice
                  </p>
                  <p className="text-xs text-white/30">Generating...</p>
                </div>
                <svg
                  className="h-4 w-4 shrink-0 animate-spin text-white/30"
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
              <div className="rounded-xl bg-white/5 px-4 py-2.5">
                <p className="text-[10px] text-white/40 mb-0.5">
                  Lightning invoice
                </p>
                <p className="text-xs text-red-300/70">{ln.error}</p>
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
                  className="w-full rounded-xl bg-yellow-300/10 px-4 py-2.5 text-xs font-medium text-yellow-300 hover:bg-yellow-300/20 transition-colors"
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

function ReceiveSheet({ open, onOpenChange }: ReceiveSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-3xl bg-gray-800 px-6 pt-6 pb-8 outline-none"
          style={{
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 32px)',
          }}
        >
          <Drawer.Handle className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />

          <Drawer.Title className="text-lg font-bold text-white text-center mb-1">
            Receive
          </Drawer.Title>
          <Drawer.Description className="text-xs text-white/50 text-center mb-5">
            Share an address to receive bitcoin
          </Drawer.Description>

          <div className="overflow-y-auto">
            {open && <ReceiveSheetContent />}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export default ReceiveSheet;
