import { buildState, toQueueResponse } from "@/lib/service";
import { ethUsdPrice } from "@/lib/ethPrice";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // cheap, CDN-cached route: in-memory limit only, no Upstash command per poll
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const url = new URL(req.url);
  // fixed buckets: odd values can't split the CDN cache
  const asked = Number(url.searchParams.get("limit")) || 200;
  const limit = [50, 200, 1000].find((b) => b >= asked) ?? 1000;
  // ETH/USD is display-only (PnL in $); the line never depends on it
  const [built, ethUsd] = await Promise.all([buildState(), ethUsdPrice()]);
  const body = toQueueResponse(built, limit, ethUsd);
  return Response.json(body, {
    // unknown or an old snapshot: never let the CDN keep it as the answer
    headers: { "cache-control": body.unavailable || built.stale ? "no-store" : "public, s-maxage=15, stale-while-revalidate=60" },
  });
}
