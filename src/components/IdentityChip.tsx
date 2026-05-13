import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { NpubIdenticon } from "./NpubIdenticon";
import { useNostrIdentity } from "../context/NostrIdentityContext";

const AVATAR_PX = 28;

function shortNpub(npub: string): string {
  if (npub.length <= 14) return npub;
  return `${npub.slice(0, 8)}…${npub.slice(-4)}`;
}

export function IdentityChip() {
  const { npub, status, metadata } = useNostrIdentity();
  const [failedPictureUrl, setFailedPictureUrl] = useState<string | null>(null);
  const picture = metadata?.picture?.trim();

  if (status === "loading" || !npub) {
    return (
      <div className="flex items-center gap-2">
        <div
          className="rounded-full shimmer-skeleton"
          style={{ width: AVATAR_PX, height: AVATAR_PX }}
        />
        <div className="h-3.5 w-20 shimmer-skeleton rounded" />
      </div>
    );
  }

  const showPicture = picture && failedPictureUrl !== picture;
  const label =
    metadata?.display_name?.trim() ||
    metadata?.name?.trim() ||
    shortNpub(npub);

  return (
    <Link
      to="/profile"
      className="flex items-center gap-2 rounded-full theme-card-elevated pl-1 pr-3 py-1 hover:opacity-80 transition-opacity"
      aria-label="Open profile"
    >
      <span
        className="relative inline-block rounded-full overflow-hidden bg-[var(--color-bg-secondary)] shrink-0"
        style={{ width: AVATAR_PX, height: AVATAR_PX }}
      >
        <NpubIdenticon npub={npub} size={AVATAR_PX} />
        {showPicture && (
          <img
            src={picture}
            alt=""
            width={AVATAR_PX}
            height={AVATAR_PX}
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setFailedPictureUrl(picture ?? null)}
          />
        )}
      </span>
      <span className="text-xs font-semibold theme-text truncate max-w-[10rem]">
        {label}
      </span>
    </Link>
  );
}
