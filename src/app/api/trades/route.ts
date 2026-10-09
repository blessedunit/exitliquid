import { buildState, tradesPage } from "@/lib/service";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// Older rows of the trade tape: /api/trades?skip=<already loaded>&limit=200
export async function GET(req: Request) {
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const url = new URL(req.url);
  const skip = Math.min(1_000_000, Math.max(0, Math.floor(Number(url.searchParams.get("skip")) || 0)));
  const limit = [100, 200].find((b) => b >= (Number(url.searchParams.get("limit")) || 200)) ?? 200;
  const built = await buildState();
  if (built.unavailable) return Response.json({ trades: [], total: 0, unavailable: true }, { headers: { "cache-control": "no-store" } });
  const page = tradesPage(built, skip, limit);
  return Response.json(page, { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
}
