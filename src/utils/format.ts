export function formatSats(sats: number): string {
  return sats.toLocaleString("en-US");
}

export function shortTxid(txid: string): string {
  if (txid.length <= 16) return txid;
  return `${txid.slice(0, 8)}…${txid.slice(-6)}`;
}

/// Compact "Xh Ym" countdown. Floors to minutes; returns "any moment" if
/// `secs` is small enough that rounding would show 0m.
export function formatCountdown(secs: number): string {
  if (secs <= 60) return "any moment";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/// Locale-aware "medium date, short time" for unix-seconds timestamps;
/// "Never" when absent. Used for cache/refresh timestamps in Settings.
export function formatCacheTime(timestamp: number | null): string {
  if (!timestamp) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1000));
}

/// Short "HH:MM" for a rate-quote timestamp. Accepts ms or seconds —
/// yadio has historically returned ms; the 1e12 threshold guards for
/// seconds just in case. "—" if the timestamp is unformattable.
export function formatQuoteTime(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function formatDate(timestamp: number | null): string {
  if (timestamp === null) return "Pending";
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
