import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

export function PackageBroadcastEndpoint({
  configuredUrl,
  defaultUrl,
  tokenConfigured,
  onSaved,
}: {
  configuredUrl: string | null;
  defaultUrl: string | null;
  tokenConfigured: boolean;
  onSaved: () => void;
}) {
  const [urlInput, setUrlInput] = useState(configuredUrl ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const hasCustom = configuredUrl !== null;
  const usingDefault = !hasCustom && defaultUrl !== null;
  const showForm = hasCustom || editing || defaultUrl === null;

  const persist = async (
    url: string | null,
    token: string | null,
    successMessage?: string,
  ) => {
    setSaving(true);
    try {
      await invoke("set_submitpackage_endpoint", { url, token });
      toast.success(
        successMessage ??
          (url
            ? "Custom endpoint saved"
            : defaultUrl
              ? "Using the built-in endpoint"
              : "Endpoint cleared"),
      );
      setEditing(false);
      onSaved();
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to save endpoint");
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const url = urlInput.trim();
    const token = tokenInput.trim();
    if (!url && token) {
      toast.error("Enter the endpoint URL for the new token.");
      return;
    }
    // Empty token field → null → keep whatever token is stored.
    await persist(url || null, token || null);
  };

  const removeToken = async () => {
    await persist(configuredUrl, "", "Bearer token removed");
  };

  const badge = hasCustom ? "Custom" : usingDefault ? "Default" : "Not set";

  return (
    <div className="rounded-2xl theme-card p-4 mt-3 space-y-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold theme-text">
            Package broadcast endpoint
          </p>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              hasCustom || usingDefault
                ? "theme-accent-bg"
                : "theme-card-elevated theme-text-muted"
            }`}
          >
            {badge}
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

      {usingDefault && !editing && (
        <>
          <div>
            <p className="text-[11px] theme-text-muted">Built-in endpoint</p>
            <p className="text-sm font-mono theme-text break-all mt-1">{defaultUrl}</p>
          </div>
          <button
            onClick={() => setEditing(true)}
            className="w-full rounded-xl theme-card-elevated px-4 py-2.5 text-sm font-semibold theme-text hover:opacity-80 transition-opacity"
          >
            Use custom endpoint
          </button>
        </>
      )}

      {showForm && (
        <>
          <label className="block">
            <span className="text-[11px] theme-text-muted">URL</span>
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder=""
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="w-full mt-1 rounded-xl theme-card-elevated px-3 py-2 text-sm theme-text font-mono"
            />
          </label>
          <label className="block">
            <span className="text-[11px] theme-text-muted">
              Bearer token (optional)
              {tokenConfigured && !tokenInput && (
                <span className="ml-2 theme-accent">(saved)</span>
              )}
            </span>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={
                tokenConfigured
                  ? "•••• (leave empty to keep the saved token)"
                  : "Optional"
              }
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="w-full mt-1 rounded-xl theme-card-elevated px-3 py-2 text-sm theme-text font-mono"
            />
            {tokenConfigured && (
              <button
                onClick={() => void removeToken()}
                disabled={saving}
                className="mt-1 text-[11px] theme-danger underline underline-offset-2 hover:opacity-80 disabled:opacity-40"
              >
                Remove saved token
              </button>
            )}
          </label>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="w-full rounded-xl bg-lime-300 px-4 py-2.5 text-sm font-bold text-gray-900 transition-colors hover:bg-lime-200 disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save endpoint"}
          </button>
          {editing && !hasCustom && (
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="w-full rounded-xl theme-card-elevated px-4 py-2.5 text-sm font-medium theme-text-muted hover:opacity-80 transition-opacity"
            >
              Cancel
            </button>
          )}
          {hasCustom && defaultUrl && (
            <button
              onClick={() => void persist(null, null)}
              disabled={saving}
              className="w-full rounded-xl theme-card-elevated px-4 py-2.5 text-sm font-medium theme-text-muted hover:opacity-80 transition-opacity"
            >
              Reset to built-in endpoint
            </button>
          )}
        </>
      )}
    </div>
  );
}
