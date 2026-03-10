import { useState, useCallback } from "react";

interface RestoreWalletProps {
  onRestore: (mnemonic: string) => void;
  restoring: boolean;
}

function RestoreWallet({ onRestore, restoring }: RestoreWalletProps) {
  const [words, setWords] = useState<string[]>(Array(12).fill(""));
  const [wordCount, setWordCount] = useState<12 | 24>(12);

  const handleWordChange = useCallback(
    (index: number, value: string) => {
      const trimmed = value.trim();
      const pastedWords = trimmed.split(/\s+/);

      if (pastedWords.length > 1) {
        // Full mnemonic paste: switch grid to match if exactly 12 or 24 words
        if (pastedWords.length === 12 || pastedWords.length === 24) {
          const count = pastedWords.length;
          setWordCount(count as 12 | 24);
          setWords(pastedWords.map((w) => w.toLowerCase()));
          return;
        }

        // Partial or mismatched paste: fill fields starting at the pasted index
        setWords((prev) => {
          const next = [...prev];
          for (let i = 0; i < pastedWords.length && index + i < next.length; i++) {
            next[index + i] = pastedWords[i].toLowerCase();
          }
          return next;
        });
        return;
      }

      setWords((prev) => {
        const next = [...prev];
        next[index] = value.toLowerCase().replace(/\s/g, "");
        return next;
      });
    },
    [],
  );

  const handleWordCountToggle = useCallback(() => {
    setWordCount((prev) => {
      const next = prev === 12 ? 24 : 12;
      setWords((w) => {
        if (next > w.length) return [...w, ...Array(next - w.length).fill("")];
        return w.slice(0, next);
      });
      return next;
    });
  }, []);

  const filledCount = words.filter((w) => w.length > 0).length;
  const allFilled = filledCount === wordCount;

  const handleSubmit = useCallback(() => {
    if (!allFilled || restoring) return;
    onRestore(words.join(" "));
  }, [allFilled, restoring, words, onRestore]);

  return (
    <div className="fixed inset-0 flex flex-col bg-gradient-to-br from-gray-900 to-gray-800 text-white">
      <div className="flex-1 flex flex-col items-center px-6 overflow-y-auto" style={{ paddingTop: "calc(env(safe-area-inset-top, 16px) + 16px)" }}>
        <div className="w-16 h-16 mb-4 rounded-2xl bg-white/10 flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-8 h-8 text-lime-300" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold mb-2">Restore Your Wallet</h1>
        <p className="text-white/60 text-center mb-4 max-w-xs text-sm">
          Enter your {wordCount}-word seed phrase to recover your wallet.
        </p>

        <button
          onClick={handleWordCountToggle}
          className="mb-4 px-4 py-1.5 rounded-full bg-white/10 text-white/70 text-xs font-medium hover:bg-white/15 transition-colors"
        >
          Switch to {wordCount === 12 ? 24 : 12} words
        </button>

        <div className={`w-full max-w-sm grid grid-cols-3 gap-2 mb-6 ${wordCount === 24 ? "grid-rows-8" : "grid-rows-4"}`}>
          {words.map((word, i) => (
            <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/10">
              <span className="text-white/40 font-mono text-xs w-5 text-right shrink-0">
                {i + 1}
              </span>
              <input
                type="text"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                value={word}
                onChange={(e) => handleWordChange(i, e.target.value)}
                className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-white/20"
                placeholder="..."
                disabled={restoring}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="px-6 pb-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 12px) + 16px)" }}>
        <p className="text-white/40 text-xs text-center mb-3">
          {filledCount} of {wordCount} words entered
        </p>
        <button
          onClick={handleSubmit}
          disabled={!allFilled || restoring}
          className="w-full py-4 rounded-2xl bg-lime-300 text-gray-900 text-lg font-bold shadow-lg active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100"
        >
          {restoring ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Restoring...
            </span>
          ) : (
            "Restore Wallet"
          )}
        </button>
      </div>
    </div>
  );
}

export default RestoreWallet;
