import { useState, useRef, useCallback } from "react";

const slides = [
  {
    title: "Welcome to Avark",
    description:
      "Your Bitcoin wallet powered by Ark. Fast, private, and always in your control.",
    gradient: "from-orange-400 via-rose-400 to-pink-400",
    illustration: SlideOneIllustration,
  },
  {
    title: "Instant Transfers",
    description:
      "Send Bitcoin in seconds with the Ark protocol. No more waiting for confirmations.",
    gradient: "from-teal-400 via-emerald-400 to-cyan-500",
    illustration: SlideTwoIllustration,
  },
  {
    title: "Send & Receive",
    description:
      "Easily send sats to anyone or receive Bitcoin from any wallet. It just works.",
    gradient: "from-violet-500 via-purple-500 to-blue-500",
    illustration: SlideThreeIllustration,
  },
  {
    title: "Get Started",
    description:
      "Set up your wallet in seconds and start using Bitcoin the way it was meant to be.",
    gradient: "from-purple-400 via-violet-300 to-emerald-200",
    illustration: SlideFourIllustration,
  },
];

function Onboarding({ onFinished }: { onFinished: () => void }) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [offsetX, setOffsetX] = useState(0);
  const [animate, setAnimate] = useState(false);
  const transitioning = useRef(false);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  const goTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= slides.length || transitioning.current) return;
      const direction = index > currentSlide ? -1 : 1;
      transitioning.current = true;
      // Phase 1: animate current content out
      setAnimate(true);
      setOffsetX(direction * 100);
      setTimeout(() => {
        // Phase 2: swap content, jump to opposite side (no animation), then animate in
        setAnimate(false);
        setCurrentSlide(index);
        setOffsetX(direction * -100);
        requestAnimationFrame(() => {
          setAnimate(true);
          setOffsetX(0);
          setTimeout(() => {
            setAnimate(false);
            transitioning.current = false;
          }, 300);
        });
      }, 300);
    },
    [currentSlide]
  );

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;

    if (Math.abs(deltaX) >= 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < 0) goTo(currentSlide + 1);
      else goTo(currentSlide - 1);
      return;
    }

    if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
      const tapX = e.changedTouches[0].clientX;
      const screenMid = window.innerWidth / 2;
      if (tapX < screenMid) goTo(currentSlide - 1);
      else if (currentSlide === slides.length - 1) onFinished();
      else goTo(currentSlide + 1);
    }
  };

  const slide = slides[currentSlide];
  const Illustration = slide.illustration;

  return (
    <div
      className={`fixed inset-0 z-9998 flex flex-col overflow-hidden touch-none bg-linear-to-br ${slide.gradient} transition-colors duration-300`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="flex gap-1.5 px-4 pb-2" style={{ paddingTop: "calc(env(safe-area-inset-top, 16px) + 8px)" }}>
        {slides.map((_, i) => (
          <div key={i} className="h-1 flex-1 rounded-full bg-white/30 overflow-hidden">
            <div
              className={`h-full rounded-full bg-white transition-all duration-300 ${
                i <= currentSlide ? "w-full" : "w-0"
              }`}
            />
          </div>
        ))}
      </div>

      <div
        className={`flex-1 flex flex-col items-center justify-center px-8 ${animate ? "transition-transform duration-300" : ""}`}
        style={{
          transform: `translateX(${offsetX}%)`,
        }}
      >
        <div className="w-64 h-64 mb-8 relative">
          <Illustration />
        </div>

        <h1 className="text-4xl font-bold text-white text-center mb-4 drop-shadow-lg">
          {slide.title}
        </h1>
        <p className="text-lg text-white/80 text-center max-w-xs leading-relaxed">
          {slide.description}
        </p>
      </div>

      {currentSlide === slides.length - 1 && (
        <div className="px-8" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 12px) + 24px)" }}>
          <button
            onClick={onFinished}
            className="w-full py-4 rounded-2xl bg-lime-300 text-gray-900 text-lg font-bold shadow-lg active:scale-95 transition-transform"
          >
            Get Started
          </button>
        </div>
      )}

      {currentSlide !== slides.length - 1 && <div style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 12px) + 24px)" }} />}
    </div>
  );
}


function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0L14.59 8.41L23 12L14.59 15.59L12 24L9.41 15.59L1 12L9.41 8.41Z" />
    </svg>
  );
}

function SlideOneIllustration() {
  return (
    <div className="w-full h-full flex items-center justify-center relative">
      <svg viewBox="0 0 200 200" className="w-40 h-40">
        <ellipse cx="100" cy="120" rx="50" ry="35" fill="#fff" />
        <ellipse cx="60" cy="105" rx="22" ry="18" fill="#fff" />
        <path d="M38 105 Q20 100 8 95 Q6 94 8 93 Q22 90 40 98" fill="#fff" />
        <circle cx="55" cy="100" r="3" fill="#F7931A" />
        <ellipse cx="68" cy="88" rx="8" ry="12" fill="#fff" />
        <ellipse cx="68" cy="90" rx="5" ry="8" fill="#F7931A" />
        <path d="M150 115 Q170 90 165 60 Q164 55 167 58 Q178 75 160 115" fill="#fff" />
        <rect x="75" y="145" width="10" height="25" rx="4" fill="#fff" />
        <rect x="95" y="145" width="10" height="25" rx="4" fill="#fff" />
        <rect x="115" y="145" width="10" height="25" rx="4" fill="#fff" />
        <rect x="130" y="142" width="10" height="25" rx="4" fill="#fff" />
      </svg>
      <svg className="absolute top-4 right-8 w-12 h-12 text-yellow-300 animate-pulse" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14.24 10.56C13.93 8.7 12.18 8.15 10.06 7.98V5.5H8.56V7.9H7.36V5.5H5.86V7.95H3.5V9.35H4.84C5.28 9.35 5.5 9.55 5.5 9.92V16.08C5.5 16.38 5.34 16.65 4.94 16.65H3.5L3.26 18.15H5.86V20.5H7.36V18.2H8.56V20.5H10.06V18.12C12.58 17.92 14.36 17.22 14.64 14.92C14.86 13.12 14 12.28 12.68 11.92C13.62 11.44 14.16 10.66 14.24 10.56ZM11.5 14.62C11.5 16.28 8.56 16.08 7.58 16.08V13.16C8.56 13.16 11.5 12.88 11.5 14.62ZM10.88 10.88C10.88 12.38 8.56 12.2 7.72 12.2V9.56C8.56 9.56 10.88 9.32 10.88 10.88Z" />
      </svg>
      <SparkleIcon className="absolute top-8 left-6 w-5 h-5 text-yellow-200 animate-[pulse_2s_ease-in-out_infinite]" />
      <SparkleIcon className="absolute bottom-12 right-4 w-4 h-4 text-yellow-200 animate-[pulse_3s_ease-in-out_infinite_0.5s]" />
      <SparkleIcon className="absolute top-20 right-20 w-3 h-3 text-white/60 animate-[pulse_2.5s_ease-in-out_infinite_1s]" />
    </div>
  );
}

function SlideTwoIllustration() {
  return (
    <div className="w-full h-full flex items-center justify-center relative">
      <svg viewBox="0 0 120 120" className="w-36 h-36" fill="none">
        <rect x="10" y="25" width="100" height="30" rx="15" fill="white" fillOpacity="0.25" />
        <path d="M30 40 L80 40" stroke="white" strokeWidth="3" strokeLinecap="round" />
        <path d="M70 33 L80 40 L70 47" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="10" y="65" width="100" height="30" rx="15" fill="white" fillOpacity="0.25" />
        <path d="M90 80 L40 80" stroke="white" strokeWidth="3" strokeLinecap="round" />
        <path d="M50 73 L40 80 L50 87" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="absolute top-6 left-10 w-16 h-0.5 bg-white/30 rounded animate-[pulse_2s_ease-in-out_infinite]" />
      <div className="absolute top-14 left-4 w-10 h-0.5 bg-white/20 rounded animate-[pulse_2.5s_ease-in-out_infinite_0.3s]" />
      <div className="absolute bottom-16 right-6 w-14 h-0.5 bg-white/30 rounded animate-[pulse_2s_ease-in-out_infinite_0.6s]" />
      <div className="absolute bottom-10 right-12 w-8 h-0.5 bg-white/20 rounded animate-[pulse_3s_ease-in-out_infinite_1s]" />
      <SparkleIcon className="absolute top-4 right-10 w-5 h-5 text-yellow-200 animate-[pulse_2s_ease-in-out_infinite]" />
    </div>
  );
}

function SlideThreeIllustration() {
  return (
    <div className="w-full h-full flex items-center justify-center relative">
      <svg viewBox="0 0 140 140" className="w-40 h-40" fill="none">
        <circle cx="50" cy="70" r="35" fill="white" fillOpacity="0.2" />
        <path d="M50 55 L50 85" stroke="white" strokeWidth="3" strokeLinecap="round" />
        <path d="M40 65 L50 55 L60 65" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <text x="50" y="100" textAnchor="middle" fill="white" fontSize="10" fontWeight="bold">Send</text>
        <circle cx="95" cy="70" r="35" fill="white" fillOpacity="0.2" />
        <path d="M95 55 L95 85" stroke="white" strokeWidth="3" strokeLinecap="round" />
        <path d="M85 75 L95 85 L105 75" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <text x="95" y="100" textAnchor="middle" fill="white" fontSize="10" fontWeight="bold">Receive</text>
      </svg>
      <svg className="absolute top-8 right-6 w-10 h-10 animate-[bounce_3s_ease-in-out_infinite]" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="18" fill="#FFD700" stroke="#DAA520" strokeWidth="2" />
        <text x="20" y="26" textAnchor="middle" fill="#8B6914" fontSize="18" fontWeight="bold">₿</text>
      </svg>
      <svg className="absolute bottom-16 left-8 w-8 h-8 animate-[bounce_2.5s_ease-in-out_infinite_0.5s]" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="18" fill="#FFD700" stroke="#DAA520" strokeWidth="2" />
        <text x="20" y="26" textAnchor="middle" fill="#8B6914" fontSize="18" fontWeight="bold">₿</text>
      </svg>
      <SparkleIcon className="absolute top-16 left-4 w-4 h-4 text-yellow-200 animate-[pulse_2s_ease-in-out_infinite]" />
      <SparkleIcon className="absolute bottom-8 right-16 w-3 h-3 text-white/60 animate-[pulse_3s_ease-in-out_infinite_0.5s]" />
    </div>
  );
}

function SlideFourIllustration() {
  return (
    <div className="w-full h-full flex items-center justify-center relative">
      <svg viewBox="0 0 120 140" className="w-36 h-36" fill="none">
        <path
          d="M60 10 L105 30 L105 75 Q105 115 60 130 Q15 115 15 75 L15 30 Z"
          fill="white"
          fillOpacity="0.25"
          stroke="white"
          strokeWidth="2"
        />
        <path
          d="M60 35 L85 45 L85 72 Q85 98 60 108 Q35 98 35 72 L35 45 Z"
          fill="white"
          fillOpacity="0.15"
        />
        <path d="M50 72 L57 79 L72 62" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="absolute bottom-12 left-6 w-12 h-12 animate-[bounce_3s_ease-in-out_infinite]" viewBox="0 0 40 40">
        <polygon points="20,4 36,16 28,36 12,36 4,16" fill="#A78BFA" stroke="#7C3AED" strokeWidth="1.5" />
        <polygon points="20,4 28,16 20,36 12,16" fill="#C4B5FD" fillOpacity="0.6" />
      </svg>
      <SparkleIcon className="absolute top-6 right-8 w-5 h-5 text-yellow-300 animate-[pulse_2s_ease-in-out_infinite]" />
      <SparkleIcon className="absolute top-20 left-10 w-3 h-3 text-yellow-200 animate-[pulse_2.5s_ease-in-out_infinite_0.5s]" />
      <SparkleIcon className="absolute bottom-24 right-12 w-4 h-4 text-white/50 animate-[pulse_3s_ease-in-out_infinite_1s]" />
    </div>
  );
}

export default Onboarding;
