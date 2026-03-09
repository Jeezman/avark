import { useState } from "react";

interface SeedBackupProps {
  mnemonic: string;
  onDone: () => void;
}

function SeedBackup({ mnemonic, onDone }: SeedBackupProps) {
  const [revealed, setRevealed] = useState(false);
  const words = mnemonic.split(" ");

  return (
    <div className="fixed inset-0 flex flex-col bg-gradient-to-br from-gray-900 to-gray-800 text-white">
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <div className="w-16 h-16 mb-6 rounded-2xl bg-white/10 flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="w-8 h-8 text-lime-300" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold mb-2">Back Up Your Seed Phrase</h1>
        <p className="text-white/60 text-center mb-6 max-w-xs text-sm">
          Write down these {words.length} words in order. They are the only way to recover your wallet.
        </p>

        {revealed ? (
          <div className="w-full max-w-sm grid grid-cols-3 gap-2 mb-8">
            {words.map((word, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-sm"
              >
                <span className="text-white/40 font-mono text-xs w-5 text-right">{i + 1}</span>
                <span className="font-medium">{word}</span>
              </div>
            ))}
          </div>
        ) : (
          <button
            onClick={() => setRevealed(true)}
            className="w-full max-w-sm py-4 rounded-2xl border-2 border-dashed border-white/20 text-white/60 text-sm hover:border-lime-300/40 hover:text-white/80 transition-colors mb-8"
          >
            Tap to reveal seed phrase
          </button>
        )}

        <div className="w-full max-w-sm space-y-3">
          {revealed && (
            <p className="text-amber-400/80 text-xs text-center">
              Never share your seed phrase. Anyone with these words can steal your funds.
            </p>
          )}
          <button
            onClick={onDone}
            className="w-full py-4 rounded-2xl bg-lime-300 text-gray-900 text-lg font-bold shadow-lg active:scale-95 transition-transform"
          >
            {revealed ? "I've Saved My Seed Phrase" : "Back Up Later"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SeedBackup;
