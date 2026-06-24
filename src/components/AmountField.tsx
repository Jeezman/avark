import { type ReactNode } from 'react';


export function AmountField({
  label,
  hint,
  value,
  onChange,
  disabled = false,
  accent = '#bef264',
  invalid = false,
  footer,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  accent?: string;
  invalid?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between px-1">
        <label className="text-[11px] font-semibold uppercase tracking-[0.14em] theme-text-muted">
          {label}
        </label>
        {hint}
      </div>
      <div
        className="flex items-baseline justify-center gap-2 rounded-2xl theme-card px-4 py-5 transition-shadow focus-within:ring-1"
        style={{
          // @ts-expect-error CSS custom prop for the focus ring colour
          '--tw-ring-color': `${accent}66`,
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          placeholder="0"
          value={value}
          onChange={onChange}
          disabled={disabled}
          className="font-display w-full min-w-0 bg-transparent text-right text-4xl theme-text outline-none tabular-nums placeholder:opacity-20 disabled:opacity-70"
          style={invalid ? { color: '#f87171' } : undefined}
        />
        <span className="shrink-0 text-sm font-medium theme-text-muted">sats</span>
      </div>
      {footer}
    </div>
  );
}
