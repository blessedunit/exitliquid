import { isAddr, walletEntries } from "@/lib/walletProfile";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// the page polls this until every entry is ranked (a few calls); ranked entries are cached for good
const ENTRIES_LIMIT: Limit = { name: "wentries", limit: 40, windowSec: 60 };

// Early entries of one wallet: /api/wprofile/<address>/entries
export async function GET(req: Request, ctx: { params: Promise<{ addr: string }> }) {
  const { addr } = await ctx.params;
  if (!isAddr(addr)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(ENTRIES_LIMIT, clientIp(req)))) return tooMany();
  try {
    const e = await walletEntries(addr);
    const done = e.status === "ok" && e.pending === 0 && e.errors === 0;
    return Response.json(e, { headers: { "cache-control": done ? "public, s-maxage=60, stale-while-revalidate=300" : "no-store" } });
  } catch {
    return Response.json({ error: "unknown", wallet: addr.toLowerCase() }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
