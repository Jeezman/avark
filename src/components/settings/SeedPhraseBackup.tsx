import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function SeedPhraseBackup() {
  const [step, setStep] = useState<"hidden" | "confirm" | "revealed">("hidden");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");

  const reveal = async () => {
    if (mnemonic) {
      setStep("revealed");
      return;
    }
    setLoading(true);
    try {
      const words = await invoke<string>("get_mnemonic");
      setMnemonic(words);
      setStep("revealed");
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to retrieve seed phrase");
    } finally {
      setLoading(false);
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
            <span>Back Up Seed Phrase</span>
            <svg className="h-4 w-4 theme-text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}
      {step === "confirm" && (
        <div className="rounded-2xl theme-warning-bg border theme-warning-border p-4">
          <p className="text-sm font-medium theme-warning mb-2">Reveal seed phrase?</p>
          <p className="text-xs theme-text-secondary mb-1">Your seed phrase gives full access to your funds. Before continuing:</p>
          <ul className="text-xs theme-text-muted mb-4 space-y-1 list-disc list-inside">
            <li>Make sure no one can see your screen</li>
            <li>Do not screenshot or copy to clipboard</li>
            <li>Write the words down on paper only</li>
          </ul>
          <p className="text-xs theme-text-muted mb-2">
            Type <span className="font-mono font-medium theme-text">reveal my seed</span> to continue
          </p>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder="reveal my seed"
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
              disabled={loading || confirmInput.trim().toLowerCase() !== "reveal my seed"}
              className="flex-1 rounded-xl bg-yellow-500 py-2.5 text-sm font-bold text-gray-900 transition-colors hover:bg-yellow-400 disabled:opacity-30"
            >
              {loading ? "Loading..." : "Reveal"}
            </button>
          </div>
        </div>
      )}
      {step === "revealed" && mnemonic && (
        <div className="rounded-2xl theme-warning-bg border theme-warning-border p-4">
          <p className="text-xs theme-warning mb-2 font-medium">Write these words down on paper — do not copy digitally</p>
          <p className="text-sm font-mono leading-relaxed">{mnemonic}</p>
          <p className="mt-3 text-[10px] theme-danger">Never screenshot, copy to clipboard, or store digitally. Clipboard data can be read by other apps.</p>
          <button
            onClick={() => {
              setStep("hidden");
              setMnemonic(null);
              setConfirmInput("");
            }}
            className="mt-3 rounded-xl theme-card-elevated px-4 py-2 text-xs font-medium theme-text-muted hover:opacity-80 transition-opacity"
          >
            Hide seed phrase
          </button>
        </div>
      )}
    </>
  );
}
