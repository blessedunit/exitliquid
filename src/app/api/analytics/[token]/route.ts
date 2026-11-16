import { analyticsFor, NotVibeError } from "@/lib/analytics/engine";
import { analyticsV6, isKnownV6 } from "@/lib/analytics/v6engine";
import { isAddress } from "@/lib/ticket";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// Token analytics of any vibe/vibe token: /api/analytics/<token>
// Signals, not verdicts. 404 = not a vibe token; 503 = the chain didn't answer (unknown, never "clean").
// Open to everyone (09.10): one full answer for every viewer, no cookie read, no session. The same body for
// everyone, so it sits in the CDN. `?vip=1` (old clients) is ignored: same body, same headers, never 401.
// CPU diet (05.10): the answer sits in the CDN 2 min and is served stale up to 5 more while one request
// rebuilds it; the client polls every 2 min.
const FREE_HEADERS = { "cache-control": "public, s-maxage=120, stale-while-revalidate=300" };

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: rawToken } = await ctx.params;
  if (!isAddress(rawToken)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.line, clientIp(req), { localOnly: true }))) return tooMany();
  try {
    const t = rawToken.toLowerCase();
    // v1 first (unchanged); a token no v1 factory launched is tried as a taxed v6 launch (16.10)
    const a = isKnownV6(t)
      ? await analyticsV6(t)
      : await analyticsFor(t).catch((e) => {
        if (e instanceof NotVibeError) return analyticsV6(t);
        throw e;
      });
    return Response.json(a, { headers: FREE_HEADERS });
  } catch (e) {
    const notVibe = e instanceof NotVibeError;
    if (!notVibe) console.error("analytics failed", rawToken.slice(0, 42), String((e as Error)?.message ?? e).slice(0, 200));
    return Response.json({ error: notVibe ? "not_vibe" : "unknown" }, { status: notVibe ? 404 : 503, headers: { "cache-control": "no-store" } });
  }
}
