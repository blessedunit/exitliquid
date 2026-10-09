"use client";
// Privy sign-in (email / X / Google = a wallet made for you, or any EVM wallet), loaded lazily:
// the SDK is heavy, so pages ship without it and fetch it on the first Connect press
// (or quietly in the background for a visitor who is already signed in).
// Without NEXT_PUBLIC_PRIVY_APP_ID the site keeps the plain browser-wallet flow.
import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useState, type ReactNode } from "react";
import { setWalletBridge, type WalletBridge } from "@/lib/wallet";

const APP_ID = (process.env.NEXT_PUBLIC_PRIVY_APP_ID || "").trim();
const PrivyLayer = dynamic(() => import("./PrivyLayer"), { ssr: false });

let real: WalletBridge | null = null;
let failed: Error | null = null;
let waiters: ((b: WalletBridge | null) => void)[] = [];
const whenReady = () => (real ? Promise.resolve(real) : new Promise<WalletBridge | null>((r) => waiters.push(r)));

const SIGNED_KEY = "exit.privy.signed"; // set by PrivyLayer after a finished sign-in, removed on disconnect
function signedInBefore() {
  try {
    return localStorage.getItem(SIGNED_KEY) === "1";
  } catch {
    return false; // storage can be blocked
  }
}

// a crash inside the Privy SDK must never take the page down: log it and let Connect fail with a message
class Guard extends Component<{ children: ReactNode; onError: (e: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error) {
    console.error("[privy] layer crashed:", e?.message ?? e);
    this.props.onError(e);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function Providers({ children }: { children: React.ReactNode }) {
  const [load, setLoad] = useState(false);
  useEffect(() => {
    if (!APP_ID) return;
    setWalletBridge({
      connect: async () => {
        setLoad(true);
        const b = failed ? null : await whenReady();
        if (!b) throw new Error("Sign-in is unavailable right now. Please reload the page and try again.");
        return b.connect();
      },
      provider: async (address) => (real ? real.provider(address) : null),
      disconnect: async () => {
        if (real) await real.disconnect();
      },
    });
    // hovering / touching a Connect button downloads the sign-in code, so the click opens it faster
    let warmed = false;
    const warm = (e: Event) => {
      if (warmed || !(e.target as Element | null)?.closest?.("[data-wallet-connect]")) return;
      warmed = true;
      void import("./PrivyLayer");
    };
    document.addEventListener("pointerover", warm, { passive: true });
    document.addEventListener("touchstart", warm, { passive: true });
    // coming back from Google / X sign-in, or signed in before: restore the session now
    const oauthReturn = /[?&]privy_oauth_/.test(window.location.search);
    if (oauthReturn || signedInBefore()) setTimeout(() => setLoad(true), 0);
    return () => {
      setWalletBridge(null);
      document.removeEventListener("pointerover", warm);
      document.removeEventListener("touchstart", warm);
    };
  }, []);
  const onReady = useCallback((b: WalletBridge) => {
    real = b;
    const w = waiters;
    waiters = [];
    w.forEach((f) => f(b));
  }, []);
  const onCrash = useCallback((e: Error) => {
    failed = e;
    const w = waiters;
    waiters = [];
    w.forEach((f) => f(null));
  }, []);
  return (
    <>
      {children}
      {APP_ID && load && (
        <Guard onError={onCrash}>
          <PrivyLayer appId={APP_ID} onReady={onReady} />
        </Guard>
      )}
    </>
  );
}
