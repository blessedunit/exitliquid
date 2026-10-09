import { devPassport } from "@/lib/devrep";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";

// cold: up to 3 vibe pages + fees + a few RPC calls; then 5 min in memory and at the CDN
const LIMIT: Limit = { name: "devpass", limit: 30, windowSec: 60 };

// Dev Passport data: /api/dev/<creator>/passport
export async function GET(req: Request, ctx: { params: Promise<{ addr: string }> }) {
  const { addr } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  try {
    const p = await devPassport(addr);
    const partial = p.chain !== "ok" || p.fees.status === "unknown";
    // a stale copy (vibe failed just now) must not sit at the CDN as the answer
    const cc = p.stale ? "no-store" : partial ? "public, s-maxage=60" : "public, s-maxage=300, stale-while-revalidate=1800";
    return Response.json(p, { headers: { "cache-control": cc } });
  } catch {
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
