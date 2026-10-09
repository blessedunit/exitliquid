import { topHolders } from "@/lib/holders";
import { isAddress } from "@/lib/ticket";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";

// each request may cost up to ~25 explorer calls while a line is cold: keep it tight per IP
const HOLDERS_LIMIT: Limit = { name: "holders", limit: 30, windowSec: 60 };

// Top holders with funding clusters: /api/holders/<token>
// Open to everyone (09.10): no session, no cookie read, the same body for every viewer, so a complete
// answer may sit in the CDN 5 min (topHolders keeps its own server-side caches: funders "forever", holders 5 min).
// The panel loads it lazily (only when scrolled into view): the PC is the server.
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isAddress(token)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(HOLDERS_LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  try {
    const body = await topHolders(token);
    // still filling in: the panel asks again shortly; complete: shared caches may keep it 5 min
    return Response.json(body, {
      headers: { "cache-control": body.pending > 0 ? "no-store" : "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch {
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
