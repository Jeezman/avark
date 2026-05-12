/**
 * Error formatting helper for the LendaSwap layer.
 */

interface DatabaseError {
  kind: "database";
  message: string;
}
interface NotFoundError {
  kind: "not-found";
  id: string;
}
interface WalletNotInitializedError {
  kind: "wallet-not-initialized";
}
interface OtherError {
  kind: "other";
  message: string;
}

export type LendaSwapError =
  | DatabaseError
  | NotFoundError
  | WalletNotInitializedError
  | OtherError;

function isLendaSwapError(e: unknown): e is LendaSwapError {
  return typeof e === "object" && e !== null && "kind" in e;
}

export function formatLendaSwapError(e: unknown): string {
  if (isLendaSwapError(e)) {
    switch (e.kind) {
      case "not-found":
        return `Swap not found: ${e.id}`;
      case "wallet-not-initialized":
        return "Your avark wallet isn't initialized yet.";
      case "database":
        return `Storage error: ${e.message}`;
      case "other":
        return translateBtcBoundsToSats(e.message);
    }
  }
  if (e instanceof Error) return translateBtcBoundsToSats(e.message);
  if (typeof e === "string") return translateBtcBoundsToSats(e);
  return String(e);
}

/**
 * The LendaSwap API returns BTC amount bounds as decimal BTC
 * (e.g. `Min amount is 0.00010000`). avark's UI is sats-native,
 * so we rewrite those into `X sats` for consistency with the rest
 * of the swap screen. Only touches strings we recognize; everything
 * else passes through unchanged.
 */
function translateBtcBoundsToSats(msg: string): string {
  return msg.replace(
    /\b(Min|Max)\s+amount\s+is\s+([\d.]+)/gi,
    (_match, bound: string, btc: string) => {
      const sats = Math.round(parseFloat(btc) * 1e8);
      if (!Number.isFinite(sats)) return _match;
      return `${bound} amount is ${sats.toLocaleString()} sats`;
    },
  );
}
