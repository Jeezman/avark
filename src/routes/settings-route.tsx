import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTheme } from "../context/ThemeContext";
import { PinSetupFlow, PinDisableFlow, usePinLock } from "../context/PinLockContext";
import { useFiat } from "../context/FiatContext";
import { useWallet } from "../context/WalletContext";
import { formatCacheTime } from "../utils/format";
import { EsploraSelector } from "../components/settings/EsploraSelector";
import { FiatTickerCard } from "../components/settings/FiatTickerCard";
import { NsecBackup } from "../components/settings/NsecBackup";
import { PackageBroadcastEndpoint } from "../components/settings/PackageBroadcastEndpoint";
import { SeedPhraseBackup } from "../components/settings/SeedPhraseBackup";

interface SettingsData {
  asp_url: string | null;
  network: string | null;
  esplora_url: string | null;
  submitpackage_url?: string | null;
  submitpackage_token_configured?: boolean;
  submitpackage_default_url?: string | null;
}

interface RecoveryCacheStatus {
  exists: boolean;
  generatedAt: number | null;
  network: string | null;
  branchCount: number;
  txCount: number;
  failedCount: number;
  lastError: string | null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function SettingsRoute() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const { connectionState } = useWallet();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { pinEnabled, refreshPinStatus } = usePinLock();
  const {
    enabled: fiatEnabled,
    currency: fiatCurrency,
    rate: fiatRate,
    status: fiatStatus,
    setEnabled: setFiatEnabled,
    setCurrency: setFiatCurrency,
    refreshRate: refreshFiatRate,
  } = useFiat();
  const [pinFlow, setPinFlow] = useState<"none" | "setup" | "disable">("none");
  const [maxAttempts, setMaxAttempts] = useState(10);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [recoveryCache, setRecoveryCache] = useState<RecoveryCacheStatus | null>(null);
  const [refreshingRecoveryCache, setRefreshingRecoveryCache] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await invoke<SettingsData>("settings");
      setSettings(data);
    } catch (e) {
      console.warn("Failed to load settings:", e);
      toast.warning("Could not load settings");
      setSettings({ asp_url: null, network: null, esplora_url: null });
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const fetchRecoveryCacheStatus = useCallback(async () => {
    try {
      const status = await invoke<RecoveryCacheStatus>("get_unilateral_exit_cache_status");
      setRecoveryCache(status);
    } catch (e) {
      console.warn("Failed to load recovery cache status:", e);
    }
  }, []);

  useEffect(() => {
    void fetchRecoveryCacheStatus();
  }, [fetchRecoveryCacheStatus]);

  useEffect(() => {
    invoke<{ max_attempts: number }>("get_pin_status")
      .then((s) => setMaxAttempts(s.max_attempts))
      .catch(() => {});
  }, [pinEnabled]);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const handleThemeToggle = (newTheme: "dark" | "light") => {
    setTheme(newTheme);
  };

  const handleDeleteWallet = async () => {
    setDeleting(true);
    try {
      await invoke("delete_wallet");
      toast.success("Wallet deleted");
      void navigate({ to: "/", replace: true });
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to delete wallet");
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleRefreshRecoveryCache = async () => {
    setRefreshingRecoveryCache(true);
    try {
      const status = await withTimeout(
        invoke<RecoveryCacheStatus>("refresh_unilateral_exit_cache"),
        330_000,
        "Recovery package refresh timed out. Try again when the ASP is responding.",
      );
      setRecoveryCache(status);
      if (status.exists && status.failedCount > 0) {
        toast.warning(`Recovery package partially refreshed; skipped ${status.failedCount} VTXO(s)`);
      } else if (status.exists) {
        toast.success("Recovery package refreshed");
      } else {
        toast.warning(
          status.lastError
            ? "ASP timed out while preparing recovery data"
            : "No recovery data was cached",
        );
      }
    } catch (e) {
      toast.error(typeof e === "string" ? e : "Failed to refresh recovery package");
    } finally {
      setRefreshingRecoveryCache(false);
    }
  };

  // PIN setup/disable flows render full-screen
  if (pinFlow === "setup") {
    return (
      <PinSetupFlow
        onComplete={() => { setPinFlow("none"); void refreshPinStatus(); }}
        onCancel={() => setPinFlow("none")}
      />
    );
  }
  if (pinFlow === "disable") {
    return (
      <PinDisableFlow
        onComplete={() => { setPinFlow("none"); void refreshPinStatus(); }}
        onCancel={() => setPinFlow("none")}
      />
    );
  }

  return (
    <main className="theme-text" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      {/* Header */}
      <div className="px-6 pt-4 pb-4">
        <h1 className="text-lg font-bold">Settings</h1>
      </div>

      {/* Appearance */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Appearance</h2>
        <div className="rounded-2xl theme-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">Theme</span>
            <div className="flex rounded-xl theme-card-elevated p-0.5">
              <button
                onClick={() => handleThemeToggle("dark")}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  theme === "dark" ? "theme-accent-bg" : "theme-text-muted"
                }`}
              >
                Dark
              </button>
              <button
                onClick={() => handleThemeToggle("light")}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  theme === "light" ? "theme-accent-bg" : "theme-text-muted"
                }`}
              >
                Light
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Currency */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Currency</h2>
        <FiatTickerCard
          enabled={fiatEnabled}
          onToggle={setFiatEnabled}
          currency={fiatCurrency}
          rate={fiatRate}
          status={fiatStatus}
          onRefresh={refreshFiatRate}
          onCurrencyChange={setFiatCurrency}
        />
      </div>

      {/* Security */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Security</h2>
        <div className="rounded-2xl theme-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm">PIN Lock</span>
            {pinEnabled ? (
              <button
                onClick={() => setPinFlow("disable")}
                className="rounded-lg px-3 py-1 text-xs font-medium theme-accent-bg"
              >
                Enabled
              </button>
            ) : (
              <button
                onClick={() => setPinFlow("setup")}
                className="rounded-lg px-3 py-1 text-xs font-medium theme-card-elevated theme-text-muted"
              >
                Disabled
              </button>
            )}
          </div>
          {pinEnabled && (
              <div className="flex items-center justify-between">
                <span className="text-sm">Max PIN attempts</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      const prev = maxAttempts;
                      const next = Math.max(3, maxAttempts - 1);
                      setMaxAttempts(next);
                      try {
                        await invoke("set_max_pin_attempts", { max_attempts: next });
                      } catch (e) {
                        setMaxAttempts(prev);
                        toast.error(typeof e === "string" ? e : "Failed to update");
                      }
                    }}
                    disabled={maxAttempts <= 3}
                    className="h-7 w-7 rounded-lg theme-card-elevated flex items-center justify-center text-sm font-bold disabled:opacity-30"
                    aria-label="Decrease max attempts"
                  >
                    -
                  </button>
                  <span className="text-sm font-semibold w-6 text-center tabular-nums">
                    {maxAttempts}
                  </span>
                  <button
                    onClick={async () => {
                      const prev = maxAttempts;
                      const next = Math.min(10, maxAttempts + 1);
                      setMaxAttempts(next);
                      try {
                        await invoke("set_max_pin_attempts", { max_attempts: next });
                      } catch (e) {
                        setMaxAttempts(prev);
                        toast.error(typeof e === "string" ? e : "Failed to update");
                      }
                    }}
                    disabled={maxAttempts >= 10}
                    className="h-7 w-7 rounded-lg theme-card-elevated flex items-center justify-center text-sm font-bold disabled:opacity-30"
                    aria-label="Increase max attempts"
                  >
                    +
                  </button>
                </div>
              </div>
          )}
        </div>
      </div>

      {/* Wallet */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Wallet</h2>
        <SeedPhraseBackup />
      </div>

      {/* Network */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Network</h2>
        <div className="rounded-2xl theme-card p-4 space-y-3">
          <div>
            <p className="text-xs theme-text-muted mb-0.5">ASP URL</p>
            <p className="text-sm font-mono break-all">{settings?.asp_url ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs theme-text-muted mb-0.5">Network</p>
            <p className="text-sm">{settings?.network ?? "—"}</p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                connectionState === "connected" ? "bg-lime-400" : "bg-yellow-400"
              }`}
            />
            <span className="text-xs theme-text-muted">
              {connectionState === "connected" ? "Connected" : "Offline"}
            </span>
          </div>
        </div>
        <EsploraSelector
          key={`esplora-${settings?.esplora_url ?? ""}`}
          network={settings?.network}
          initialUrl={settings?.esplora_url ?? ""}
        />
        
        <div className="rounded-2xl theme-card p-4 mt-3 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold theme-text">Emergency exit package</p>
              <p className="text-xs theme-text-muted mt-1">
                Cached locally for ASP-independent recovery.
              </p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                recoveryCache?.exists
                  ? "theme-accent-bg"
                  : "theme-warning-bg theme-warning"
              }`}
            >
              {recoveryCache?.exists ? "Ready" : "Missing"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="theme-text-muted mb-0.5">Last refreshed</p>
              <p className="theme-text">{formatCacheTime(recoveryCache?.generatedAt ?? null)}</p>
            </div>
            <div>
              <p className="theme-text-muted mb-0.5">Transactions</p>
              <p className="theme-text tabular-nums">{recoveryCache?.txCount ?? 0}</p>
            </div>
          </div>
          {(recoveryCache?.failedCount ?? 0) > 0 && (
            <p className="rounded-xl theme-warning-bg px-3 py-2 text-xs theme-warning">
              ASP timed out while preparing recovery data. No package was cached.
            </p>
          )}
          <button
            onClick={() => void handleRefreshRecoveryCache()}
            disabled={refreshingRecoveryCache || connectionState !== "connected"}
            className="w-full rounded-xl bg-lime-300 px-4 py-2.5 text-sm font-bold text-gray-900 transition-colors hover:bg-lime-200 disabled:opacity-40"
          >
            {refreshingRecoveryCache ? "Refreshing..." : "Refresh recovery package"}
          </button>
          <Link
            to="/recover/exit"
            aria-disabled={!recoveryCache?.exists}
            className={`block w-full rounded-xl theme-card-elevated px-4 py-2.5 text-center text-sm font-semibold theme-text transition-opacity ${
              recoveryCache?.exists ? "hover:opacity-80" : "pointer-events-none opacity-40"
            }`}
          >
            Broadcast emergency exit →
          </Link>
        </div>

        <PackageBroadcastEndpoint
          key={`submitpackage-${settings?.submitpackage_url ?? ""}`}
          configuredUrl={settings?.submitpackage_url ?? null}
          defaultUrl={settings?.submitpackage_default_url ?? null}
          tokenConfigured={settings?.submitpackage_token_configured ?? false}
          onSaved={() => void fetchSettings()}
        />
      </div>

      {/* Identity */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Identity</h2>
        <Link
          to="/profile"
          className="flex items-center justify-between rounded-2xl theme-card p-4 gap-3 mb-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold theme-text">Nostr profile</p>
            <p className="text-xs theme-text-muted leading-snug mt-0.5">
              Edit your display name, bio, and avatar.
            </p>
          </div>
          <svg
            className="h-4 w-4 shrink-0 theme-text-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </Link>

        <NsecBackup />
      </div>

      {/* Recovery */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">Recovery</h2>
        <Link
          to="/recover/ln"
          className="flex items-center justify-between rounded-2xl theme-card p-4 gap-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold theme-text">Stuck Lightning payments</p>
            <p className="text-xs theme-text-muted leading-snug mt-0.5">
              Inspect and refund submarine swaps that didn&rsquo;t settle.
            </p>
          </div>
          <svg
            className="h-4 w-4 shrink-0 theme-text-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </Link>
      </div>

      {/* About */}
      <div className="px-6 mb-6">
        <h2 className="text-xs font-semibold theme-text-muted uppercase tracking-wider mb-3">About</h2>
        <div className="rounded-2xl theme-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm theme-text-secondary">App</span>
            <span className="text-sm font-semibold">Avark</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm theme-text-secondary">Version</span>
            <span className="text-sm font-mono theme-text-muted">
              {appVersion ?? "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="px-6 pb-8">
        <h2 className="text-xs font-semibold theme-danger uppercase tracking-wider mb-3">Danger Zone</h2>
        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="w-full rounded-2xl theme-danger-bg border theme-border px-4 py-3 text-sm font-medium theme-danger hover:opacity-80 transition-colors"
          >
            Delete Wallet
          </button>
        ) : (
          <div className="rounded-2xl theme-danger-bg border theme-border p-4">
            <p className="text-sm theme-danger font-medium mb-1">Delete your wallet?</p>
            <p className="text-xs theme-text-muted mb-4">This cannot be undone. Make sure you have backed up your seed phrase.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="flex-1 rounded-xl theme-card-elevated py-2.5 text-sm font-medium theme-text-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteWallet()}
                disabled={deleting}
                className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
