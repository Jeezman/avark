import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

const DEFAULT_ASP_URL = "https://arkade.computer/";

interface AspInfo {
  network: string;
  version: string;
}

type Status =
  | { type: "idle" }
  | { type: "connecting" }
  | { type: "success"; info: AspInfo }
  | { type: "error"; message: string };

function AspIcon() {
  return (
    <div className="w-16 h-16 mb-6 rounded-2xl bg-white/10 flex items-center justify-center">
      <svg viewBox="0 0 24 24" className="w-8 h-8 text-lime-300" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function AspConfig({ onConnected }: { onConnected: () => void | Promise<void> }) {
  const [url, setUrl] = useState(DEFAULT_ASP_URL);
  const [status, setStatus] = useState<Status>({ type: "idle" });

  function isValidUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }

  async function handleConnect() {
    if (!isValidUrl(url)) {
      setStatus({ type: "error", message: "Please enter a valid URL (https://...)" });
      return;
    }

    setStatus({ type: "connecting" });
    try {
      const info = await invoke<AspInfo>("connect_asp", { url });
      setStatus({ type: "success", info });
    } catch (e) {
      const message = typeof e === "string" ? e : "Failed to connect to ASP";
      setStatus({ type: "error", message });
      toast.error(message);
    }
  }

  const connecting = status.type === "connecting";
  const success = status.type === "success";

  return (
    <div className="fixed inset-0 flex flex-col bg-gradient-to-br from-gray-900 to-gray-800 text-white">
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <AspIcon />

        <h1 className="text-2xl font-bold mb-2">Connect to ASP</h1>
        <p className="text-white/60 text-center mb-8 max-w-xs">
          Enter the URL of your Ark Service Provider to get started.
        </p>

        <div className="w-full max-w-sm">
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (status.type === "error") setStatus({ type: "idle" });
            }}
            placeholder="https://arkade.computer/"
            disabled={connecting}
            className="w-full px-4 py-3 rounded-xl bg-white/10 text-white placeholder-white/30 border border-white/20 focus:border-lime-300 focus:outline-none transition-colors disabled:opacity-50"
          />

          {status.type === "error" && (
            <p className="mt-2 text-sm text-red-400" role="alert" aria-live="polite">{status.message}</p>
          )}

          {success && (
            <div className="mt-3 p-3 rounded-xl bg-lime-300/10 border border-lime-300/30">
              <p className="text-sm text-lime-300 font-medium">Connected</p>
              <p className="text-xs text-white/50 mt-1">
                Network: {status.info.network} &middot; Version: {status.info.version}
              </p>
            </div>
          )}

          {success ? (
            <button
              onClick={() => onConnected()}
              className="w-full mt-4 py-4 rounded-2xl bg-lime-300 text-gray-900 text-lg font-bold shadow-lg active:scale-95 transition-transform"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={connecting || !url.trim()}
              aria-busy={connecting}
              className="w-full mt-4 py-4 rounded-2xl bg-lime-300 text-gray-900 text-lg font-bold shadow-lg active:scale-95 transition-transform disabled:opacity-50 disabled:active:scale-100"
            >
              {connecting ? (
                <span className="flex items-center justify-center gap-2">
                  <LoadingSpinner />
                  Connecting...
                </span>
              ) : "Connect"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default AspConfig;
