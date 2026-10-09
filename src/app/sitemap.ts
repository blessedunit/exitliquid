import type { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "@/lib/config";

// /sitemap.xml: the static routes only. Token, wallet and dev pages are reached from the board and search.
// "/launches" is left out: it renders the same board as "/".
const ROUTES: [path: string, freq: MetadataRoute.Sitemap[number]["changeFrequency"], priority: number][] = [
  ["/", "hourly", 1],
  ["/state", "hourly", 0.8],
  ["/w", "weekly", 0.6],
  ["/dev", "weekly", 0.6],
  ["/exit", "daily", 0.6],
  ["/board", "daily", 0.5],
  ["/hall", "daily", 0.5],
  ["/methodology", "monthly", 0.5],
  ["/status", "hourly", 0.3],
  ["/how-it-works", "monthly", 0.4],
  ["/faq", "monthly", 0.4],
  ["/manifesto", "yearly", 0.3],
  ["/map", "monthly", 0.3],
  ["/kit", "yearly", 0.2],
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(([path, changeFrequency, priority]) => ({ url: `${PUBLIC_SITE_URL}${path}`, changeFrequency, priority }));
}
