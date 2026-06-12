import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

function defaultExplorerForNetwork(network: string | null | undefined): {
  label: string;
  url: string;
} {
  switch (network?.toLowerCase()) {
    case "testnet":
      return { label: "Blockstream", url: "https://blockstream.info/testnet/api" };
    case "signet":
      return { label: "Mutinynet", url: "https://mutinynet.com/api" };
    case "regtest":
      return { label: "Local", url: "http://localhost:7070" };
    case "bitcoin":
    default:
      return { label: "Blockstream", url: "https://blockstream.info/api" };
  }
}

function mempoolExplorerForNetwork(network: string | null | undefined): string {
  switch (network?.toLowerCase()) {
    case "testnet":
      return "https://mempool.space/testnet/api";
    case "signet":
      return "https://mempool.space/signet/api";
    case "bitcoin":
    default:
      return "https://mempool.space/api";
  }
}

/// Settings card for choosing the esplora server used for onchain sync.
/// Owns its draft + saving state so typing a custom URL re-renders only this
/// card, not the whole settings route. Remounted via `key` when the canonical
/// saved value changes. Saving the network default stores `null` (no
/// override) rather than the literal URL.
export function EsploraSelector({
  network,
  initialUrl,
}: {
  network: string | null | undefined;
  initialUrl: string;
}) {
  const [value, setValue] = useState(initialUrl);
  const [saving, setSaving] = useState(false);

  const save = async (url: string | null) => {
    setSaving(true);
    try {
      await invoke("set_esplora_url", { url });
      toast.success("Explorer saved — takes effect on next app restart");
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const defaultExplorer = defaultExplorerForNetwork(network);
  const presetExplorers = [
    defaultExplorer,
    { label: "Mempool.space", url: mempoolExplorerForNetwork(network) },
  ];
  const presetUrls = new Set(presetExplorers.map((e) => e.url));
  const effectiveValue = value === "" ? defaultExplorer.url : value;
  const isCustom = !presetUrls.has(effectiveValue);
  const urlToSave = effectiveValue === defaultExplorer.url ? null : effectiveValue;

  return (
    <div className="rounded-2xl theme-card p-4 mt-3 space-y-3">
      <p className="text-xs theme-text-muted mb-0.5">Block Explorer (Esplora)</p>
      <div className="space-y-1.5">
        {presetExplorers.map((option) => (
          <button
            key={option.url}
            onClick={() => setValue(option.url)}
            className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
              effectiveValue === option.url ? "theme-accent-bg" : "theme-card-elevated"
            }`}
          >
            <span className={`h-3 w-3 rounded-full border-2 shrink-0 ${
              effectiveValue === option.url ? "border-current bg-current" : "theme-border"
            }`} />
            <span className="flex-1">
              <span className="font-medium">{option.label}</span>
              <span className="block text-[10px] theme-text-faint font-mono mt-0.5">{option.url}</span>
            </span>
          </button>
        ))}
        <button
          onClick={() => { if (!isCustom) setValue("https://"); }}
          className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
            isCustom ? "theme-accent-bg" : "theme-card-elevated"
          }`}
        >
          <span className={`h-3 w-3 rounded-full border-2 shrink-0 ${
            isCustom ? "border-current bg-current" : "theme-border"
          }`} />
          <span className="font-medium">Custom</span>
        </button>
      </div>
      {isCustom && (
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://your-esplora-server.com/api"
          className="w-full rounded-xl theme-input px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-lime-300/50 font-mono"
        />
      )}
      <button
        disabled={saving}
        onClick={() => void save(urlToSave)}
        className="w-full rounded-xl theme-card-elevated py-2.5 text-xs font-medium theme-text-secondary hover:opacity-80 transition-opacity disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save"}
      </button>
      <p className="text-[10px] theme-text-faint">Esplora server for onchain sync. Takes effect on next app restart.</p>
    </div>
  );
}
