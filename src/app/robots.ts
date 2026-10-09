import type { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "@/lib/config";

// /robots.txt: everything public is crawlable; the JSON API is not a page.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${PUBLIC_SITE_URL}/sitemap.xml`,
    host: PUBLIC_SITE_URL,
  };
}
