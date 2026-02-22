"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";

declare global {
  interface Window {
    __pera?: import("@perawallet/connect").PeraWalletConnect;
  }
}

async function getPera() {
  if (typeof window === "undefined") return null;
  if (!window.__pera) {
    const { PeraWalletConnect } = await import("@perawallet/connect");
    window.__pera = new PeraWalletConnect({
      network: "testnet",
      shouldShowSignTxnToast: true,
    });
  }
  return window.__pera;
}

function shorten(addr: string, n = 4): string {
  if (!addr) return "";
  return `${addr.slice(0, n)}...${addr.slice(-n)}`;
}

interface WalletCtxType {
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  shortAddress: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  error: string | null;
}

const WalletCtx = createContext<WalletCtxType | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getPera().then((pera) => {
      if (!pera) { setReady(true); return; }
      pera.reconnectSession()
        .then((accounts: string[]) => {
          if (accounts.length > 0) setAddress(accounts[0]);
        })
        .catch(() => {})
        .finally(() => setReady(true));
    });
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const pera = await getPera();
      if (!pera) throw new Error("Pera not available");
      const accounts = await pera.connect();
      setAddress(accounts[0] ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("closed") && !msg.includes("rejected") && !msg.includes("cancel")) {
        setError(msg);
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const pera = await getPera();
    if (pera) pera.disconnect();
    setAddress(null);
    setError(null);
  }, []);

  return (
    <WalletCtx.Provider value={{
      address,
      isConnected: !!address,
      isConnecting,
      shortAddress: address ? shorten(address) : "",
      connect,
      disconnect,
      error,
    }}>
      {children}
    </WalletCtx.Provider>
  );
}

export function useWallet(): WalletCtxType {
  const ctx = useContext(WalletCtx);
  if (!ctx) throw new Error("useWallet must be inside WalletProvider");
  return ctx;
}
