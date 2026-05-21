import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Drawer } from "vaul";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { formatSats } from "../utils/format";
import type { VtxoInfo } from "./VtxoCard";

interface SelectedCoinsSendDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedVtxos: VtxoInfo[];
  onSuccess: () => void;
}

interface SendResult {
  txid: string;
}

type Step = "form" | "sending" | "success" | "error";

// Spends exactly the picked VTXOs via `send_ark_selected`, bypassing the
// SDK's automatic coin selection. Ark-only: there is no selection variant
// for onchain offboarding in the SDK.
function DrawerBody({
  selectedVtxos,
  onSuccess,
  onClose,
}: {
  selectedVtxos: VtxoInfo[];
  onSuccess: () => void;
  onClose: () => void;
}) {
  const totalSat = useMemo(
    () => selectedVtxos.reduce((sum, v) => sum + v.amount_sat, 0),
    [selectedVtxos],
  );

  const [address, setAddress] = useState("");
  // Pre-fill the full selected total — the common case here is sweeping
  // funds out. The user can edit it down to leave change behind.
  const [amountInput, setAmountInput] = useState(String(totalSat));
  const [step, setStep] = useState<Step>("form");
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amountSat = /^\d+$/.test(amountInput) ? Number(amountInput) : null;
  const overTotal = amountSat !== null && amountSat > totalSat;
  const canSend =
    selectedVtxos.length > 0 &&
    address.trim().length > 0 &&
    amountSat !== null &&
    amountSat > 0 &&
    !overTotal;

  const handleConfirm = async () => {
    if (!canSend || amountSat === null) return;
    setStep("sending");
    setError(null);
    try {
      const outpoints = selectedVtxos.map((v) => `${v.txid}:${v.vout}`);
      const result = await invoke<SendResult>("send_ark_selected", {
        address: address.trim(),
        amountSat,
        outpoints,
      });
      setTxid(result.txid);
      setStep("success");
      onSuccess();
    } catch (e) {
      setError(typeof e === "string" ? e : "Send failed");
      setStep("error");
    }
  };

  if (step === "sending") {
    return (
      <div className="flex flex-col items-center py-8">
        <svg className="h-8 w-8 animate-spin text-lime-300 mb-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-sm theme-text-secondary">Sending...</p>
      </div>
    );
  }

  if (step === "success") {
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
        <p className="text-sm theme-text-muted mb-4 text-center max-w-[260px]">
          {amountSat != null ? formatSats(amountSat) : ""} sats via Ark
        </p>
        {txid && (
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(txid);
                toast.success("Transaction ID copied");
              } catch {
                toast.error("Failed to copy");
              }
            }}
            className="flex items-center gap-2 rounded-xl theme-card px-4 py-2.5 transition-colors mb-4"
          >
            <span className="font-mono text-xs theme-text-secondary max-w-[200px] truncate">
              {txid}
            </span>
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

  if (step === "error") {
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
        <p className="text-sm theme-danger mb-4 text-center px-4 break-words">{error}</p>
        <div className="flex gap-3 w-full">
          <button
            onClick={() => setStep("form")}
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

  // ── form ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl theme-card px-4 py-3 space-y-1">
        <div className="flex justify-between">
          <span className="text-xs theme-text-muted">Spending</span>
          <span className="text-xs theme-text-secondary">
            {selectedVtxos.length} coin{selectedVtxos.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs theme-text-muted">Total selected</span>
          <span className="text-xs theme-text font-medium tabular-nums">
            {formatSats(totalSat)} sats
          </span>
        </div>
      </div>

      <div>
        <label className="block text-xs theme-text-muted mb-1.5">Recipient Ark address</label>
        <input
          type="text"
          placeholder="Ark address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full rounded-xl theme-card px-4 py-3 text-sm theme-text outline-none placeholder:opacity-20 font-mono"
        />
        <p className="text-[10px] theme-text-faint mt-1">
          Ark address only — onchain offboarding can't target specific coins.
        </p>
      </div>

      <div>
        <label className="block text-xs theme-text-muted mb-1.5">Amount</label>
        <div className="flex items-center gap-2 rounded-xl theme-card px-4 py-3">
          <input
            type="text"
            inputMode="numeric"
            placeholder="0"
            value={amountInput}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "" || /^\d+$/.test(v)) setAmountInput(v);
            }}
            className="flex-1 bg-transparent text-sm font-medium theme-text outline-none placeholder:opacity-20 tabular-nums"
          />
          <span className="text-xs theme-text-muted">sats</span>
        </div>
        <div className="flex justify-between mt-1">
          {overTotal ? (
            <p className="text-[10px] theme-danger">Exceeds selected coins</p>
          ) : (
            <span />
          )}
          <button
            onClick={() => setAmountInput(String(totalSat))}
            className="text-[10px] theme-accent hover:opacity-80 transition-colors"
          >
            Max
          </button>
        </div>
      </div>

      <button
        disabled={!canSend}
        onClick={() => void handleConfirm()}
        className="w-full rounded-xl bg-lime-300 py-3 text-sm font-bold text-gray-900 active:scale-[0.98] transition-transform disabled:opacity-30 disabled:active:scale-100"
      >
        Send
      </button>
    </div>
  );
}

function SelectedCoinsSendDrawer({
  open,
  onOpenChange,
  selectedVtxos,
  onSuccess,
}: SelectedCoinsSendDrawerProps) {
  const kbInset = useKeyboardInset();
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl theme-drawer px-6 pt-6 pb-8 outline-none"
          style={{
            height: "calc(var(--app-height) * 0.65)",
            maxHeight: kbInset > 0 ? `calc(100dvh - ${kbInset}px - 16px)` : undefined,
            bottom: kbInset,
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 32px)",
          }}
        >
          <Drawer.Handle className="mx-auto mb-4 h-1 w-10 rounded-full theme-drawer-handle" />
          <Drawer.Title className="text-lg font-bold theme-text text-center mb-1">
            Send selected coins
          </Drawer.Title>
          <Drawer.Description className="text-xs theme-text-muted text-center mb-5">
            Spend exactly the VTXOs you picked, bypassing automatic coin selection
          </Drawer.Description>
          <div className="overflow-y-auto">
            {open && (
              <DrawerBody
                selectedVtxos={selectedVtxos}
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

export default SelectedCoinsSendDrawer;
