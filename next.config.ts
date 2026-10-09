import type { NextConfig } from "next";

// Security headers.
// CSP without nonces on purpose: most pages are static/prerendered, and nonces would force
// every page to render per request (docs: guides/content-security-policy). Next's inline
// bootstrap scripts therefore need 'unsafe-inline'; XSS is kept out by React escaping,
// no dangerouslySetInnerHTML anywhere, and on-chain strings being cleaned (lib/chain.ts).
// Everything the page loads is same-origin: fonts are self-hosted (next/font/local),
// sprites/kit art live in /public, OG images are same-origin routes, all fetches go to /api.
// Wallets are browser extensions: they inject from their own context and are not
// affected by the page CSP (the page only calls window.ethereum.request).
const isDev = process.env.NODE_ENV === "development";
// Vercel preview deployments inject the Vercel toolbar from vercel.live; production doesn't.
const isVercelPreview = process.env.VERCEL_ENV === "preview";
const vercelLive = isVercelPreview ? " https://vercel.live" : "";
// upgrade-insecure-requests would also "upgrade" http://127.0.0.1 during local QA: prod only.
const onVercel = !!process.env.VERCEL;

// Privy sign-in (email / X / Google / WalletConnect): only when an app id is set (docs.privy.io, "CSP").
const privy = !!(process.env.NEXT_PUBLIC_PRIVY_APP_ID || "").trim();
const P = {
  script: privy ? " https://challenges.cloudflare.com" : "",
  img: privy ? " https://explorer-api.walletconnect.com https://*.walletconnect.com https://*.walletconnect.org" : "",
  connect: privy
    ? " https://auth.privy.io wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com https://pulse.walletconnect.org https://api.web3modal.org https://rpc.testnet.chain.robinhood.com"
    : "",
  frame: privy ? " https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com" : "",
};

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}${vercelLive}${P.script}`,
  `style-src 'self' 'unsafe-inline'${vercelLive}`,
  `img-src 'self' data: blob:${vercelLive ? " https://vercel.live https://vercel.com" : ""}${P.img}`,
  `font-src 'self' data:${vercelLive ? " https://vercel.live https://assets.vercel.com" : ""}`,
  "media-src 'self'",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}${vercelLive ? " https://vercel.live wss://ws-us3.pusher.com" : ""}${P.connect}`,
  `frame-src ${vercelLive || P.frame ? `${vercelLive}${P.frame}`.trim() : "'none'"}`
  ,`child-src ${P.frame ? P.frame.trim() : "'none'"}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  ...(onVercel ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" }, // legacy twin of frame-ancestors 'none'
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), browsing-topics=()",
  },
  // allow-popups: the X share intent opens in a new window
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // 2 years; no `preload` (that is a one-way commitment for the whole domain)
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

// Build-time sanity check of the launch env (lib/config.ts falls back to PREVIEW on a bad value).
for (const key of ["NEXT_PUBLIC_EXIT_TOKEN", "NEXT_PUBLIC_EXIT_CREATOR"] as const) {
  const v = (process.env[key] || "").trim();
  if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    console.error(
      key === "NEXT_PUBLIC_EXIT_TOKEN"
        ? "[EXIT] NEXT_PUBLIC_EXIT_TOKEN is set but invalid, site will run in PREVIEW mode"
        : "[EXIT] NEXT_PUBLIC_EXIT_CREATOR is set but invalid",
    );
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false, // no "X-Powered-By: Next.js"
  productionBrowserSourceMaps: false, // explicit: never ship source maps to browsers
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // /ticket was merged into /lines (My Lines shows the $EXIT boarding pass too).
  // Exit Run was retired: /run points at the manifesto.
  async redirects() {
    return [
      { source: "/ticket", destination: "/lines", permanent: true },
      { source: "/run", destination: "/manifesto", permanent: true },
      { source: "/run/:path*", destination: "/manifesto", permanent: true },
    ];
  },
};

export default nextConfig;
