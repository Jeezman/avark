import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function PackageBroadcastEndpoint({
  configuredUrl,
  tokenConfigured,
  onSaved,
}: {
  configuredUrl: string | null;
  tokenConfigured: boolean;
  onSaved: () => void;
}) {
  const [urlInput, setUrlInput] = useState(configuredUrl ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const url = urlInput.trim();
      const token = tokenInput.trim();
      // Both fields or neither — keeps the contract simple. To rotate the
      // token, re-enter both.
      if ((url && !token) || (!url && token)) {
        toast.error("Set both URL and token, or clear both to remove.");
        return;
      }
      await invoke("set_submitpackage_endpoint", {
        url: url || null,
        token: token || null,
      });
      toast.success(url ? "Endpoint saved" : "Endpoint cleared");
      onSaved();
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to save endpoint");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl theme-card p-4 mt-3 space-y-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold theme-text">
            Package broadcast endpoint
          </p>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              configuredUrl
                ? "theme-accent-bg"
                : "theme-card-elevated theme-text-muted"
            }`}
          >
            {configuredUrl ? "Configured" : "Not set"}
          </span>
        </div>
        <p className="text-xs theme-text-muted mt-1 leading-snug">
          Required for actually broadcasting the cached exit tree on
          mainnet. HTTPS endpoint that wraps Bitcoin Core's{" "}
          <code className="text-[11px] theme-text">submitpackage</code>{" "}
          RPC. If unset, broadcast falls back to esplora and will fail with
          a min-fee error.
        </p>
      </div>
      <label className="block">
        <span className="text-[11px] theme-text-muted">URL</span>
        <input
          type="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://bcrpc.example.com/submitpackage"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="w-full mt-1 rounded-xl theme-card-elevated px-3 py-2 text-sm theme-text font-mono"
        />
      </label>
      <label className="block">
        <span className="text-[11px] theme-text-muted">
          Bearer token
          {tokenConfigured && !tokenInput && (
            <span className="ml-2 theme-accent">(currently set)</span>
          )}
        </span>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={
            tokenConfigured ? "•••• (re-enter to update)" : "Paste your bearer token"
          }
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="w-full mt-1 rounded-xl theme-card-elevated px-3 py-2 text-sm theme-text font-mono"
        />
      </label>
      <button
        onClick={() => void save()}
        disabled={saving}
        className="w-full rounded-xl bg-lime-300 px-4 py-2.5 text-sm font-bold text-gray-900 transition-colors hover:bg-lime-200 disabled:opacity-40"
      >
        {saving ? "Saving..." : "Save endpoint"}
      </button>
    </div>
  );
}
