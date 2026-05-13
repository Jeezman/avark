import { useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { NpubIdenticon } from "../components/NpubIdenticon";
import {
  useNostrIdentity,
  type NostrMetadata,
} from "../context/NostrIdentityContext";

interface PublishResult {
  event_id: string;
  accepted_relays: string[];
}

const FIELD_LABELS: Record<keyof NostrMetadata, string> = {
  name: "Name",
  display_name: "Display name",
  about: "About",
  picture: "Picture URL",
  lud16: "Lightning",
};

const FIELD_ORDER: (keyof NostrMetadata)[] = [
  "name",
  "display_name",
  "about",
  "lud16",
];

function shortNpub(npub: string): string {
  if (npub.length <= 18) return npub;
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

function buildPublishPayload(draft: NostrMetadata): NostrMetadata {
  const out: NostrMetadata = {};
  for (const [k, v] of Object.entries(draft) as [keyof NostrMetadata, string | undefined][]) {
    const trimmed = v?.trim();
    if (trimmed) out[k] = trimmed;
  }
  return out;
}

function timeAgo(unixSeconds: number, nowMs: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds));
  if (diffSec < 60) return "just now";
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function ProfileRoute() {
  const router = useRouter();
  const {
    npub,
    status: identityStatus,
    metadata,
    metadataFetchedAt: fetchedAt,
    metadataStatus,
    refreshMetadata,
    setMetadata,
  } = useNostrIdentity();
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<NostrMetadata>({});
  const [publishing, setPublishing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [failedPictureUrl, setFailedPictureUrl] = useState<string | null>(null);

  useEffect(() => {
    if (metadataStatus === "error") {
      toast.error("Failed to fetch profile from relays");
    }
  }, [metadataStatus]);

  const startEdit = () => {
    setDraft(metadata ?? {});
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setDraft({});
  };

  const handlePublish = async () => {
    const payload = buildPublishPayload(draft);
    setPublishing(true);
    try {
      const res = await invoke<PublishResult>("nostr_publish_metadata", {
        metadata: payload,
      });
      if (res.accepted_relays.length === 0) {
        toast.warning("No relays accepted the event — try again");
        return;
      }
      toast.success(
        `Published to ${res.accepted_relays.length} relay${
          res.accepted_relays.length === 1 ? "" : "s"
        }`,
      );
      setMetadata(payload);
      setEditMode(false);
      setDraft({});
    } catch (e) {
      const message = typeof e === "string" ? e : "Failed to publish profile";
      toast.error(message);
    } finally {
      setPublishing(false);
    }
  };

  const handleCopyNpub = async () => {
    if (!npub) return;
    try {
      await navigator.clipboard.writeText(npub);
      toast.success("npub copied");
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await refreshMetadata();
    } finally {
      setRetrying(false);
    }
  };

  const isBootstrapping =
    identityStatus === "loading" ||
    (npub && (metadataStatus === "idle" || metadataStatus === "loading"));
  const view = editMode ? draft : metadata ?? {};
  const picture = view.picture?.trim();
  const showPicture = picture && failedPictureUrl !== picture;
  const displayName =
    view.display_name?.trim() || view.name?.trim() || (npub ? "Anonymous" : "—");

  const filledFields = useMemo(() => {
    if (!metadata) return [];
    return FIELD_ORDER.filter((k) => k !== "display_name" && metadata[k]?.trim()).map(
      (k) => ({ key: k, label: FIELD_LABELS[k], value: metadata[k]!.trim() }),
    );
  }, [metadata]);

  const missingFields = useMemo(() => {
    if (!metadata) return [];
    return FIELD_ORDER.filter((k) => k !== "display_name" && !metadata[k]?.trim()).map(
      (k) => FIELD_LABELS[k],
    );
  }, [metadata]);

  return (
    <main
      className="theme-text min-h-full pb-12"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* Header */}
      <div className="px-6 pt-3 pb-5 flex items-center gap-3">
        <button
          onClick={() => router.history.back()}
          className="rounded-full theme-card-elevated p-2 hover:opacity-80 transition-opacity"
          aria-label="Back"
        >
          <svg
            className="h-4 w-4 theme-text-secondary"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div>
          <h1 className="font-display text-xl leading-none tracking-wide">
            Identity
          </h1>
          <p className="text-[10px] font-mono uppercase tracking-[0.28em] theme-text-faint mt-1.5">
            kind:0 · nostr
          </p>
        </div>
      </div>

      {/* Identity card — full-bleed credential surface */}
      <section className="relative identity-surface mb-7 pt-10 pb-0 border-y theme-border">
        <span className="id-corner id-corner-tl" />
        <span className="id-corner id-corner-tr" />
        <span className="id-corner id-corner-bl" />
        <span className="id-corner id-corner-br" />

        <div className="relative flex flex-col items-center gap-4 px-6 pb-7">
          <div className="identicon-ring">
            <div
              className="relative rounded-full overflow-hidden bg-[var(--color-bg-secondary)]"
              style={{ width: 112, height: 112 }}
            >
              {npub ? (
                <NpubIdenticon npub={npub} size={112} />
              ) : (
                <div className="h-28 w-28 shimmer-skeleton" />
              )}
              {showPicture && (
                <img
                  src={picture}
                  alt=""
                  width={112}
                  height={112}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => setFailedPictureUrl(picture ?? null)}
                />
              )}
            </div>
          </div>

          {/* Display name — hero */}
          {isBootstrapping ? (
            <div className="h-7 w-40 shimmer-skeleton rounded" />
          ) : (
            <h2 className="font-display text-3xl text-center leading-none tracking-tight px-4 break-words">
              {displayName}
            </h2>
          )}

          {/* About */}
          {view.about?.trim() && (
            <p className="text-sm theme-text-secondary text-center max-w-[32ch] leading-relaxed mt-1 whitespace-pre-wrap">
              {view.about.trim()}
            </p>
          )}

          {/* Relay status pill */}
          {!isBootstrapping && metadata && fetchedAt && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent)] opacity-50 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
              </span>
              <span className="text-[10px] font-mono uppercase tracking-[0.25em] theme-text-faint">
                On relays · {timeAgo(fetchedAt)}
              </span>
            </div>
          )}

          {/* Empty — never published */}
          {!isBootstrapping && !metadata && metadataStatus === "ready" && (
            <span className="text-[10px] font-mono uppercase tracking-[0.25em] theme-text-faint mt-1">
              Not yet published
            </span>
          )}
        </div>

        {/* Perforation */}
        <div className="relative perforation" />

        {/* npub stub */}
        <button
          onClick={() => void handleCopyNpub()}
          disabled={!npub}
          className="relative w-full flex items-center gap-3 px-6 py-4 hover:bg-[var(--color-bg-card-hover)] transition-colors text-left disabled:opacity-50"
        >
          <span className="text-[10px] font-mono uppercase tracking-[0.3em] theme-text-faint shrink-0">
            ID
          </span>
          <span className="font-mono text-xs theme-text-secondary truncate flex-1">
            {npub ? shortNpub(npub) : "—"}
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.25em] theme-accent flex items-center gap-1.5 shrink-0">
            <svg
              className="h-3 w-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </span>
        </button>
      </section>

      {/* Fetch error banner */}
      {metadataStatus === "error" && !editMode && (
        <div className="px-6 mb-5">
          <div className="rounded-2xl theme-warning-bg border theme-warning-border p-4">
            <p className="text-sm theme-warning font-medium">
              Couldn&rsquo;t load profile from relays
            </p>
            <button
              onClick={() => void handleRetry()}
              disabled={retrying}
              className="mt-2 text-xs theme-accent underline underline-offset-2 disabled:opacity-60 disabled:no-underline"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="px-6">
        {!editMode ? (
          <>
            {/* Filled fields */}
            {filledFields.length > 0 && (
              <>
                <h3 className="text-[10px] font-mono uppercase tracking-[0.28em] theme-text-faint mb-2 px-1">
                  On file
                </h3>
                <div className="rounded-2xl theme-card divide-y theme-divide overflow-hidden mb-4">
                  {filledFields.map((f) => (
                    <FieldRow
                      key={f.key}
                      label={f.label}
                      value={f.value}
                      mono={f.key === "lud16"}
                      multiline={f.key === "about"}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Missing fields hint */}
            {filledFields.length > 0 && missingFields.length > 0 && (
              <button
                onClick={startEdit}
                className="w-full flex items-center justify-between gap-3 rounded-2xl theme-card-elevated px-4 py-3 mb-6 hover:opacity-80 transition-opacity"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[10px] font-mono uppercase tracking-[0.28em] theme-text-faint shrink-0">
                    Missing
                  </span>
                  <span className="text-xs theme-text-secondary truncate">
                    {missingFields.join(" · ")}
                  </span>
                </div>
                <span className="text-[10px] font-mono uppercase tracking-[0.25em] theme-accent shrink-0">
                  Add
                </span>
              </button>
            )}

            {/* True empty state */}
            {filledFields.length === 0 && metadataStatus === "ready" && (
              <div className="rounded-2xl theme-card p-7 text-center mb-6">
                <p className="text-[10px] font-mono uppercase tracking-[0.28em] theme-text-faint mb-3">
                  Blank credential
                </p>
                <p className="theme-text-secondary text-sm leading-relaxed max-w-[34ch] mx-auto">
                  Your identity is created and broadcastable. Add a name and bio
                  to introduce yourself on the network.
                </p>
              </div>
            )}

            {/* Edit CTA */}
            <button
              onClick={startEdit}
              disabled={metadataStatus === "loading"}
              className="w-full theme-button-primary rounded-2xl py-3.5 text-sm font-semibold disabled:opacity-50"
            >
              {filledFields.length === 0 ? "Set up profile" : "Edit profile"}
            </button>
          </>
        ) : (
          <>
            <h3 className="text-[10px] font-mono uppercase tracking-[0.28em] theme-text-faint mb-2 px-1">
              Edit credential
            </h3>
            <div className="rounded-2xl theme-card p-5 space-y-5 mb-4">
              <FormField
                label="Name"
                value={draft.name ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
                placeholder="alice"
              />
              <FormField
                label="Display name"
                value={draft.display_name ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, display_name: v }))}
                placeholder="Alice"
              />
              <FormField
                label="About"
                value={draft.about ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, about: v }))}
                placeholder="A short bio"
                multiline
              />
              <FormField
                label="Picture URL"
                value={draft.picture ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, picture: v }))}
                placeholder="https://…"
                mono
              />
              <FormField
                label="Lightning address (lud16)"
                value={draft.lud16 ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, lud16: v }))}
                placeholder="alice@walletofsatoshi.com"
                mono
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={cancelEdit}
                disabled={publishing}
                className="flex-1 rounded-2xl theme-card-elevated py-3.5 text-sm font-medium theme-text-secondary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handlePublish()}
                disabled={publishing}
                className="flex-[2] theme-button-primary rounded-2xl py-3.5 text-sm font-semibold disabled:opacity-50"
              >
                {publishing ? "Publishing…" : "Publish to relays"}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function FieldRow({
  label,
  value,
  mono,
  multiline,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="px-4 py-3.5">
      <p className="text-[10px] font-mono uppercase tracking-[0.25em] theme-text-faint mb-1.5">
        {label}
      </p>
      <p
        className={`text-sm ${mono ? "font-mono break-all" : ""} ${
          multiline ? "whitespace-pre-wrap leading-relaxed" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  const inputClasses = `w-full rounded-xl theme-input px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-lime-300/50 ${
    mono ? "font-mono" : ""
  }`;
  return (
    <label className="block">
      <span className="text-[10px] font-mono uppercase tracking-[0.25em] theme-text-faint mb-1.5 block">
        {label}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={inputClasses}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          className={inputClasses}
        />
      )}
    </label>
  );
}
