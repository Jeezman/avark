import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ConnectionState = "checking" | "connecting" | "connected" | "error";

export function DashboardRoute() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("checking");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const connectWallet = useCallback(() => {
    cancelledRef.current = false;
    setConnectionState("checking");
    setConnectionError(null);

    invoke<boolean>("is_wallet_loaded")
      .then((loaded) => {
        if (cancelledRef.current) return;

        if (loaded) {
          setConnectionState("connected");
          return;
        }

        setConnectionState("connecting");

        invoke("connect_wallet")
          .then(() => {
            if (!cancelledRef.current) {
              setConnectionState("connected");
            }
          })
          .catch((error) => {
            if (cancelledRef.current) return;
            const message = typeof error === "string" ? error : "Failed to connect to ASP";
            setConnectionError(message);
            setConnectionState("error");
          });
      })
      .catch((error) => {
        if (cancelledRef.current) return;
        const message = typeof error === "string" ? error : "Failed to read wallet connection state";
        setConnectionError(message);
        setConnectionState("error");
      });
  }, []);

  useEffect(() => {
    connectWallet();
    return () => {
      cancelledRef.current = true;
    };
  }, [connectWallet]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="mb-4 text-2xl font-bold">Dashboard</h1>
      <p className="text-gray-500">Wallet ready locally. Dashboard coming in US-007.</p>
      <p className={`mt-3 text-sm ${connectionState === "error" ? "text-red-400" : "text-gray-400"}`}>
        {connectionState === "connected" && "Connected to ASP."}
        {connectionState === "checking" && "Checking wallet connection..."}
        {connectionState === "connecting" && "Connecting to ASP in the background..."}
        {connectionState === "error" && (connectionError ?? "Unable to connect to ASP right now.")}
      </p>
      {connectionState === "error" && (
        <button
          className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          onClick={connectWallet}
        >
          Retry
        </button>
      )}
    </main>
  );
}
