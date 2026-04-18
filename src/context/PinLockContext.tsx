import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { PinPad } from '../components/PinPad';
import { toast } from 'sonner';

interface PinStatus {
  enabled: boolean;
  max_attempts: number;
  attempts_remaining: number;
  locked: boolean;
}

interface VerifyPinResult {
  valid: boolean;
  attempts_remaining: number;
  locked: boolean;
  retry_after_secs: number;
}

interface PinLockContextValue {
  locked: boolean;
  pinEnabled: boolean;
  refreshPinStatus: () => Promise<void>;
}

const PinLockContext = createContext<PinLockContextValue>({
  locked: false,
  pinEnabled: false,
  refreshPinStatus: async () => {},
});

export function usePinLock() {
  return useContext(PinLockContext);
}

// ── Lock Screen ────────────────────────────────────────────────────────

function LockScreen({
  onUnlock,
  onWipe,
}: {
  onUnlock: () => void;
  onWipe: () => void;
}) {
  const [error, setError] = useState<string | undefined>();
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | undefined>();
  const [maxAttempts, setMaxAttempts] = useState<number | undefined>();
  const [isLocked, setIsLocked] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [mnemonicInput, setMnemonicInput] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | undefined>();
  const [showWipe, setShowWipe] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState('');
  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState<string | undefined>();

  // Countdown timer for cooldown
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    invoke<PinStatus>('get_pin_status').then((s) => {
      setAttemptsRemaining(s.attempts_remaining);
      setMaxAttempts(s.max_attempts);
      if (s.locked) setIsLocked(true);
    }).catch(() => {});
  }, []);

  const handlePinComplete = useCallback(async (pin: string) => {
    if (cooldown > 0) return;
    try {
      const result = await invoke<VerifyPinResult>('verify_pin', { pin });
      if (result.valid) {
        onUnlock();
      } else {
        setAttemptsRemaining(result.attempts_remaining);
        if (result.locked) {
          setIsLocked(true);
        } else {
          if (result.retry_after_secs > 0) {
            setCooldown(result.retry_after_secs);
          }
          setError(`Wrong PIN — ${result.attempts_remaining} ${result.attempts_remaining === 1 ? 'attempt' : 'attempts'} left`);
        }
      }
    } catch (e) {
      setError(String(e));
    }
  }, [onUnlock, cooldown]);

  const handleRecovery = useCallback(async () => {
    const trimmed = mnemonicInput.trim();
    if (!trimmed) return;

    setRecovering(true);
    setRecoveryError(undefined);
    try {
      const valid = await invoke<boolean>('verify_mnemonic', { mnemonic: trimmed });
      if (valid) {
        await invoke('clear_pin');
        toast.success('PIN cleared — wallet unlocked');
        onUnlock();
      } else {
        setRecoveryError('Seed phrase does not match');
      }
    } catch (e) {
      setRecoveryError(String(e));
    } finally {
      setRecovering(false);
    }
  }, [mnemonicInput, onUnlock]);

  // Last-resort escape hatch for users who've genuinely lost their seed
  // phrase. Deletes the wallet and clears the PIN. They don't recover the
  // original funds — that's the self-custody contract — but they get the
  // app back to onboard a fresh wallet. Gated by a typed "WIPE" confirmation
  // so it's not a one-tap mistake.
  const handleWipe = useCallback(async () => {
    if (wipeConfirm.trim().toUpperCase() !== 'WIPE') return;
    setWiping(true);
    setWipeError(undefined);
    try {
      await invoke('delete_wallet');
      await invoke('clear_pin');
      toast.success('Wallet wiped — starting fresh');
      onWipe();
    } catch (e) {
      setWipeError(String(e));
      setWiping(false);
    }
  }, [wipeConfirm, onWipe]);

  // Lockout screen — seed-phrase recovery, with an escape hatch for the
  // user who's genuinely lost their 12 words.
  if (isLocked) {
    if (showWipe) {
      const confirmed = wipeConfirm.trim().toUpperCase() === 'WIPE';
      return (
        <div className="flex flex-col items-center justify-center min-h-screen theme-bg theme-text px-6 py-10">
          <div className="mb-6 rounded-full p-4" style={{ background: 'rgba(248,113,113,0.15)' }}>
            <svg className="h-12 w-12 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h1 className="text-xl font-bold mb-2">Wipe this wallet?</h1>
          <div className="max-w-sm text-sm theme-text-muted text-center space-y-3 mb-6">
            <p>
              Without your seed phrase, the Bitcoin in this wallet can't be recovered — on this device or any other. Avark never had a copy, and can't restore it. That's what self-custody means.
            </p>
            <p>
              If you have the 12 words written down anywhere, keep looking. If they're truly gone, you can wipe this wallet and start fresh. You won't recover the old funds.
            </p>
          </div>

          <div className="w-full max-w-sm">
            <label className="block text-xs theme-text-muted mb-2">
              Type <span className="font-mono font-bold theme-text">WIPE</span> to confirm
            </label>
            <input
              value={wipeConfirm}
              onChange={(e) => setWipeConfirm(e.target.value)}
              placeholder="WIPE"
              disabled={wiping}
              className="w-full rounded-xl theme-input px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-red-400/50 font-mono uppercase disabled:opacity-60"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            {wipeError && (
              <p className="text-xs text-red-400 mt-2">{wipeError}</p>
            )}
            <button
              onClick={() => void handleWipe()}
              disabled={wiping || !confirmed}
              className="w-full mt-4 rounded-xl py-3 text-sm font-bold text-white active:scale-95 transition-transform disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #f87171, #dc2626)' }}
            >
              {wiping ? 'Wiping...' : 'Wipe wallet and start over'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowWipe(false);
                setWipeConfirm('');
                setWipeError(undefined);
              }}
              disabled={wiping}
              className="w-full mt-4 text-xs theme-text-muted hover:theme-text transition-colors disabled:opacity-40"
            >
              ← Back to seed phrase recovery
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center min-h-screen theme-bg theme-text px-6">
        <div className="mb-6 rounded-full p-4" style={{ background: 'rgba(248,113,113,0.15)' }}>
          <svg className="h-12 w-12 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </div>
        <h1 className="text-xl font-bold mb-2">Wallet Locked</h1>
        <p className="text-sm theme-text-muted text-center mb-8">
          Too many incorrect PIN attempts. Enter your seed phrase to recover access.
        </p>

        <div className="w-full max-w-sm">
          <textarea
            value={mnemonicInput}
            onChange={(e) => setMnemonicInput(e.target.value)}
            placeholder="Enter your 12 or 24 word seed phrase"
            rows={3}
            className="w-full rounded-xl theme-input px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-lime-300/50 resize-none font-mono"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
          />
          {recoveryError && (
            <p className="text-xs text-red-400 mt-2">{recoveryError}</p>
          )}
          <button
            onClick={() => void handleRecovery()}
            disabled={recovering || !mnemonicInput.trim()}
            className="w-full mt-4 rounded-xl py-3 text-sm font-bold text-gray-900 active:scale-95 transition-transform disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #bef264, #84cc16)' }}
          >
            {recovering ? 'Verifying...' : 'Recover with seed phrase'}
          </button>
          <button
            type="button"
            onClick={() => setShowWipe(true)}
            className="w-full mt-4 text-xs theme-text-muted hover:theme-text transition-colors underline underline-offset-4"
          >
            I don't have my seed phrase
          </button>
        </div>
      </div>
    );
  }

  // PIN entry screen
  return (
    <PinPad
      title="Enter PIN"
      subtitle={cooldown > 0 ? `Wait ${cooldown}s before trying again` : "Enter your 4-digit PIN to unlock"}
      error={error}
      disabled={cooldown > 0}
      onComplete={handlePinComplete}
      attemptsRemaining={attemptsRemaining}
      maxAttempts={maxAttempts}
    />
  );
}

// ── PIN Setup Flow ─────────────────────────────────────────────────────

const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '0123', '3210', '1234', '4321', '6969', '9876', '8765', '5432',
  '2580', '0852', '1112', '1212', '1236',
  '1999', '1998', '2000', '2001', '1313',
]);

function isWeakPin(pin: string): string | null {
  if (WEAK_PINS.has(pin)) return 'This is a commonly guessed PIN';
  const digits = pin.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return 'Sequential digits are easy to guess';
  return null;
}

export function PinSetupFlow({ onComplete, onCancel }: { onComplete: () => void; onCancel: () => void }) {
  const [step, setStep] = useState<'create' | 'confirm'>('create');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [weakWarning, setWeakWarning] = useState<string | null>(null);
  const [weakConfirmed, setWeakConfirmed] = useState(false);
  const [pendingPin, setPendingPin] = useState('');

  const handleCreate = useCallback((pin: string) => {
    const weak = isWeakPin(pin);
    if (weak && !weakConfirmed) {
      setWeakWarning(weak);
      setPendingPin(pin);
      return;
    }
    setWeakWarning(null);
    setPendingPin('');
    setFirstPin(pin);
    setStep('confirm');
    setError(undefined);
  }, [weakConfirmed]);

  const handleConfirm = useCallback(async (pin: string) => {
    if (pin !== firstPin) {
      setError("PINs don't match — try again");
      setStep('create');
      setFirstPin('');
      return;
    }
    try {
      await invoke('set_pin', { pin });
      toast.success('PIN enabled');
      onComplete();
    } catch (e) {
      setError(String(e));
      setStep('create');
      setFirstPin('');
    }
  }, [firstPin, onComplete]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  if (weakWarning) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen theme-bg theme-text px-6">
        <div className="mb-4 rounded-full p-4" style={{ background: 'rgba(253,224,71,0.15)' }}>
          <svg className="h-10 w-10 text-yellow-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h2 className="text-lg font-bold mb-2">Weak PIN</h2>
        <p className="text-sm theme-text-muted text-center mb-8">{weakWarning}</p>
        <div className="w-full max-w-xs space-y-3">
          <button
            onClick={() => {
              setWeakWarning(null);
              setWeakConfirmed(true);
              setFirstPin(pendingPin);
              setPendingPin('');
              setStep('confirm');
            }}
            className="w-full rounded-xl py-3 text-sm font-medium theme-card-elevated theme-text hover:opacity-80 transition-opacity"
          >
            Use anyway
          </button>
          <button
            onClick={() => {
              setWeakWarning(null);
              setPendingPin('');
            }}
            className="w-full rounded-xl py-3 text-sm font-bold text-gray-900 active:scale-95 transition-transform"
            style={{ background: 'linear-gradient(135deg, #bef264, #84cc16)' }}
          >
            Choose a different PIN
          </button>
        </div>
      </div>
    );
  }

  if (step === 'create') {
    return <PinPad key="create" title="Create a PIN" subtitle="Choose a 4-digit PIN" error={error} onComplete={handleCreate} />;
  }

  return <PinPad key="confirm" title="Confirm PIN" subtitle="Re-enter your PIN" onComplete={handleConfirm} />;
}

// Disable PIN flow — requires entering current PIN first
export function PinDisableFlow({ onComplete, onCancel }: { onComplete: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | undefined>();

  const handleVerify = useCallback(async (pin: string) => {
    try {
      const result = await invoke<VerifyPinResult>('verify_pin', { pin });
      if (result.valid) {
        await invoke('clear_pin');
        toast.success('PIN disabled');
        onComplete();
      } else {
        setError(`Wrong PIN — ${result.attempts_remaining} attempts left`);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [onComplete]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return <PinPad title="Enter current PIN" subtitle="Verify to disable PIN lock" error={error} onComplete={handleVerify} />;
}

// ── Provider ───────────────────────────────────────────────────────────

export function PinLockProvider({ children }: { children: React.ReactNode }) {
  const [locked, setLocked] = useState(true);
  const [pinEnabled, setPinEnabled] = useState(false);
  const [checking, setChecking] = useState(true);
  const backgroundTime = useRef<number | null>(null);

  const refreshPinStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await invoke<PinStatus>('get_pin_status');
      setPinEnabled(status.enabled);
    } catch {
      setPinEnabled(false);
    }
  }, []);

  // Check PIN status on mount
  useEffect(() => {
    invoke<PinStatus>('get_pin_status')
      .then((status) => {
        setPinEnabled(status.enabled);
        if (!status.enabled) setLocked(false);
      })
      .catch(() => setLocked(false))
      .finally(() => setChecking(false));
  }, []);

  // Background timeout detection
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        backgroundTime.current = Date.now();
      } else {
        if (backgroundTime.current) {
          const elapsed = Date.now() - backgroundTime.current;
          backgroundTime.current = null;
          if (elapsed > 60_000 && pinEnabled) {
            setLocked(true);
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [pinEnabled]);

  const handleUnlock = useCallback(() => {
    setLocked(false);
  }, []);

  // Wallet has been wiped — drop both gates so the background timer doesn't
  // immediately re-lock on visibility change (pinEnabled stays true until the
  // provider remounts otherwise). The boot route picks up no-wallet and
  // redirects to /onboarding once the router takes over.
  const handleWipe = useCallback(() => {
    setPinEnabled(false);
    setLocked(false);
  }, []);

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-screen theme-bg">
        <svg className="h-8 w-8 animate-spin text-lime-300" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (locked && pinEnabled) {
    return <LockScreen onUnlock={handleUnlock} onWipe={handleWipe} />;
  }

  return (
    <PinLockContext.Provider value={{ locked, pinEnabled, refreshPinStatus }}>
      {children}
    </PinLockContext.Provider>
  );
}
