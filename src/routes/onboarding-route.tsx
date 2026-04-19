import { lazy, Suspense, useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import AspConfig from "../AspConfig";

const Onboarding = lazy(() => import("../Onboarding"));
const SeedBackup = lazy(() => import("../SeedBackup"));
const RestoreWallet = lazy(() => import("../RestoreWallet"));

type OnboardingStage =
  | { step: "intro" }
  | { step: "asp-config" }
  | { step: "creating-wallet" }
  | { step: "seed-backup"; mnemonic: string }
  | { step: "restore-mnemonic" };
type WalletChoice = "create" | "restore";

function CreatingWalletScreen() {
  return (
    <div className="w-screen min-h-screen flex flex-col items-center justify-center theme-bg theme-text">
      <svg
        className="mb-6 h-10 w-10 animate-spin text-lime-300"
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
      <h1 className="mb-2 text-xl font-bold">Creating Your Wallet</h1>
      <p className="text-sm theme-text-secondary">
        Generating keys and connecting to ASP...
      </p>
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

  const [restoring, setRestoring] = useState(false);

  const handleAspConnected = useCallback(async () => {
    if (walletChoice === "restore") {
      setStage({ step: "restore-mnemonic" });
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
  }, [walletChoice]);

  const handleRestore = useCallback(async (mnemonic: string) => {
    setRestoring(true);
    try {
      await invoke("restore_wallet", { mnemonic });
      void navigate({ to: "/dashboard", replace: true });
    } catch (error) {
      const message = typeof error === "string" ? error : "Failed to restore wallet";
      toast.error(message);
      setRestoring(false);
    }
  }, [navigate]);

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
    case "restore-mnemonic":
      return (
        <Suspense fallback={null}>
          <RestoreWallet onRestore={handleRestore} restoring={restoring} />
        </Suspense>
      );
  }
}
