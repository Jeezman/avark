import type { ReactNode } from 'react';

/**
 * Canonical payment rails
 */
export type Rail = 'ark' | 'bitcoin' | 'lightning';

export const DEFAULT_ACCENT = '#bef264';

// One glyph per rail: bolt for the instant rails (Ark, Lightning), anchor for
// on-chain (boarding outputs "anchor" to the base chain).
const BOLT = <path d="M13 2 4 14h6l-1 8 9-12h-6z" />;
const ANCHOR = (
  <>
    <circle cx="12" cy="5" r="2.5" />
    <path d="M12 22V8M5 12H2a10 10 0 0020 0h-3" />
  </>
);

/**
 * Per-rail visual identity shared across the Send and Receive sheets
 */
export const RAIL_META: Record<
  Rail,
  { label: string; accent: string; soft: string; icon: ReactNode }
> = {
  ark: { label: 'Ark', accent: DEFAULT_ACCENT, soft: 'rgba(190,242,100,0.14)', icon: BOLT },
  bitcoin: { label: 'On-chain', accent: '#9fb4c8', soft: 'rgba(159,180,200,0.14)', icon: ANCHOR },
  lightning: { label: 'Lightning', accent: '#fbbf24', soft: 'rgba(251,191,36,0.14)', icon: BOLT },
};
