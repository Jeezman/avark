/**
 * Tiny token + direction marks used by the swap screen. Kept local to the
 * swap feature — not general-purpose icons. Brand colors (USDC blue, USDT
 * green) are legitimate here because they identify real external assets.
 */

export function BtcMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="16" fill="currentColor" opacity="0.18" />
      <path
        d="M21.5 14.6c.3-2-1.2-3-3.3-3.7l.7-2.7-1.7-.4-.6 2.6-1.3-.3.7-2.7-1.7-.4-.6 2.7-4.2-1-.4 1.8 1.4.3c.8.2 1 .7.9 1.1l-1.7 6.8c-.1.3-.4.6-1 .5l-1.4-.3-.9 2 4 1-.6 2.7 1.7.4.6-2.7 1.3.3-.6 2.7 1.7.4.7-2.7c2.8.5 5 .3 5.8-2.2.7-2-.1-3.2-1.6-3.9 1.1-.3 1.9-1 2.1-2.5zm-3.8 5.2c-.5 2-3.8.9-4.8.7l.9-3.7c1 .2 4.4.8 3.9 3zm.5-5.2c-.4 1.8-3.2.9-4.1.7l.8-3.3c.9.2 3.7.7 3.3 2.6z"
        fill="var(--color-bitcoin)"
      />
    </svg>
  );
}

export function TokenMark({
  id,
  className = "h-6 w-6",
}: {
  id: "usdc_eth" | "usdt_eth";
  className?: string;
}) {
  if (id === "usdc_eth") {
    return (
      <div
        className={`${className} shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold`}
        style={{ background: "#2775CA", color: "#ffffff" }}
      >
        $
      </div>
    );
  }
  return (
    <div
      className={`${className} shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold`}
      style={{ background: "#26A17B", color: "#ffffff" }}
    >
      ₮
    </div>
  );
}

export function SwapDirectionIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4v16M6 14l6 6 6-6" />
    </svg>
  );
}
