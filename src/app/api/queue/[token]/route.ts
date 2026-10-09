import { buildFor, toQueueResponse } from "@/lib/service";
import { ethUsdPrice } from "@/lib/ethPrice";
import { isAddress } from "@/lib/ticket";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// The line of any vibe/vibe token: /api/queue/<token>?limit=200 (same shape as /api/queue)
export async function GET(req: Request, ctx: RouteContext<"/api/queue/[token]">) {
  const { token } = await ctx.params;
  if (!isAddress(token)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.line, clientIp(req), { localOnly: true }))) return tooMany();
  const asked = Number(new URL(req.url).searchParams.get("limit")) || 200;
  const limit = [50, 200, 1000].find((b) => b >= asked) ?? 1000;
  try {
    const [built, ethUsd] = await Promise.all([buildFor(token), ethUsdPrice()]);
    const body = toQueueResponse(built, limit, ethUsd);
    return Response.json(body, {
      headers: { "cache-control": body.unavailable || built.stale ? "no-store" : "public, s-maxage=15, stale-while-revalidate=600" },
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // "not a vibe token" is an answer; anything else (slow chain) is unknown, never "empty"
    const notVibe = msg.includes("not a vibe token");
    return Response.json({ error: notVibe ? "not_vibe" : "unknown" }, { status: notVibe ? 404 : 503, headers: { "cache-control": "no-store" } });
  }
}
