import { lazy, Suspense, useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import AspConfig from "../AspConfig";

const Onboarding = lazy(() => import("../Onboarding"));
const SeedBackup = lazy(() => import("../SeedBackup"));

type OnboardingStage =
  | { step: "intro" }
  | { step: "asp-config" }
  | { step: "creating-wallet" }
  | { step: "seed-backup"; mnemonic: string };
type WalletChoice = "create" | "restore";

function CreatingWalletScreen() {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 text-white">
      <svg className="mb-6 h-10 w-10 animate-spin text-lime-300" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <h1 className="mb-2 text-xl font-bold">Creating Your Wallet</h1>
      <p className="text-sm text-white/60">Generating keys and connecting to ASP...</p>
    </div>
  );
}

export function OnboardingRoute() {
  const navigate = useNavigate();
  const [stage, setStage] = useState<OnboardingStage>({ step: "intro" });
  const [walletChoice, setWalletChoice] = useState<WalletChoice>("create");

  const handleWalletChoice = useCallback((choice: WalletChoice) => {
    invoke("set_onboarding_seen").catch(() => {});
    setWalletChoice(choice);
    setStage({ step: "asp-config" });
  }, []);

  const handleAspConnected = useCallback(async () => {
    if (walletChoice !== "create") {
      void navigate({ to: "/dashboard", replace: true });
      return;
    }

    setStage({ step: "creating-wallet" });

    try {
      const result = await invoke<{ mnemonic: string }>("create_wallet");
      setStage({ step: "seed-backup", mnemonic: result.mnemonic });
    } catch (error) {
      const message = typeof error === "string" ? error : "Failed to create wallet";
      toast.error(message);
      setStage({ step: "asp-config" });
    }
  }, [navigate, walletChoice]);

  switch (stage.step) {
    case "intro":
      return (
        <Suspense fallback={null}>
          <Onboarding onWalletChoice={handleWalletChoice} />
        </Suspense>
      );
    case "asp-config":
      return <AspConfig onConnected={handleAspConnected} />;
    case "creating-wallet":
      return <CreatingWalletScreen />;
    case "seed-backup":
      return (
        <Suspense fallback={<CreatingWalletScreen />}>
          <SeedBackup
            mnemonic={stage.mnemonic}
            onDone={() => void navigate({ to: "/dashboard", replace: true })}
          />
        </Suspense>
      );
  }
}
