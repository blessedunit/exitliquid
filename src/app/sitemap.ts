import type { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "@/lib/config";

// /sitemap.xml: the static routes only. Token and wallet pages are reached from the board and search.
const ROUTES: [path: string, freq: MetadataRoute.Sitemap[number]["changeFrequency"], priority: number][] = [
  ["/", "hourly", 1],
  ["/lines", "hourly", 0.8],
  ["/state", "hourly", 0.7],
  ["/w", "weekly", 0.6],
  ["/exit", "daily", 0.6],
  ["/methodology", "monthly", 0.5],
  ["/status", "hourly", 0.3],
  ["/manifesto", "yearly", 0.3],
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map(([path, changeFrequency, priority]) => ({ url: `${PUBLIC_SITE_URL}${path}`, changeFrequency, priority }));
}
