import { v6Line } from "@/lib/v6";
import { isAddress } from "@/lib/ticket";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// A taxed v6 launch's line lite: /api/v6/<token> (holders by bag, trades, stats; all read from vibe/vibe).
// Two upstream calls at most per 12 s per server instance, shared through the data cache.
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isAddress(token)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.line, clientIp(req), { localOnly: true }))) return tooMany();
  try {
    const line = await v6Line(token);
    if (!line) return Response.json({ error: "not_v6" }, { status: 404, headers: { "cache-control": "public, s-maxage=60" } });
    // the market part missing = unknown right now: never cached as an answer
    return Response.json(line, { headers: { "cache-control": line.updatedAt ? "public, s-maxage=20, stale-while-revalidate=60" : "no-store" } });
  } catch {
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
