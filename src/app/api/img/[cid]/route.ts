// Token pictures through our CDN (see lib/ipfsImage.ts): one slow fetch, then instant for everyone.
// ?w=96|256 returns a small square WebP (a list of 24 logos drops from ~3 MB to ~100 KB).
import sharp from "sharp";
import { ipfsImage, isCid } from "@/lib/ipfsImage";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

const SIZES = [96, 256];

export async function GET(req: Request, ctx: RouteContext<"/api/img/[cid]">) {
  const { cid } = await ctx.params;
  if (!isCid(cid)) return new Response("bad cid", { status: 400 });
  // one cache entry per picture: any extra query parameter would bypass the CDN, refuse it
  const u = new URL(req.url);
  if ([...u.searchParams.keys()].some((k) => k !== "w")) return new Response("bad query", { status: 400 });
  if (!(await rateLimit(LIMITS.img, clientIp(req), { localOnly: true }))) return tooMany();
  const img = await ipfsImage(cid);
  if (!img) return new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=300" } });
  const w = Number(u.searchParams.get("w"));
  const cache = "public, max-age=31536000, immutable";
  if (SIZES.includes(w) && img.type !== "image/svg+xml") {
    try {
      const out = await sharp(Buffer.from(img.body), { animated: false, limitInputPixels: 40_000_000 }).resize(w, w, { fit: "cover" }).webp({ quality: 78 }).toBuffer();
      return new Response(new Uint8Array(out), { headers: { "content-type": "image/webp", "cache-control": cache, "x-content-type-options": "nosniff" } });
    } catch {
      // odd file: fall through to the original
    }
  }
  const headers: Record<string, string> = { "content-type": img.type, "cache-control": cache, "x-content-type-options": "nosniff" };
  // svg can carry scripts: serve it as an inert image only
  if (img.type === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
  return new Response(img.body, { headers });
}
