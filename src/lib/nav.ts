// Main nav (header + burger sheet). "/" is the token board; /launches is the same board.
// `also`: extra paths that light up the same item.
export type NavItem = { href: string; label: string; also?: string[] };

// what you can DO on the site, in the order people need it
export const MAIN: NavItem[] = [
  { href: "/", label: "Tokens", also: ["/launches", "/line", "/t"] },
  { href: "/door", label: "Door" },
  { href: "/w", label: "Wallets" },
  { href: "/dev", label: "Devs" },
  { href: "/state", label: "Market" },
];
// right cluster of the header (spec §1.10): a ghost link, not a main nav item
export const MY_LINES: NavItem = { href: "/lines", label: "My lines" };
// one footer row: the reference pages (Hall, Leaderboard, Roadmap, Press kit, How it works stay in the burger + FAQ)
export const FOOT_REF: NavItem[] = [
  { href: "/methodology", label: "Methodology" },
  { href: "/status", label: "Status" },
  { href: "/faq", label: "FAQ" },
  { href: "/manifesto", label: "Manifesto" },
];

// Footer and burger groups. Same labels as MAIN everywhere (nav, burger, footer), so a page has one name.
export const TOOL_LINKS: NavItem[] = [
  { href: "/", label: "Tokens" },
  { href: "/door", label: "Door" },
  { href: "/w", label: "Wallets" },
  { href: "/dev", label: "Devs" },
  { href: "/state", label: "Market" },
  { href: "/lines", label: "My lines" },
  { href: "/exit", label: "$EXIT line" },
];
export const DATA_LINKS: NavItem[] = [
  { href: "/methodology", label: "Methodology" },
  { href: "/status", label: "Status" },
  { href: "/board", label: "Leaderboard" },
  { href: "/hall", label: "Hall of Exits" },
];
export const ABOUT_LINKS: NavItem[] = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/faq", label: "FAQ & glossary" },
  { href: "/manifesto", label: "Manifesto" },
  { href: "/map", label: "Roadmap" },
  { href: "/kit", label: "Press kit" },
];
/** everything that isn't in MAIN (kept for old imports) */
export const SECONDARY: NavItem[] = [{ href: "/exit", label: "$EXIT line" }, ...DATA_LINKS, ...ABOUT_LINKS];

// Positioning. One place for the words the site says about itself.
export const TAGLINE = "See who's in line before you buy.";
export const ABOUT =
  "Live checks for every vibe/vibe launch: snipers, bundles, the dev's bag, real volume and time to graduation. Signals, not verdicts.";
