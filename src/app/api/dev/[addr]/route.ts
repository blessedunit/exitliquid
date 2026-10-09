import { devReputation } from "@/lib/devrep";
import { isAddress } from "@/lib/ticket";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";

// one vibe call per creator per 10 min (shared cache), so a generous per-IP limit is enough
const DEV_LIMIT: Limit = { name: "dev", limit: 60, windowSec: 60 };

// Every launch by one creator: /api/dev/<creator address>
export async function GET(req: Request, ctx: { params: Promise<{ addr: string }> }) {
  const { addr } = await ctx.params;
  if (!isAddress(addr)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(DEV_LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  try {
    const rep = await devReputation(addr);
    return Response.json(rep, { headers: { "cache-control": "public, s-maxage=600, stale-while-revalidate=3600" } });
  } catch {
    // vibe didn't answer: unknown, the page shows no badge (never a made-up "1st launch")
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
