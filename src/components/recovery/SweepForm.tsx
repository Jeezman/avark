import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { parseSatAmount } from "../../utils/amount";
import { formatSats, shortTxid } from "../../utils/format";
import {
  maxSweepSat,
  poolBelowDust,
  sweepAmountError,
  SWEEP_FEE_BUFFER_SATS,
  type SweepAmountError,
} from "./sweepAmount";

export interface UnrolledVtxoMaturity {
  txid: string;
  vout: number;
  amountSat: number;
  confirmedAt: number | null;
  csvMatureAt: number | null;
  mature: boolean;
}

function errorMessage(err: SweepAmountError): string {
  switch (err.kind) {
    case "invalid":
      return "Enter a whole number of sats";
    case "belowDust":
      return `Below the dust limit — must be at least ${formatSats(err.dustSat)} sats`;
    case "exceedsMax":
      return `Max ~${formatSats(err.maxSat)} sats after the ~${formatSats(
        SWEEP_FEE_BUFFER_SATS,
      )} sat fee`;
  }
}

/**
 * Sweeps ALL mature unrolled outputs in one transaction.
 */
export function SweepForm({
  totalSat,
  dustSat,
  outputCount,
  onSwept,
}: {
  totalSat: number;
  dustSat: number;
  outputCount: number;
  onSwept: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState(String(maxSweepSat(totalSat)));
  const [amountTouched, setAmountTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // Re-seed the prefill on change unless the user has typed their own amount 
  const [seededFromSat, setSeededFromSat] = useState(totalSat);
  if (totalSat !== seededFromSat) {
    setSeededFromSat(totalSat);
    if (!amountTouched) setAmount(String(maxSweepSat(totalSat)));
  }

  if (poolBelowDust(totalSat, dustSat)) {
    return (
      <p className="rounded-xl theme-warning-bg px-3 py-2 text-xs theme-warning">
        Too small to sweep yet — {formatSats(totalSat)} sats minus the ~
        {formatSats(SWEEP_FEE_BUFFER_SATS)} sat fee is below the{" "}
        {formatSats(dustSat)} sat dust limit. The sweep unlocks when more
        outputs mature.
      </p>
    );
  }

  const parsedAmount = parseSatAmount(amount);
  const amountErr = sweepAmountError(parsedAmount ?? NaN, totalSat, dustSat);

  async function submit() {
    const trimmed = address.trim();
    if (!trimmed) {
      toast.error("Enter a destination address");
      return;
    }
    if (amountErr || parsedAmount === null) {
      toast.error(amountErr ? errorMessage(amountErr) : "Enter a whole number of sats");
      return;
    }
    setBusy(true);
    try {
      const txid = await invoke<string>("sweep_unrolled_to_onchain", {
        address: trimmed,
        amountSat: parsedAmount,
      });
      toast.success(`Swept — ${shortTxid(txid)}`);
      setOpen(false);
      setAddress("");
      setAmountTouched(false);
      onSwept();
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setAmount(String(maxSweepSat(totalSat)));
          setAmountTouched(false);
          setOpen(true);
        }}
        className="block w-full rounded-xl bg-lime-300 px-4 py-2 text-center text-xs font-bold text-gray-900 active:scale-95 transition-transform"
      >
        Sweep {outputCount > 1 ? `${outputCount} outputs` : ""} to onchain →
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-xl theme-card-elevated p-3">
      <label className="block">
        <span className="text-[11px] theme-text-muted">Destination address</span>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="bc1q..."
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="w-full mt-1 rounded-lg theme-card px-3 py-2 text-xs theme-text font-mono"
        />
      </label>
      <label className="block">
        <span className="text-[11px] theme-text-muted">
          Amount (sats) — max ~{formatSats(maxSweepSat(totalSat))} after fee
        </span>
        <input
          type="number"
          value={amount}
          onChange={(e) => {
            setAmountTouched(true);
            setAmount(e.target.value);
          }}
          min={dustSat}
          max={maxSweepSat(totalSat)}
          className="w-full mt-1 rounded-lg theme-card px-3 py-2 text-xs theme-text tabular-nums"
        />
      </label>
      {amountErr && (
        <p className="text-[11px] theme-warning">{errorMessage(amountErr)}</p>
      )}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          className="flex-1 rounded-lg theme-card px-3 py-2 text-xs font-medium"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy || amountErr !== null}
          className="flex-1 rounded-lg bg-lime-300 px-3 py-2 text-xs font-bold text-gray-900 active:scale-95 transition-transform disabled:opacity-40"
        >
          {busy ? "Sweeping…" : "Sweep"}
        </button>
      </div>
    </div>
  );
}
