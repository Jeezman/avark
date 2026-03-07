import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Toaster } from "sonner";
import Splashscreen from "./Splashscreen";
import AspConfig from "./AspConfig";
import "./App.css";

const Onboarding = lazy(() => import("./Onboarding"));

type Screen = "splash" | "loading" | "onboarding" | "asp-config" | "dashboard";
type WalletChoice = "create" | "restore";

function App() {
  const [screen, setScreen] = useState<Screen>("splash");
  const [walletChoice, setWalletChoice] = useState<WalletChoice>("create");

  useEffect(() => {
    if (screen !== "loading") return;
    invoke<boolean>("has_wallet")
      .then((exists) => {
        setScreen(exists ? "dashboard" : "onboarding");
      })
      .catch(() => {
        setScreen("onboarding");
      });
  }, [screen]);

  const handleSplashFinished = useCallback(() => setScreen("loading"), []);

  const handleWalletChoice = useCallback((choice: WalletChoice) => {
    invoke("set_onboarding_seen").catch(() => {});
    setWalletChoice(choice);
    setScreen("asp-config");
  }, []);

  const handleAspConnected = useCallback(() => {
    // TODO: US-004 (create) and US-006 (restore) will use walletChoice
    console.log(`ASP connected, wallet choice: ${walletChoice}`);
    setScreen("dashboard");
  }, [walletChoice]);

  let content;
  if (screen === "splash") {
    content = <Splashscreen onFinished={handleSplashFinished} />;
  } else if (screen === "loading") {
    content = null;
  } else if (screen === "onboarding") {
    content = (
      <Suspense fallback={null}>
        <Onboarding onWalletChoice={handleWalletChoice} />
      </Suspense>
    );
  } else if (screen === "asp-config") {
    content = <AspConfig onConnected={handleAspConnected} />;
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
