import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

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
export function useLnInvoice(): LnState {
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
