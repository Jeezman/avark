import { useCallback, useEffect, useRef, useState } from 'react';

interface PinPadProps {
  title: string;
  subtitle?: string;
  error?: string;
  onComplete: (pin: string) => void;
  attemptsRemaining?: number;
  maxAttempts?: number;
  disabled?: boolean;
}

export function PinPad({ title, subtitle, error, onComplete, attemptsRemaining, maxAttempts, disabled }: PinPadProps) {
  const [digits, setDigits] = useState<string[]>([]);
  const [shaking, setShaking] = useState(false);
  const prevError = useRef(error);

  // Trigger shake on new error
  useEffect(() => {
    if (error && error !== prevError.current) {
      setShaking(true);
      setDigits([]);
      const t = setTimeout(() => setShaking(false), 500);
      return () => clearTimeout(t);
    }
    prevError.current = error;
  }, [error]);

  const handleDigit = useCallback((d: string) => {
    if (disabled) return;
    setDigits((prev) => {
      if (prev.length >= 4) return prev;
      return [...prev, d];
    });
  }, [disabled]);

  // Trigger onComplete when 4 digits are entered, outside the state updater
  // to avoid double-firing in React strict mode
  useEffect(() => {
    if (digits.length === 4) {
      // Brief delay so the 4th dot visually fills before verification starts
      const t = setTimeout(() => onComplete(digits.join('')), 100);
      return () => clearTimeout(t);
    }
  }, [digits, onComplete]);

  const handleDelete = useCallback(() => {
    setDigits((prev) => prev.slice(0, -1));
  }, []);

  // Keyboard support
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) handleDigit(e.key);
      if (e.key === 'Backspace') handleDelete();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleDigit, handleDelete]);

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  return (
    <div className="flex flex-col items-center justify-center min-h-screen theme-bg theme-text px-6">
      <div className="mb-8 text-center">
        <h1 className="text-xl font-bold mb-1">{title}</h1>
        {subtitle && <p className="text-sm theme-text-muted">{subtitle}</p>}
      </div>

      {/* Dot indicators */}
      <div
        className={`flex gap-4 mb-3 ${shaking ? 'animate-shake' : ''}`}
      >
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-4 w-4 rounded-full border-2 transition-all duration-150 ${
              i < digits.length
                ? 'bg-lime-400 border-lime-400 scale-110'
                : 'border-white/30'
            }`}
          />
        ))}
      </div>

      {/* Error / attempts remaining */}
      <div className="h-6 mb-6">
        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}
        {!error && attemptsRemaining !== undefined && maxAttempts !== undefined && attemptsRemaining < maxAttempts && (
          <p className="text-xs theme-text-muted">
            {attemptsRemaining} {attemptsRemaining === 1 ? 'attempt' : 'attempts'} remaining
          </p>
        )}
      </div>

      {/* Numeric keypad */}
      <div className={`grid grid-cols-3 gap-3 w-full max-w-[280px] transition-opacity ${disabled ? 'opacity-30 pointer-events-none' : ''}`}>
        {keys.map((key) => {
          if (key === '') return <div key="empty" />;
          if (key === 'del') {
            return (
              <button
                key="del"
                onClick={handleDelete}
                className="h-16 rounded-2xl flex items-center justify-center theme-text-muted active:opacity-50 transition-opacity"
                aria-label="Delete"
              >
                <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" />
                  <line x1="18" y1="9" x2="12" y2="15" />
                  <line x1="12" y1="9" x2="18" y2="15" />
                </svg>
              </button>
            );
          }
          return (
            <button
              key={key}
              onClick={() => handleDigit(key)}
              className="h-16 rounded-2xl text-2xl font-semibold theme-text transition-all active:scale-90"
              style={{ background: 'rgba(255,255,255,0.05)' }}
            >
              {key}
            </button>
          );
        })}
      </div>
    </div>
  );
}
