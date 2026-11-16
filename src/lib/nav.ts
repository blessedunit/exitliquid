// The whole menu. Header: MAIN + Buy $EXIT. Burger: MAIN, Buy $EXIT, REF (7 items). Footer: FOOT.
// `also`: extra paths that light up the same item.
export type NavItem = { href: string; label: string; also?: string[] };

export const MAIN: NavItem[] = [
  { href: "/", label: "Launches", also: ["/line"] },
  { href: "/lines", label: "Rankings" },
  { href: "/w", label: "Wallets" },
];
export const REF: NavItem[] = [
  { href: "/state", label: "Market" },
  { href: "/methodology", label: "How grades work" },
  { href: "/status", label: "Status" },
];
export const FOOT: NavItem[] = [...REF, { href: "/manifesto", label: "Manifesto" }];

// Positioning. One place for the words the site says about itself.
export const TAGLINE = "Check any vibe/vibe token before you buy.";
export const ABOUT =
  "Grades every vibe/vibe token A–F before you buy: snipers, bundles, the dev's selling, whales and real volume.";
