import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import Splashscreen from "../Splashscreen";

type BootStage = "splash" | "loading-wallet" | "wallet-error";

type WalletResult =
  | { status: "no-wallet" }
  | { status: "loaded" }
  | { status: "error"; message: string };

/** Kick off wallet check + load, return a promise with the result. */
function loadWalletAsync(): Promise<WalletResult> {
  return invoke<boolean>("has_wallet")
    .then((exists) => {
      if (!exists) return { status: "no-wallet" } as WalletResult;
      return invoke("load_wallet_local").then(
        () => ({ status: "loaded" }) as WalletResult,
        (error) => ({
          status: "error",
          message: typeof error === "string" ? error : "Failed to load wallet",
        }) as WalletResult,
      );
    })
    .catch((error) => ({
      status: "error",
      message: typeof error === "string" ? error : "Failed to check wallet status",
    }));
}

export function BootRoute() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<BootStage>("splash");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [resetting, setResetting] = useState(false);
  const walletResultRef = useRef<Promise<WalletResult> | null>(null);
  const splashDoneRef = useRef(false);

  // Kick off wallet loading on mount so it runs in parallel with the splash
  // animation. The promise is stashed in a ref so the effect below can await
  // it once the splash finishes — the ref is set synchronously before the
  // second effect runs within the same render cycle.
  useEffect(() => {
    walletResultRef.current = loadWalletAsync();
  }, []);

  // Once splash finishes (loadAttempt incremented by handleSplashFinished),
  // consume the pre-started wallet promise, or start a fresh one on retry.
  useEffect(() => {
    if (!splashDoneRef.current) return;

    let cancelled = false;
    const promise = walletResultRef.current ?? loadWalletAsync();
    walletResultRef.current = promise;

    promise.then((result) => {
      if (cancelled) return;
      if (result.status === "no-wallet") {
        void navigate({ to: "/onboarding", replace: true });
      } else if (result.status === "loaded") {
        void navigate({ to: "/dashboard", replace: true });
      } else {
        setWalletError(result.message);
        setStage("wallet-error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadAttempt, navigate]);

  const handleSplashFinished = useCallback(() => {
    splashDoneRef.current = true;
    setStage("loading-wallet");
    setLoadAttempt((count) => count + 1);
  }, []);

  const handleRetryLoad = useCallback(() => {
    setWalletError(null);
    setStage("loading-wallet");
    walletResultRef.current = loadWalletAsync();
    setLoadAttempt((count) => count + 1);
  }, []);

  const handleStartOver = useCallback(async () => {
    setResetting(true);
    try {
      await invoke("delete_wallet");
      void navigate({ to: "/onboarding", replace: true });
    } catch {
      setResetting(false);
    }
  }, [navigate]);

  if (stage === "splash") {
    return <Splashscreen onFinished={handleSplashFinished} />;
  }

  if (stage === "wallet-error") {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center theme-bg p-8 theme-text">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full theme-danger-bg">
          <svg className="h-6 w-6 theme-danger" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        <h1 className="mb-2 text-xl font-bold">Unable to Load Wallet</h1>
        <p className="mb-6 max-w-sm text-center text-sm theme-text-secondary">{walletError}</p>
        <div className="flex gap-3">
          <button
            onClick={handleRetryLoad}
            disabled={resetting}
            className="rounded-lg bg-lime-400 px-6 py-2.5 font-semibold text-gray-900 transition-colors hover:bg-lime-300 disabled:opacity-50"
          >
            Retry
          </button>
          <button
            onClick={handleStartOver}
            disabled={resetting}
            className="rounded-lg border border-white/20 px-6 py-2.5 font-semibold theme-text transition-colors theme-card disabled:opacity-50"
          >
            {resetting ? "Resetting..." : "Start Over"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center theme-bg theme-text">
      <svg className="mb-6 h-10 w-10 animate-spin text-lime-300" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <p className="text-sm theme-text-secondary">
        Unlocking wallet...
      </p>
    </div>
  );
}
