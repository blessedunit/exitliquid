"use client";
// The heavy part (Privy SDK, ~800 KB): loaded only when someone presses Connect,
// or in the background for a returning signed-in visitor. Renders no page content, only the modal.
import { useEffect, useRef } from "react";
import { PrivyProvider, useCreateWallet, useLogin, useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { CHAIN_ID, EXPLORER, PUBLIC_RPC_URL } from "@/lib/config";
import { setPrivyAddress, type WalletBridge } from "@/lib/wallet";

const robinhoodTestnet = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: "Explorer", url: EXPLORER } },
  testnet: true,
});

type Pending = { resolve: (a: string) => void; reject: (e: Error) => void } | null;
type U = ReturnType<typeof usePrivy>["user"];
type Ws = ReturnType<typeof useWallets>["wallets"];

/** The wallet that belongs to the signed-in user: the primary linked one, else a connected wallet that is linked.
 * Never "whatever wallet the browser has" (a stale MetaMask account must not show up as the user). */
function userAddress(authenticated: boolean, user: U, wallets: Ws): string {
  if (!authenticated || !user) return "";
  const primary = user.wallet?.address?.toLowerCase();
  if (primary) return primary;
  const linked = new Set(
    (user.linkedAccounts ?? []).filter((a) => a.type === "wallet").map((a) => String((a as { address?: string }).address ?? "").toLowerCase()),
  );
  const w = wallets.find((x) => linked.has(x.address.toLowerCase()));
  return w ? w.address.toLowerCase() : "";
}

function Bridge({ onReady }: { onReady: (b: WalletBridge) => void }) {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const { logout } = useLogout();
  const pending = useRef<Pending>(null);
  // after Disconnect the SDK state lags a moment: until the next sign-in finishes, nothing old may be shown
  const signedOut = useRef(false);
  const loggingOut = useRef<Promise<void> | null>(null);
  const expectUser = useRef<string | null>(null); // id of the account that just signed in
  const state = useRef({ authenticated, user, wallets });

  useEffect(() => {
    state.current = { authenticated, user, wallets };
    if (!ready) return;
    // signed out: only a finished new sign-in (onComplete) may publish an address again,
    // so the previous account can never flash back while the SDK catches up
    if (signedOut.current) {
      setPrivyAddress(null);
      return;
    }
    // right after a new sign-in, ignore a stale user object until the SDK shows the new account
    if (expectUser.current && user?.id !== expectUser.current) return;
    const a = userAddress(authenticated, user, wallets);
    setPrivyAddress(a || null);
    if (a && pending.current) {
      pending.current.resolve(a);
      pending.current = null;
      signedOut.current = false;
    }
  }, [ready, authenticated, user, wallets]);

  const { createWallet } = useCreateWallet();
  const creating = useRef(false);
  // signed in with email / Google / X but no wallet yet: create the embedded one
  useEffect(() => {
    if (!ready || !authenticated || signedOut.current || creating.current) return;
    if (userAddress(authenticated, user, wallets)) return;
    creating.current = true;
    createWallet()
      .catch(() => {})
      .finally(() => {
        creating.current = false;
      });
  }, [ready, authenticated, user, wallets, createWallet]);

  const { login } = useLogin({
    onComplete: ({ user: u }) => {
      signedOut.current = false;
      try { localStorage.setItem("exit.privy.signed", "1"); } catch { /* storage can be blocked */ }
      expectUser.current = u?.id ?? null;
      const a = userAddress(true, u, state.current.wallets);
      if (a) setPrivyAddress(a);
      if (!pending.current) return;
      if (a) {
        pending.current.resolve(a);
        pending.current = null;
        return;
      }
      // the wallet is still being created: the effect above resolves it; give up after 20 s
      const p = pending.current;
      setTimeout(() => {
        if (pending.current === p) {
          p.reject(new Error("Signed in, but the wallet isn't ready yet. Press Connect again in a moment."));
          pending.current = null;
        }
      }, 20_000);
    },
    onError: (err) => {
      pending.current?.reject(new Error(String(err) === "exited_auth_flow" ? "Sign-in closed." : `Sign-in failed: ${String(err)}`));
      pending.current = null;
    },
  });

  useEffect(() => {
    if (!ready) return;
    onReady({
      connect: async () => {
        if (loggingOut.current) await loggingOut.current.catch(() => {});
        const s = state.current;
        const have = !signedOut.current ? userAddress(s.authenticated, s.user, s.wallets) : "";
        if (have) return have;
        pending.current?.reject(new Error("Sign-in restarted."));
        return new Promise<string>((resolve, reject) => {
          pending.current = { resolve, reject };
          login();
        });
      },
      provider: async (address) => {
        const w = state.current.wallets.find((x) => x.address.toLowerCase() === address.toLowerCase());
        return w ? ((await w.getEthereumProvider()) as never) : null;
      },
      disconnect: async () => {
        signedOut.current = true;
        try { localStorage.removeItem("exit.privy.signed"); } catch { /* storage can be blocked */ }
        expectUser.current = null;
        setPrivyAddress(null);
        pending.current?.reject(new Error("Disconnected."));
        pending.current = null;
        loggingOut.current = logout().finally(() => {
          loggingOut.current = null;
        });
        await loggingOut.current;
      },
    });
  }, [ready, login, logout, onReady]);

  return null;
}

export default function PrivyLayer({ appId, onReady }: { appId: string; onReady: (b: WalletBridge) => void }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "google", "twitter", "wallet"],
        appearance: { theme: "dark", accentColor: "#3ddc84", landingHeader: "Get in line", walletChainType: "ethereum-only" },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: robinhoodTestnet,
        supportedChains: [robinhoodTestnet],
      }}
    >
      <Bridge onReady={onReady} />
    </PrivyProvider>
  );
}
