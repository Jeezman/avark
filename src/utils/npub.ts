import { bech32 } from "bech32";

/**
 * Decode a bech32 `npub1…` to its 64-char hex pubkey. Returns `null` if the
 * input isn't a valid npub.
 *
 * Other Nostr clients identicon off the hex pubkey, so passing this output to
 * a deterministic hash-based renderer produces visuals that match across apps.
 */
export function npubToHex(npub: string): string | null {
  try {
    const decoded = bech32.decode(npub);
    if (decoded.prefix !== "npub") return null;
    const bytes = bech32.fromWords(decoded.words);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}
