// A token's own description and links, read defensively from whatever launchInfo returns:
// the fields are optional upstream (vibe content.description / content.socials), and anything
// that isn't a plain http(s) link or a clean handle is dropped, never shown as a placeholder.
import type { TokenAbout } from "@/lib/lineContext";

const LABELS: Record<string, string> = {
  x: "X", twitter: "X", website: "Website", web: "Website", site: "Website", url: "Website",
  telegram: "Telegram", tg: "Telegram", discord: "Discord", github: "GitHub", farcaster: "Farcaster", warpcast: "Farcaster",
};
const HANDLE_BASE: Record<string, string> = { x: "https://x.com/", twitter: "https://x.com/", telegram: "https://t.me/", tg: "https://t.me/" };

function linkFor(key: string, raw: unknown): { label: string; href: string } | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 300) return null;
  const k = key.toLowerCase();
  const label = LABELS[k] ?? (k.length <= 16 && /^[a-z0-9 _-]+$/i.test(k) ? k[0].toUpperCase() + k.slice(1) : null);
  if (!label) return null;
  let href: string | null = null;
  if (/^https?:\/\//i.test(v)) href = v;
  else if (HANDLE_BASE[k] && /^@?[A-Za-z0-9_]{1,32}$/.test(v)) href = HANDLE_BASE[k] + v.replace(/^@/, "");
  else if ((k === "website" || k === "web" || k === "site" || k === "url") && /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v)) href = `https://${v}`;
  if (!href) return null;
  try {
    const u = new URL(href);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { label, href: u.toString() };
  } catch {
    return null;
  }
}

export function tokenAbout(card: unknown): TokenAbout | null {
  if (!card || typeof card !== "object") return null;
  const c = card as { description?: unknown; socials?: unknown };
  const description = typeof c.description === "string" && c.description.trim() ? c.description.trim().replace(/\s+/g, " ").slice(0, 400) : null;
  const links: TokenAbout["links"] = [];
  const socials = c.socials;
  const entries: [string, unknown][] = Array.isArray(socials)
    ? socials.map((s) => (s && typeof s === "object" ? [String((s as { type?: unknown; kind?: unknown }).type ?? (s as { kind?: unknown }).kind ?? ""), (s as { url?: unknown }).url] : ["", null]) as [string, unknown])
    : socials && typeof socials === "object" ? Object.entries(socials as Record<string, unknown>) : [];
  for (const [k, v] of entries) {
    const l = linkFor(k, v);
    if (l && !links.some((x) => x.href === l.href) && links.length < 4) links.push(l);
  }
  return description || links.length ? { description, links } : null;
}
