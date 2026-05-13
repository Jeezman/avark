import { useMemo } from "react";
import { toSvg } from "jdenticon";
import { npubToHex } from "../utils/npub";

interface NpubIdenticonProps {
  npub: string;
  size: number;
}

/**
 * Deterministic SVG identicon derived from an npub. The bech32 is decoded to
 * its hex pubkey before hashing so the output matches other Nostr clients that
 * identicon off the same key.
 */
export function NpubIdenticon({ npub, size }: NpubIdenticonProps) {
  const svg = useMemo(() => {
    const hex = npubToHex(npub);
    return toSvg(hex ?? npub, size);
  }, [npub, size]);

  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        lineHeight: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
