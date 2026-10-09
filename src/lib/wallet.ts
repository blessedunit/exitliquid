"use client";
// Wallet helpers. We only ever read the address and ask for a free personal_sign
// (Exit Run board). No transactions, ever.
// With Privy configured, Connect opens the Privy modal (email / X / Google = a wallet made for you,
// or MetaMask, Rabby, WalletConnect...); without it, the browser wallet (window.ethereum) is used.

type Eth = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

export type WalletBridge = {
  connect: () => Promise<string>;
  provider: (address: string) => Promise<Eth | null>;
  disconnect: () => Promise<void>;
};

let bridge: WalletBridge | null = null;

/** Privy is configured: it is the only source of the connected wallet (the header never auto-reads the extension). */
export const PRIVY_ENABLED = !!(process.env.NEXT_PUBLIC_PRIVY_APP_ID || "").trim();

// The wallet a Privy session holds (email / Google / X / linked wallet). Survives the OAuth redirect:
// the Privy layer re-publishes it after the page comes back.
let privyAddr: string | null = null;
export function getPrivyAddress() {
  return privyAddr;
}
export function setPrivyAddress(a: string | null) {
  const v = a ? a.toLowerCase() : null;
  if (v === privyAddr) return;
  privyAddr = v;
  window.dispatchEvent(new CustomEvent("exit-privy-wallet", { detail: v }));
}
/** Set by the Privy bridge (components/Providers.tsx) once the SDK is ready. */
export function setWalletBridge(b: WalletBridge | null) {
  bridge = b;
}

function eth(): Eth {
  const w = window as unknown as { ethereum?: Eth };
  if (!w.ethereum) throw new Error("No wallet in this browser (in-app browsers like X don't have one). Open exitliquid.fun in your wallet app, or paste your address on My lines.");
  return w.ethereum;
}

export async function connectWallet(): Promise<string> {
  if (bridge) return (await bridge.connect()).toLowerCase();
  const accs = (await eth().request({ method: "eth_requestAccounts" })) as string[];
  if (!accs?.[0]) throw new Error("Wallet returned no account.");
  return accs[0].toLowerCase();
}

export async function disconnectWallet(): Promise<void> {
  if (bridge) await bridge.disconnect();
}

export async function signMessage(address: string, message: string): Promise<string> {
  const hex =
    "0x" +
    Array.from(new TextEncoder().encode(message))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const p = (bridge && (await bridge.provider(address))) || eth();
  return (await p.request({ method: "personal_sign", params: [hex, address] })) as string;
}

export function hasWallet() {
  if (bridge) return true;
  return typeof window !== "undefined" && !!(window as unknown as { ethereum?: unknown }).ethereum;
}
