import { useEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWalletConnect } from "../context/WalletConnectContext";

// Tauri's mobile WebViews expose real UAs (Android WebView → "Android",
// WKWebView → "iPhone"/"iPad"), so this heuristic is reliable enough to
// decide "should we deep-link or show a QR?".
const IS_MOBILE_WEBVIEW = /Android|iPhone|iPad/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : ""
);

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletConnectButton() {
  const {
    status,
    address,
    error,
    pairingUri,
    connect,
    cancelPairing,
    disconnect,
  } = useWalletConnect();

  const sheetOpen = status === "connecting";

  // Track which pairing URI the deep-link attempt failed against. Deriving
  // the boolean from `failedUri === pairingUri` means state resets naturally
  // as the URI rotates — no synchronous setState in the effect body.
  const didDeepLinkRef = useRef(false);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const deepLinkFailed = failedUri !== null && failedUri === pairingUri;

  useEffect(() => {
    if (!pairingUri) {
      didDeepLinkRef.current = false;
      return;
    }
    if (!IS_MOBILE_WEBVIEW || didDeepLinkRef.current) return;
    didDeepLinkRef.current = true;
    openUrl(pairingUri).catch(() => {
      setFailedUri(pairingUri);
      toast.error("No wallet app responded — scan the QR or copy the URI");
    });
  }, [pairingUri]);

  function handleClose() {
    cancelPairing();
  }

  function copyUri() {
    if (!pairingUri) return;
    navigator.clipboard
      .writeText(pairingUri)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Copy failed"));
  }

  function reopenWallet() {
    if (!pairingUri) return;
    openUrl(pairingUri).catch(() => toast.error("Couldn't open wallet app"));
  }

  if (status === "initializing") {
    return (
      <button
        disabled
        className="px-4 py-2 rounded-full theme-card text-sm theme-text-muted"
      >
        Initializing…
      </button>
    );
  }

  if (status === "unconfigured") {
    return (
      <p className="text-xs theme-text-muted max-w-xs text-center">
        {error ?? "WalletConnect not configured."}
      </p>
    );
  }

  if (status === "connected" && address) {
    return (
      <div
        className="inline-flex items-center gap-2 rounded-full border theme-border pl-2.5 pr-1 py-1"
        style={{ background: "var(--color-bg-secondary)" }}
      >
        <span
          className="live-dot h-1.5 w-1.5 rounded-full shrink-0"
          style={{ background: "var(--color-accent)" }}
          aria-hidden="true"
        />
        <span className="font-mono text-[12px] font-medium theme-text tabular-nums tracking-tight">
          {truncate(address)}
        </span>
        <button
          type="button"
          onClick={disconnect}
          title="Disconnect wallet"
          aria-label="Disconnect wallet"
          className="h-5 w-5 rounded-full flex items-center justify-center theme-text-muted hover:theme-text transition-colors"
        >
          <svg
            className="h-3 w-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={connect}
        disabled={status === "connecting"}
        className="px-4 py-2 rounded-full theme-button-primary text-sm font-medium disabled:opacity-60"
      >
        {status === "connecting" ? "Connecting…" : "Connect Wallet"}
      </button>

      <Drawer.Root
        open={sheetOpen}
        onOpenChange={(o) => {
          if (!o) handleClose();
        }}
      >
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-60 bg-black/70 backdrop-blur-sm" />
          <Drawer.Content
            className="fixed bottom-0 left-0 right-0 z-70 rounded-t-[28px] theme-drawer border-t theme-border flex flex-col items-center overflow-hidden"
            style={{
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.5rem)",
            }}
          >
            <div
              className="absolute inset-x-0 top-0 h-px pointer-events-none"
              style={{
                background:
                  "linear-gradient(90deg, transparent, var(--color-bitcoin-border), var(--color-accent), transparent)",
                opacity: 0.5,
              }}
              aria-hidden="true"
            />

            <div className="pt-3 pb-5" aria-hidden="true">
              <div className="h-1.5 w-10 rounded-full theme-drawer-handle" />
            </div>

            <div className="flex flex-col items-center gap-5 px-6 w-full max-w-sm">
              <div className="relative">
                {!pairingUri && (
                  <div
                    className="absolute inset-0 rounded-full animate-ping opacity-25"
                    style={{ background: "var(--color-accent)" }}
                    aria-hidden="true"
                  />
                )}
                <div
                  className="relative h-16 w-16 rounded-full flex items-center justify-center"
                  style={{
                    background:
                      "linear-gradient(135deg, var(--color-accent-bg), var(--color-bitcoin-bg))",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
                  }}
                  aria-hidden="true"
                >
                  <svg
                    className="h-7 w-7 theme-text"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </svg>
                </div>
              </div>
              <div className="text-center">
                <Drawer.Title className="font-display text-[22px] tracking-wide theme-text">
                  Connect Wallet
                </Drawer.Title>
                <Drawer.Description className="mt-2 text-[12px] theme-text-muted leading-relaxed">
                  {IS_MOBILE_WEBVIEW
                    ? deepLinkFailed
                      ? "No wallet app responded. Scan this QR from another device, or copy the URI and paste it into your wallet."
                      : "Your wallet app should open automatically. If not, copy the URI or try again."
                    : "Scan this QR with MetaMask Mobile, Rainbow, or any WalletConnect-compatible wallet."}
                </Drawer.Description>
              </div>

              {pairingUri ? (
                <>
                  {(!IS_MOBILE_WEBVIEW || deepLinkFailed) && (
                    <div className="bg-white rounded-2xl p-4 shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
                      <QRCode value={pairingUri} size={220} />
                    </div>
                  )}

                  <div className="flex flex-col gap-2 w-full">
                    {IS_MOBILE_WEBVIEW && (
                      <button
                        type="button"
                        onClick={reopenWallet}
                        className="rounded-full theme-button-primary py-3 text-[14px] font-bold active:scale-[0.98] transition-transform"
                      >
                        Open Wallet App
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={copyUri}
                      className="rounded-full theme-card-elevated py-3 text-[13px] font-semibold theme-text active:scale-[0.98] transition-transform inline-flex items-center justify-center gap-2"
                    >
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                      Copy pairing URI
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 py-3">
                  <span
                    className="live-dot h-2 w-2 rounded-full"
                    style={{ background: "var(--color-accent)" }}
                    aria-hidden="true"
                  />
                  <p className="text-[12px] theme-text-muted uppercase tracking-[0.18em]">
                    Preparing pairing
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={handleClose}
                className="mt-1 text-[12px] theme-text-muted px-4 py-1.5 rounded-full"
              >
                Cancel
              </button>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}
