import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import SignClient from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";

const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  | string
  | undefined;

// Optional relay override. The SDK defaults to `wss://relay.walletconnect.org`
const RELAY_URL = import.meta.env.VITE_WALLETCONNECT_RELAY_URL as
  | string
  | undefined;

const EIP155_METHODS = [
  "personal_sign",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "eth_signTransaction",
];
const EIP155_EVENTS = ["accountsChanged", "chainChanged"];
const ETH_MAINNET = "eip155:1";

export type WalletConnectStatus =
  | "initializing"
  | "unconfigured"
  | "idle"
  | "connecting"
  | "connected"
  | "error";

interface WalletConnectContextValue {
  status: WalletConnectStatus;
  address: string | null;
  error: string | null;
  pairingUri: string | null;
  connect(): Promise<void>;
  cancelPairing(): void;
  disconnect(): Promise<void>;
}

const Ctx = createContext<WalletConnectContextValue | undefined>(undefined);

function addressFromAccount(account: string | undefined): string | null {
  // Accounts come back as "eip155:1:0x…"; pull the last segment.
  if (!account) return null;
  const parts = account.split(":");
  return parts.length === 3 ? parts[2] ?? null : null;
}

function sessionAddress(session: SessionTypes.Struct): string | null {
  return addressFromAccount(session.namespaces.eip155?.accounts[0]);
}

export function WalletConnectProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const clientRef = useRef<SignClient | null>(null);
  const sessionRef = useRef<SessionTypes.Struct | null>(null);
  const [status, setStatus] = useState<WalletConnectStatus>(
    PROJECT_ID ? "initializing" : "unconfigured"
  );
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    PROJECT_ID
      ? null
      : "VITE_WALLETCONNECT_PROJECT_ID is not set. Add it to .env and rebuild."
  );
  const [pairingUri, setPairingUri] = useState<string | null>(null);
  const deadTopicsRef = useRef<Set<string>>(new Set());

  const rejectAccountlessSession = useCallback(
    (client: SignClient, session: SessionTypes.Struct) => {
      deadTopicsRef.current.add(session.topic);
      client
        .disconnect({
          topic: session.topic,
          reason: { code: 6000, message: "Session has no eip155 account" },
        })
        .catch(() => {
          // Best-effort: the topic is in deadTopicsRef, so even if the
          // relay is unreachable and the session lingers in the store, it
          // will never be adopted.
        });
    },
    []
  );

  useEffect(() => {
    if (!PROJECT_ID) return;

    let cancelled = false;

    SignClient.init({
      projectId: PROJECT_ID,
      ...(import.meta.env.DEV ? { logger: "debug" } : {}),
      ...(RELAY_URL ? { relayUrl: RELAY_URL } : {}),
      metadata: {
        name: "Avark",
        description: "Arkade Bitcoin wallet",
        url: "https://github.com/Jeezman/avark",
        icons: [],
      },
    })
      .then((client) => {
        if (cancelled) return;
        clientRef.current = client;

        // Restore the most recent session, if any. SignClient persists
        // sessions to localStorage by default — survives app restart.
        const sessions = client.session.getAll();
        const session = sessions.length > 0 ? sessions[sessions.length - 1] : null;
        const restoredAddress = session ? sessionAddress(session) : null;
        if (session && restoredAddress) {
          sessionRef.current = session;
          setAddress(restoredAddress);
          setStatus("connected");
        } else {
          if (session) rejectAccountlessSession(client, session);
          setStatus("idle");
        }

        // External disconnection / session expiry from the wallet side.
        client.on("session_delete", ({ topic }) => {
          if (sessionRef.current?.topic === topic) {
            sessionRef.current = null;
            setAddress(null);
            setStatus("idle");
          }
        });
        client.on("session_expire", ({ topic }) => {
          if (sessionRef.current?.topic === topic) {
            sessionRef.current = null;
            setAddress(null);
            setStatus("idle");
          }
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus("error");
        setError(`WalletConnect init failed: ${(e as Error).message ?? e}`);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Re-sync from the SignClient session store while the app is running.
  useEffect(() => {
    function syncFromStore() {
      const client = clientRef.current;
      if (!client) return;
      const sessions = client.session.getAll();
      const latest =
        sessions.length > 0 ? sessions[sessions.length - 1] : null;
      if (!latest) return;
      if (latest.topic === sessionRef.current?.topic) return;
      if (deadTopicsRef.current.has(latest.topic)) return;
      const addr = sessionAddress(latest);
      if (!addr) {
        rejectAccountlessSession(client, latest);
        return;
      }
      sessionRef.current = latest;
      setAddress(addr);
      setPairingUri(null);
      setError(null);
      setStatus("connected");
    }
    function onVisibility() {
      if (document.visibilityState === "visible") syncFromStore();
    }
    const intervalId = window.setInterval(syncFromStore, 1500);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", syncFromStore);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", syncFromStore);
    };
  }, []);

  const connect = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    setStatus("connecting");
    try {
      const { uri, approval } = await client.connect({
        requiredNamespaces: {},
        optionalNamespaces: {
          eip155: {
            chains: [ETH_MAINNET],
            methods: EIP155_METHODS,
            events: EIP155_EVENTS,
          },
        },
      });
      if (uri) setPairingUri(uri);
      const session = await approval();
      const addr = sessionAddress(session);
      if (!addr) {
        rejectAccountlessSession(client, session);
        setPairingUri(null);
        setStatus("error");
        setError(
          "The wallet approved the connection without an Ethereum account. " +
            "Reconnect and select an Ethereum account in your wallet."
        );
        return;
      }
      sessionRef.current = session;
      setAddress(addr);
      setPairingUri(null);
      setStatus("connected");
    } catch (e) {
      console.error("[wc] connect() failed:", e);
      setPairingUri(null);
      if (!sessionRef.current) {
        setStatus("error");
        setError((e as Error).message ?? String(e));
      }
    }
  }, []);

  const cancelPairing = useCallback(() => {
    setPairingUri(null);
    if (!sessionRef.current) setStatus("idle");
  }, []);

  const disconnect = useCallback(async () => {
    const client = clientRef.current;
    const session = sessionRef.current;
    // Mark the topic dead BEFORE the relay round-trip
    if (session) deadTopicsRef.current.add(session.topic);
    sessionRef.current = null;
    setAddress(null);
    setStatus("idle");
    if (client && session) {
      try {
        await client.disconnect({
          topic: session.topic,
          reason: { code: 6000, message: "User disconnected" },
        });
      } catch {
        // Relay unreachable or topic already gone.
      }
    }
  }, []);

  const value = useMemo<WalletConnectContextValue>(
    () => ({
      status,
      address,
      error,
      pairingUri,
      connect,
      cancelPairing,
      disconnect,
    }),
    [status, address, error, pairingUri, connect, cancelPairing, disconnect]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWalletConnect(): WalletConnectContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useWalletConnect must be used inside WalletConnectProvider");
  }
  return ctx;
}
