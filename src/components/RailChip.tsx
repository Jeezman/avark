import { RAIL_META, type Rail } from './rails';

export function RailChip({ rail, tag }: { rail: Rail; tag: string }) {
  const meta = RAIL_META[rail];
  const filled = rail !== 'bitcoin'; 
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
      style={{ background: meta.soft }}
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill={filled ? meta.accent : 'none'}
        stroke={filled ? 'none' : meta.accent}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {meta.icon}
      </svg>
      <span className="text-[11px] font-semibold" style={{ color: meta.accent }}>
        {meta.label}
      </span>
      <span className="text-[10px] theme-text-faint">· {tag}</span>
    </span>
  );
}
