"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { connectWallet, disconnectWallet, getPrivyAddress, PRIVY_ENABLED } from "@/lib/wallet";
import { IS_LIVE } from "@/lib/config";
import styles from "./Header.module.css";

const valid = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;
const DISCONNECTED_KEY = "exit.wallet.disconnected";

export default function WalletHeader() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [points, setPoints] = useState<{ wallet: string; value: number | null } | null>(null);
  const disconnected = useRef(false);
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const injected = (window as typeof window & { ethereum?: { request: (a: { method: string }) => Promise<unknown>; on?: (event: string, fn: (accounts: string[]) => void) => void; removeListener?: (event: string, fn: (accounts: string[]) => void) => void } }).ethereum;
    // with Privy on, Privy alone says who is connected: an extension's own account never shows up by itself
    const provider = PRIVY_ENABLED ? undefined : injected;
    try { disconnected.current = localStorage.getItem(DISCONNECTED_KEY) === "1"; } catch { /* storage can be blocked */ }
    const changed = (accounts: string[]) => {
      if (disconnected.current) return;
      if (getPrivyAddress()) return; // a Privy session owns the header
      const next = accounts.find(valid)?.toLowerCase() ?? null;
      setWallet(next);
      // Keep a manually entered "find me" address when the extension disconnects.
      if (next) {
        try { localStorage.setItem("exit.me", next); } catch { /* storage can be blocked */ }
        window.dispatchEvent(new Event("exit-me-change"));
      }
    };
    if (provider) {
      void provider.request({ method: "eth_accounts" }).then((accounts: unknown) => changed(Array.isArray(accounts) ? accounts : []), () => {});
      provider.on?.("accountsChanged", changed);
    }
    const sync = () => {
      try { disconnected.current = localStorage.getItem(DISCONNECTED_KEY) === "1"; } catch { /* storage can be blocked */ }
      if (disconnected.current) { setWallet(null); setPoints(null); return; }
      void provider?.request({ method: "eth_accounts" }).then((accounts: unknown) => changed(Array.isArray(accounts) ? accounts : []), () => {});
    };
    window.addEventListener("exit-wallet-change", sync);
    const privy = (e: Event) => {
      const a = (e as CustomEvent<string | null>).detail;
      if (a && valid(a)) {
        if (disconnected.current) return;
        setWallet(a);
        try { localStorage.setItem("exit.me", a); } catch { /* storage can be blocked */ }
        window.dispatchEvent(new Event("exit-me-change"));
      } else {
        setWallet(null);
        setPoints(null);
      }
    };
    window.addEventListener("exit-privy-wallet", privy);
    const known = getPrivyAddress();
    if (known && !disconnected.current) setWallet(known);
    return () => {
      provider?.removeListener?.("accountsChanged", changed);
      window.removeEventListener("exit-wallet-change", sync);
      window.removeEventListener("exit-privy-wallet", privy);
    };
  }, []);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!wallet) return;
    let active = true;
    let running = false;
    const load = async () => {
      if (!active || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        const response = await fetch(`/api/points/${wallet}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Points unavailable");
        const data = await response.json() as { points: number | null };
        if (active) setPoints({ wallet, value: data.points });
      } catch {
        if (active) setPoints({ wallet, value: null });
      } finally { running = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [wallet]);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    // the intent to connect survives a sign-in redirect (Google / X leave the page and come back)
    disconnected.current = false;
    try { localStorage.removeItem(DISCONNECTED_KEY); } catch { /* storage can be blocked */ }
    try {
      const account = await connectWallet();
      disconnected.current = false;
      try { localStorage.removeItem(DISCONNECTED_KEY); localStorage.setItem("exit.me", account); } catch { /* storage can be blocked */ }
      window.dispatchEvent(new Event("exit-me-change"));
      window.dispatchEvent(new Event("exit-wallet-change"));
      setWallet(account);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    disconnected.current = true;
    setBusy(true); // Connect stays disabled until the old session is fully closed
    setWallet(null);
    setPoints(null);
    try {
      localStorage.setItem(DISCONNECTED_KEY, "1");
      if (localStorage.getItem("exit.me")?.toLowerCase() === wallet) localStorage.removeItem("exit.me");
    } catch { /* storage can be blocked */ }
    window.dispatchEvent(new Event("exit-me-change"));
    window.dispatchEvent(new Event("exit-wallet-change"));
    if (menu.current) menu.current.open = false;
    setError("");
    try {
      await disconnectWallet(); // ends the Privy session too
    } catch { /* already signed out */ }
    setBusy(false);
  };

  const pts = wallet && points?.wallet === wallet && points.value !== null
    ? points.value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "…";

  return (
    <div className={styles.walletActions}>
      {/* points chip: neutral frame, opens your lines (hidden on phones: My lines is in the menu) */}
      {wallet && (
        <Link className={styles.pts} href={`/lines?w=${wallet}`} title={IS_LIVE ? "Your points · your lines" : "Preview points on a stand-in token, not $EXIT"}>
          <b>{pts}</b>
          {/* before launch the line replays a preview token: say so, these are not $EXIT points */}
          <small>{IS_LIVE ? "pts" : "preview"}</small>
        </Link>
      )}
      {wallet ? <details className={styles.walletMenu} ref={menu} onKeyDown={(event) => { if (event.key === "Escape" && menu.current) menu.current.open = false; }}>
        <summary className={styles.walletAddress} title={wallet}>{short(wallet)} <span aria-hidden="true">▾</span></summary>
        <div className={styles.walletDropdown}>
          <span className={styles.walletMenuTitle}>Connected wallet</span>
          <span className={styles.walletMenuAddress} title={wallet}>{short(wallet)}</span>
          <span className={styles.walletMenuPts}>{pts} {IS_LIVE ? "points" : "preview points"}</span>
          <Link className={styles.walletMenuLink} href={`/w/${wallet.toLowerCase()}`} prefetch={false} onClick={() => { if (menu.current) menu.current.open = false; }}>My profile →</Link>
          <button type="button" onClick={disconnect}>Disconnect</button>
          <small>Disconnects from this site only.</small>
        </div>
      </details> :
        <button className={`btn ${styles.cta}`} type="button" onClick={connect} disabled={busy} data-wallet-connect title="Find yourself in every line. Read-only, no transactions.">{busy ? "Connecting…" : "Connect"}</button>}
      {error && <span className={styles.walletError} role="alert">{error} <button type="button" className={styles.walletErrorClose} onClick={() => setError("")} aria-label="Close">×</button></span>}
    </div>
  );
}
