import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

const DEFAULT_ASP_URL = import.meta.env.VITE_DEFAULT_ASP_URL ?? "https://arkade.computer/";

interface AspInfo {
  network: string;
  version: string;
}

type Status =
  | { type: "idle" }
  | { type: "connecting" }
  | { type: "success"; info: AspInfo }
  | { type: "error"; message: string };

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function AspIcon() {
  return (
    <div className="w-16 h-16 mb-6 rounded-2xl theme-card-elevated flex items-center justify-center">
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

type AspConfigProps =
  | { mode?: "onboard"; onConnected: () => void | Promise<void> }
  | {
      mode: "switch";
      currentUrl: string;
      currentNetwork?: string | null;
      onSwitched: () => void | Promise<void>;
      onCancel: () => void;
    };

function AspConfig(props: AspConfigProps) {
  // Switch flow (from Settings) is a distinct state machine; onboarding below
  // is left exactly as it was.
  if (props.mode === "switch") {
    return <SwitchAspFlow {...props} />;
  }

  const { onConnected } = props;
  return <OnboardAsp onConnected={onConnected} />;
}

function OnboardAsp({ onConnected }: { onConnected: () => void | Promise<void> }) {
  const [url, setUrl] = useState(DEFAULT_ASP_URL);
  const [status, setStatus] = useState<Status>({ type: "idle" });

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
    <div className="w-screen min-h-screen flex flex-col theme-bg theme-text">
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <AspIcon />

        <h1 className="text-2xl font-bold mb-2">Connect to ASP</h1>
        <p className="theme-text-secondary text-center mb-8 max-w-xs">
          Enter the URL of your Ark Service Provider to get started.
        </p>

        <div className="w-full max-w-sm">
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (status.type === 'error') setStatus({ type: 'idle' });
            }}
            placeholder="https://arkade.computer/"
            disabled={connecting}
            className="w-full px-4 py-3 rounded-xl theme-card-elevated theme-text placeholder:opacity-20 border border-white/20 focus:border-lime-300 focus:outline-none transition-colors disabled:opacity-50"
          />

          {status.type === 'error' && (
            <p
              className="mt-2 text-sm theme-danger"
              role="alert"
              aria-live="polite"
            >
              {status.message}
            </p>
          )}

          {success && (
            <div className="mt-3 p-3 rounded-xl bg-lime-300/10 border border-lime-300/30">
              <p className="text-sm text-lime-300 font-medium">Connected</p>
              <p className="text-xs theme-text-muted mt-1">
                Network: {status.info.network} &middot; Version:{' '}
                {status.info.version}
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
              ) : (
                'Connect'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const CONFIRM_WORD = "switch";

type SwitchState =
  | { type: "idle" }
  | { type: "probing" }
  | { type: "mismatch"; info: AspInfo } // probed network ≠ current — hard block
  | { type: "ready"; info: AspInfo } // same network — warn + typed confirm
  | { type: "switching" }
  | { type: "error"; message: string };

function SwitchAspFlow({
  currentUrl,
  currentNetwork,
  onSwitched,
  onCancel,
}: {
  currentUrl: string;
  currentNetwork?: string | null;
  onSwitched: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(currentUrl);
  const [confirmText, setConfirmText] = useState("");
  const [state, setState] = useState<SwitchState>({ type: "idle" });

  const busy = state.type === "probing" || state.type === "switching";
  const confirmed = confirmText.trim().toLowerCase() === CONFIRM_WORD;

  async function handleProbe() {
    if (!isValidUrl(url)) {
      setState({ type: "error", message: "Please enter a valid URL (https://...)" });
      return;
    }
    setConfirmText("");
    setState({ type: "probing" });
    try {
      const info = await invoke<AspInfo>("probe_asp", { url: url.trim() });
      if (currentNetwork && info.network !== currentNetwork) {
        setState({ type: "mismatch", info });
      } else {
        setState({ type: "ready", info });
      }
    } catch (e) {
      const message = typeof e === "string" ? e : "Couldn't reach that ASP";
      setState({ type: "error", message });
      toast.error(message);
    }
  }

  async function handleSwitch() {
    if (!confirmed) return;
    setState({ type: "switching" });
    try {
      await invoke<AspInfo>("switch_asp", { url: url.trim() });
      toast.success("ASP switched");
      await onSwitched();
    } catch (e) {
      const message = typeof e === "string" ? e : "Failed to switch ASP";
      setState({ type: "error", message });
      toast.error(message);
    }
  }

  // Editing the URL invalidates any prior probe result.
  function handleUrlChange(value: string) {
    setUrl(value);
    setConfirmText("");
    if (state.type !== "idle" && state.type !== "switching") {
      setState({ type: "idle" });
    }
  }

  return (
    <div className="w-screen min-h-screen flex flex-col theme-bg theme-text">
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <AspIcon />

        <h1 className="text-2xl font-bold mb-2">Switch ASP</h1>
        <p className="theme-text-secondary text-center mb-8 max-w-xs">
          Point your wallet at a different Ark Service Provider on the same
          network.
        </p>

        <div className="w-full max-w-sm">
          <input
            type="url"
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder="https://arkade.computer/"
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl theme-card-elevated theme-text placeholder:opacity-20 border border-white/20 focus:border-lime-300 focus:outline-none transition-colors disabled:opacity-50"
          />

          {state.type === "error" && (
            <p className="mt-2 text-sm theme-danger" role="alert" aria-live="polite">
              {state.message}
            </p>
          )}

          {state.type === "mismatch" && (
            <div className="mt-3 p-3 rounded-xl theme-danger-bg border border-red-500/30">
              <p className="text-sm theme-danger font-medium">
                Different network — can’t switch
              </p>
              <p className="text-xs theme-text-muted mt-1">
                That ASP is on <span className="font-mono">{state.info.network}</span>, but
                your wallet is on <span className="font-mono">{currentNetwork}</span>.
                Switching networks would strand your funds.
              </p>
            </div>
          )}

          {state.type === "ready" && (
            <>
              <div className="mt-3 p-3 rounded-xl bg-amber-400/10 border border-amber-400/30">
                <p className="text-sm text-amber-300 font-medium">Heads up</p>
                <p className="text-xs theme-text-muted mt-1">
                  Reachable · Network:{" "}
                  <span className="font-mono">{state.info.network}</span> · Version:{" "}
                  {state.info.version}
                </p>
                <p className="text-xs theme-text-muted mt-2">
                  Your funds stay on your current ASP — they do <strong>not</strong> move.
                  This only points the app at the new server.
                </p>
              </div>

              <label className="block mt-3 text-xs theme-text-muted">
                Type <span className="font-mono theme-text">{CONFIRM_WORD}</span> to confirm
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoCapitalize="none"
                autoCorrect="off"
                disabled={busy}
                className="w-full mt-1 px-4 py-3 rounded-xl theme-card-elevated theme-text placeholder:opacity-20 border border-white/20 focus:border-lime-300 focus:outline-none transition-colors disabled:opacity-50 font-mono"
              />
            </>
          )}

          {/* Primary action: Switch once an ASP is probed-ready (or mid-switch),
              otherwise Check. Driven by booleans so the "Switching…" spinner
              survives the state transition out of "ready". */}
          {state.type === "ready" || state.type === "switching" ? (
            <button
              onClick={() => void handleSwitch()}
              disabled={!confirmed || busy}
              aria-busy={state.type === "switching"}
              className="w-full mt-4 py-4 rounded-2xl bg-lime-300 text-gray-900 text-lg font-bold shadow-lg active:scale-95 transition-transform disabled:opacity-50 disabled:active:scale-100"
            >
              {state.type === "switching" ? (
                <span className="flex items-center justify-center gap-2">
                  <LoadingSpinner />
                  Switching...
                </span>
              ) : (
                "Switch ASP"
              )}
            </button>
          ) : (
            <button
              onClick={() => void handleProbe()}
              disabled={busy || !url.trim()}
              aria-busy={state.type === "probing"}
              className="w-full mt-4 py-4 rounded-2xl bg-lime-300 text-gray-900 text-lg font-bold shadow-lg active:scale-95 transition-transform disabled:opacity-50 disabled:active:scale-100"
            >
              {state.type === "probing" ? (
                <span className="flex items-center justify-center gap-2">
                  <LoadingSpinner />
                  Checking...
                </span>
              ) : (
                "Check ASP"
              )}
            </button>
          )}

          <button
            onClick={onCancel}
            disabled={state.type === "switching"}
            className="w-full mt-2 py-3 rounded-2xl theme-card-elevated theme-text font-medium active:scale-95 transition-transform disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default AspConfig;
