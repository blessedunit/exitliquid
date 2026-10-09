import { getTicket, isAddress } from "@/lib/ticket";
import { buildState } from "@/lib/service";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/ticket/[address]">) {
  const { address } = await ctx.params;
  if (!isAddress(address)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  // every new address is a CDN miss that can cost an RPC call: cap lookups per IP
  if (!(await rateLimit(LIMITS.ticket, clientIp(req)))) return tooMany();
  const built = await buildState();
  const t = await getTicket(address, built);
  // an "unknown" ticket (or one read from an old snapshot) must not be cached as if it were the answer
  const cc = t.status === "unknown" || t.stockBacked === null || built.stale ? "no-store" : "public, s-maxage=15, stale-while-revalidate=60";
  return Response.json(t, { headers: { "cache-control": cc } });
}
