/// Strict sat-amount parser for user input. The single grammar for every
/// amount field in the app: whole digits only — exponent notation ("1e3"),
/// hex ("0x10"), signs, decimals, and trailing junk ("100abc") all reject,
/// so what the user sees is exactly what gets spent.
///
/// Returns null for zero (sat amounts are positive) and for values beyond
/// Number.MAX_SAFE_INTEGER, where Number() would silently lose precision;
/// the backend independently rejects amounts above the total bitcoin supply.
export function parseSatAmount(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}
