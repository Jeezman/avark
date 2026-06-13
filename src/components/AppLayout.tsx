import { Link, Outlet } from "@tanstack/react-router";
import { BottomNav } from "./BottomNav";
import { WalletProvider, useWallet } from "../context/WalletContext";

function ConnectionGate() {
  const { connectionState, connectionError, connectWallet } = useWallet();

  if (connectionState === "connected" || connectionState === "offline") {
    return (
      <>
        <div style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 64px)" }}>
          {connectionState === "offline" && (
            <div
              className="sticky top-0 z-40 border-b theme-warning-border theme-warning-bg px-4 py-3"
              style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
            >
              <div className="mx-auto flex max-w-xl items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold theme-warning">ASP unreachable</p>
                  <p className="break-words text-xs theme-text-secondary">
                    {connectionError ?? "Wallet opened in offline mode."}
                  </p>
                </div>
                <Link
                  to="/recover/exit"
                  className="shrink-0 rounded-lg theme-card-elevated px-3 py-2 text-xs font-semibold theme-text active:scale-95 transition-transform"
                >
                  Emergency exit
                </Link>
                <button
                  className="shrink-0 rounded-lg bg-lime-300 px-3 py-2 text-xs font-bold text-gray-900 active:scale-95 transition-transform"
                  onClick={connectWallet}
                >
                  Retry
                </button>
              </div>
            </div>
          )}
          <Outlet />
        </div>
        <BottomNav />
      </>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 theme-text">
      {connectionState === "error" ? (
        <>
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
          <p className="mb-2 text-lg font-semibold">Connection Failed</p>
          <p className="mb-4 text-sm theme-text-muted">{connectionError}</p>
          <button
            className="rounded-xl bg-lime-300 px-6 py-2.5 text-sm font-bold text-gray-900 active:scale-95 transition-transform"
            onClick={connectWallet}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <svg
            className="mb-4 h-8 w-8 animate-spin text-lime-300"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <p className="text-sm theme-text-muted">
            {connectionState === "checking" && "Checking wallet..."}
            {connectionState === "connecting" && "Connecting to ASP..."}
            {connectionState === "loading" && "Loading wallet data..."}
          </p>
        </>
      )}
    </main>
  );
}

export function AppLayout() {
  return (
    <WalletProvider>
      <div className="min-h-screen theme-bg">
        <ConnectionGate />
      </div>
    </WalletProvider>
  );
}
