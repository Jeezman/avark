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

// We never invoke wallet-side RPC methods — the LendaSwap claim flow is
// preimage-POST via Gelato (see commands/lendaswap.rs), so we only need the
// session for its account address. Leaving `methods: []` means wallets that
// don't advertise signing still pair.
const EIP155_METHODS: string[] = [];
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
        if (session) {
          sessionRef.current = session;
          setAddress(addressFromAccount(session.namespaces.eip155?.accounts[0]));
          setStatus("connected");
        } else {
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

  const connect = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setError(null);
    setStatus("connecting");
    try {
      const { uri, approval } = await client.connect({
        requiredNamespaces: {
          eip155: {
            chains: [ETH_MAINNET],
            methods: EIP155_METHODS,
            events: EIP155_EVENTS,
          },
        },
      });
      if (uri) setPairingUri(uri);
      const session = await approval();
      sessionRef.current = session;
      setAddress(addressFromAccount(session.namespaces.eip155?.accounts[0]));
      setPairingUri(null);
      setStatus("connected");
    } catch (e) {
      console.error("[wc] connect() failed:", e);
      setPairingUri(null);
      setStatus("error");
      setError((e as Error).message ?? String(e));
    }
  }, []);

  const cancelPairing = useCallback(() => {
    setPairingUri(null);
    if (!sessionRef.current) setStatus("idle");
  }, []);

  const disconnect = useCallback(async () => {
    const client = clientRef.current;
    const session = sessionRef.current;
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
        // Already disconnected / topic invalid — state is already cleared.
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
