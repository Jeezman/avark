export function formatSats(sats: number): string {
  return sats.toLocaleString();
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
