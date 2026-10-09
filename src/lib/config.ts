// Project-wide constants. Everything that changes at launch lives here or in env.

export const CHAIN_ID = 46630;
// The public RPC, safe to print on pages. A private EXIT_RPC_URL (may carry an API key) is
// read only in server-only lib/chain.ts and must never be rendered or shipped to the client.
export const PUBLIC_RPC_URL = "https://rpc.testnet.chain.robinhood.com";
export const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
export const VIBE_APP = "https://testnet.vibevibe.fun";

// $EXIT token address. Empty until launch -> the site runs in DEMO mode
// on a live testnet token so every block works on real on-chain data.
export const EXIT_TOKEN = (process.env.NEXT_PUBLIC_EXIT_TOKEN || "").trim().toLowerCase();
// Creator wallet of $EXIT (#1 in line, "The Dev").
export const EXIT_CREATOR = (process.env.NEXT_PUBLIC_EXIT_CREATOR || "").trim().toLowerCase();
// Demo token used before launch (set to a real vibe testnet launch).
export const DEMO_TOKEN = (process.env.NEXT_PUBLIC_DEMO_TOKEN || "").trim().toLowerCase();

// A malformed env value (typo, stray quote) keeps the site in PREVIEW instead of going live broken.
export const IS_LIVE = /^0x[0-9a-f]{40}$/.test(EXIT_TOKEN);
export const ACTIVE_TOKEN = IS_LIVE ? EXIT_TOKEN : DEMO_TOKEN;

export const PUBLIC_SITE_URL = "https://exitliquid.fun";
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || PUBLIC_SITE_URL;
export const X_HANDLE = process.env.NEXT_PUBLIC_X_HANDLE || "exitliqfun";
export const X_URL = `https://x.com/${X_HANDLE}`;
/** the public source code (README, changelog, MIT) */
export const GITHUB_URL = "https://github.com/blessedunit/exitliquid";
// Hide X links until the account really exists (set NEXT_PUBLIC_X_LIVE=1).
export const X_LIVE = process.env.NEXT_PUBLIC_X_LIVE === "1";
export const VIBE_X = "vibevibefun";

// The CTA has its final label at all times. Before launch it stays inside the site on /exit
// at the rules of the $EXIT line (on /exit itself it scrolls to them, never a self-link), not on
// /lines, which says nothing about $EXIT;
// once the token address exists it points to the real vibe/vibe token page.
export const CTA = IS_LIVE
  ? { href: `${VIBE_APP}/token/${EXIT_TOKEN}`, label: "Get in line", external: true }
  : { href: "/exit#h-rules", label: "Get in line", external: false };

export const DISCLAIMER =
  "Independent community project built on the vibe/vibe testnet. Not affiliated with vibe/vibe or Robinhood Markets. Testnet tokens have no value.";
