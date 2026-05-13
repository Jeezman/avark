import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

type Status = "loading" | "ready" | "error";
type MetadataStatus = "idle" | "loading" | "ready" | "error";

export interface NostrMetadata {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  lud16?: string;
}

interface FetchMetadataResult {
  metadata: NostrMetadata | null;
  fetched_at: number;
}

interface NostrIdentityValue {
  npub: string | null;
  status: Status;
  metadata: NostrMetadata | null;
  metadataFetchedAt: number | null;
  metadataStatus: MetadataStatus;
  refreshMetadata: () => Promise<void>;
  setMetadata: (m: NostrMetadata | null) => void;
}

const NostrIdentityContext = createContext<NostrIdentityValue>({
  npub: null,
  status: "loading",
  metadata: null,
  metadataFetchedAt: null,
  metadataStatus: "idle",
  refreshMetadata: async () => {},
  setMetadata: () => {},
});

export function useNostrIdentity() {
  return useContext(NostrIdentityContext);
}

export function NostrIdentityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [npub, setNpub] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [metadata, setMetadataState] = useState<NostrMetadata | null>(null);
  const [metadataFetchedAt, setMetadataFetchedAt] = useState<number | null>(null);
  const [metadataStatus, setMetadataStatus] = useState<MetadataStatus>("idle");
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        const current = await invoke<{ npub: string | null }>(
          "nostr_get_identity",
        );
        if (cancelledRef.current) return;
        if (current.npub) {
          setNpub(current.npub);
          setStatus("ready");
          return;
        }
        const created = await invoke<{ npub: string }>(
          "nostr_generate_identity",
        );
        if (cancelledRef.current) return;
        setNpub(created.npub);
        setStatus("ready");
      } catch (e) {
        if (cancelledRef.current) return;
        const message =
          typeof e === "string" ? e : "Failed to set up Nostr identity";
        setStatus("error");
        toast.error(message);
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Auto-fetch metadata once identity is ready
  useEffect(() => {
    if (!npub) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await invoke<FetchMetadataResult>("nostr_fetch_metadata", {
          npub,
        });
        if (cancelled) return;
        setMetadataState(res.metadata);
        setMetadataFetchedAt(res.fetched_at);
        setMetadataStatus("ready");
      } catch {
        if (cancelled) return;
        setMetadataStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [npub]);

  const refreshMetadata = useCallback(async () => {
    if (!npub) return;
    try {
      const res = await invoke<FetchMetadataResult>("nostr_fetch_metadata", {
        npub,
      });
      setMetadataState(res.metadata);
      setMetadataFetchedAt(res.fetched_at);
      setMetadataStatus("ready");
    } catch {
      setMetadataStatus("error");
    }
  }, [npub]);

  const setMetadata = useCallback((m: NostrMetadata | null) => {
    setMetadataState(m);
    setMetadataFetchedAt(Math.floor(Date.now() / 1000));
    setMetadataStatus("ready");
  }, []);

  const value = useMemo(
    () => ({
      npub,
      status,
      metadata,
      metadataFetchedAt,
      metadataStatus,
      refreshMetadata,
      setMetadata,
    }),
    [
      npub,
      status,
      metadata,
      metadataFetchedAt,
      metadataStatus,
      refreshMetadata,
      setMetadata,
    ],
  );

  return (
    <NostrIdentityContext.Provider value={value}>
      {children}
    </NostrIdentityContext.Provider>
  );
}
