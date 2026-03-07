import { useState, useEffect } from "react";

function Splashscreen({ onFinished }: { onFinished: () => void }) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), 3000);
    const removeTimer = setTimeout(() => onFinished(), 3400);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, [onFinished]);

  return (
    <div
      className={`fixed inset-0 z-9999 flex flex-col items-center justify-center bg-[#F7931A] overflow-hidden touch-none transition-opacity duration-400 ease-out ${fading ? "opacity-0 pointer-events-none" : "opacity-100"}`}
    >
      <svg
        className="w-40 h-40"
        viewBox="0 0 200 200"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Anteater silhouette */}
        <ellipse cx="100" cy="120" rx="50" ry="35" fill="#fff" />
        {/* Head */}
        <ellipse cx="60" cy="105" rx="22" ry="18" fill="#fff" />
        {/* Long snout */}
        <path
          d="M38 105 Q20 100 8 95 Q6 94 8 93 Q22 90 40 98"
          fill="#fff"
        />
        {/* Eye */}
        <circle cx="55" cy="100" r="3" fill="#F7931A" />
        {/* Ear */}
        <ellipse cx="68" cy="88" rx="8" ry="12" fill="#fff" />
        <ellipse cx="68" cy="90" rx="5" ry="8" fill="#F7931A" />
        {/* Tail */}
        <path
          d="M150 115 Q170 90 165 60 Q164 55 167 58 Q178 75 160 115"
          fill="#fff"
        />
        {/* Legs */}
        <rect x="75" y="145" width="10" height="25" rx="4" fill="#fff" />
        <rect x="95" y="145" width="10" height="25" rx="4" fill="#fff" />
        <rect x="115" y="145" width="10" height="25" rx="4" fill="#fff" />
        <rect x="130" y="142" width="10" height="25" rx="4" fill="#fff" />
        {/* Body stripes */}
        <path d="M80 108 Q100 100 120 108" stroke="#F7931A" strokeWidth="3" fill="none" opacity="0.4" />
        <path d="M75 118 Q100 110 125 118" stroke="#F7931A" strokeWidth="3" fill="none" opacity="0.3" />
        <path d="M78 128 Q100 120 122 128" stroke="#F7931A" strokeWidth="3" fill="none" opacity="0.2" />
      </svg>
      <h1 className="mt-4 font-['Righteous',cursive] text-[2.8rem] text-white tracking-wider drop-shadow-[0_2px_8px_rgba(0,0,0,0.15)]">
        Avark
      </h1>
    </div>
  );
}

export default Splashscreen;
