import { devLinks } from "@/lib/devrep";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";

// cold: a few explorer calls (shared budget with Top holders) + up to 8 small vibe calls; then 30 min
const LIMIT: Limit = { name: "devlinks", limit: 20, windowSec: 60 };

// Linked wallets of a dev (funding cluster): /api/dev/<creator>/links
export async function GET(req: Request, ctx: { params: Promise<{ addr: string }> }) {
  const { addr } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  try {
    const l = await devLinks(addr);
    return Response.json(l, { headers: { "cache-control": l.unknown.length ? "public, s-maxage=60" : "public, s-maxage=1800, stale-while-revalidate=3600" } });
  } catch {
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
