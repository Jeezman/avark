import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function NsecBackup() {
  const [step, setStep] = useState<"hidden" | "confirm" | "revealed">("hidden");
  const [nsec, setNsec] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");

  const reveal = async () => {
    if (nsec) {
      setStep("revealed");
      return;
    }
    setLoading(true);
    try {
      const value = await invoke<string>("nostr_reveal_nsec");
      setNsec(value);
      setStep("revealed");
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to retrieve private key");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!nsec) return;
    try {
      await navigator.clipboard.writeText(nsec);
      toast.success("nsec copied — paste into a trusted password manager only");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <>
      {step === "hidden" && (
        <div className="rounded-2xl theme-card divide-y theme-divide">
          <button
            onClick={() => setStep("confirm")}
            className="w-full flex items-center justify-between px-4 py-3.5 text-sm text-left theme-card transition-colors"
          >
            <span>Back Up Private Key</span>
            <svg className="h-4 w-4 theme-text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
      {step === "confirm" && (
        <div className="rounded-2xl theme-warning-bg border theme-warning-border p-4">
          <p className="text-sm font-medium theme-warning mb-2">Reveal private key?</p>
          <p className="text-xs theme-text-secondary mb-1">
            Your <span className="font-mono">nsec</span> controls your Nostr identity. Anyone with it can sign and impersonate you. Before continuing:
          </p>
          <ul className="text-xs theme-text-muted mb-4 space-y-1 list-disc list-inside">
            <li>Make sure no one can see your screen</li>
            <li>Save it to a trusted password manager — not chat or notes apps</li>
            <li>It will only unlock your Nostr identity, not your wallet funds</li>
          </ul>
          <p className="text-xs theme-text-muted mb-2">
            Type <span className="font-mono font-medium theme-text">reveal my nsec</span> to continue
          </p>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder="reveal my nsec"
            className="w-full rounded-xl theme-input px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-yellow-500/50 mb-4 font-mono"
          />
          <div className="flex gap-3">
            <button
              onClick={() => { setStep("hidden"); setConfirmInput(""); }}
              className="flex-1 rounded-xl theme-card-elevated py-2.5 text-sm font-medium theme-text-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void reveal()}
              disabled={loading || confirmInput.trim().toLowerCase() !== "reveal my nsec"}
              className="flex-1 rounded-xl bg-yellow-500 py-2.5 text-sm font-bold text-gray-900 transition-colors hover:bg-yellow-400 disabled:opacity-30"
            >
              {loading ? "Loading..." : "Reveal"}
            </button>
          </div>
        </div>
      )}
      {step === "revealed" && nsec && (
        <div className="rounded-2xl theme-warning-bg border theme-warning-border p-4">
          <p className="text-xs theme-warning mb-2 font-medium">Save this somewhere safe — anyone with it controls your Nostr identity</p>
          <p className="text-sm font-mono leading-relaxed break-all">{nsec}</p>
          <p className="mt-3 text-[10px] theme-danger">
            Clipboard data can be read by other apps. Only paste into a trusted password manager — never into messaging apps.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              onClick={() => void copy()}
              className="flex-1 rounded-xl theme-card-elevated px-4 py-2 text-xs font-medium theme-text transition-opacity hover:opacity-80"
            >
              Copy nsec
            </button>
            <button
              onClick={() => {
                setStep("hidden");
                setNsec(null);
                setConfirmInput("");
              }}
              className="flex-1 rounded-xl theme-card-elevated px-4 py-2 text-xs font-medium theme-text-muted transition-opacity hover:opacity-80"
            >
              Hide
            </button>
          </div>
        </div>
      )}
    </>
  );
}
