import { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast, Toaster } from "sonner";
import Splashscreen from "./Splashscreen";
import AspConfig from "./AspConfig";
import "./App.css";

const Onboarding = lazy(() => import("./Onboarding"));

type Screen = "splash" | "loading" | "loading-wallet" | "wallet-error" | "onboarding" | "asp-config" | "creating-wallet" | "dashboard";
type WalletChoice = "create" | "restore";

function CreatingWalletScreen() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 text-white">
      <svg className="w-10 h-10 animate-spin text-lime-300 mb-6" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <h1 className="text-xl font-bold mb-2">Creating Your Wallet</h1>
      <p className="text-white/60 text-sm">Generating keys and connecting to ASP...</p>
    </div>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("splash");
  const [walletChoice, setWalletChoice] = useState<WalletChoice>("create");
  const [walletError, setWalletError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (loadAttempt === 0) return;
    setScreen("loading");
    invoke<boolean>("has_wallet")
      .then((exists) => {
        if (exists) {
          setScreen("loading-wallet");
          invoke("load_wallet")
            .then(() => setScreen("dashboard"))
            .catch((e) => {
              const message = typeof e === "string" ? e : "Failed to load wallet";
              setWalletError(message);
              setScreen("wallet-error");
            });
        } else {
          setScreen("onboarding");
        }
      })
      .catch(() => {
        setScreen("onboarding");
      });
  }, [loadAttempt]);

  const handleSplashFinished = useCallback(() => setLoadAttempt((n) => n + 1), []);

  const handleRetryLoad = useCallback(() => {
    setWalletError(null);
    setLoadAttempt((n) => n + 1);
  }, []);

  const handleWalletChoice = useCallback((choice: WalletChoice) => {
    invoke("set_onboarding_seen").catch(() => {});
    setWalletChoice(choice);
    setScreen("asp-config");
  }, []);

  const handleAspConnected = useCallback(async () => {
    if (walletChoice !== "create") {
      // TODO: US-006 restore flow
      setScreen("dashboard");
      return;
    }

    setScreen("creating-wallet");
    try {
      await invoke<{ mnemonic: string }>("create_wallet");
      setScreen("dashboard");
    } catch (e) {
      const message = typeof e === "string" ? e : "Failed to create wallet";
      toast.error(message);
      setScreen("asp-config");
    }
  }, [walletChoice]);

  let content;
  if (screen === "splash") {
    content = <Splashscreen onFinished={handleSplashFinished} />;
  } else if (screen === "loading" || screen === "loading-wallet") {
    content = (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 text-white">
        <svg className="w-10 h-10 animate-spin text-lime-300 mb-6" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-white/60 text-sm">Loading wallet...</p>
      </div>
    );
  } else if (screen === "wallet-error") {
    content = (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 text-white p-8">
        <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mb-6">
          <svg className="w-6 h-6 text-red-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
          </svg>
        </div>
        <h1 className="text-xl font-bold mb-2">Unable to Load Wallet</h1>
        <p className="text-white/60 text-sm text-center mb-6 max-w-sm">{walletError}</p>
        <button
          onClick={handleRetryLoad}
          className="px-6 py-2.5 bg-lime-400 text-gray-900 font-semibold rounded-lg hover:bg-lime-300 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  } else if (screen === "onboarding") {
    content = (
      <Suspense fallback={null}>
        <Onboarding onWalletChoice={handleWalletChoice} />
      </Suspense>
    );
  } else if (screen === "asp-config") {
    content = <AspConfig onConnected={handleAspConnected} />;
  } else if (screen === "creating-wallet") {
    content = <CreatingWalletScreen />;
  } else {
    content = (
      <main className="flex flex-col items-center justify-center min-h-screen p-8">
        <h1 className="text-2xl font-bold mb-4">Dashboard</h1>
        <p className="text-gray-500">Wallet loaded. Dashboard coming in US-007.</p>
      </main>
    );
  }

  return (
    <>
      <Toaster theme="dark" position="top-center" richColors style={{ top: "env(safe-area-inset-top, 0px)" }} />
      {content}
    </>
  );
}

export default App;
