import { isAddress } from "@/lib/ticket";
import { placeIn } from "@/lib/lines";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// Where a wallet stands in any vibe token's line: /api/line/<token>?wallet=<address>
export async function GET(req: Request, ctx: RouteContext<"/api/line/[token]">) {
  const { token } = await ctx.params;
  const wallet = new URL(req.url).searchParams.get("wallet") ?? "";
  if (!isAddress(token) || !isAddress(wallet)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.line, clientIp(req)))) return tooMany();
  const p = await placeIn(token, wallet);
  const cc = p.status === "unknown" || p.status === "busy" || p.stale ? "no-store" : "public, s-maxage=20, stale-while-revalidate=60";
  return Response.json(p, { headers: { "cache-control": cc } });
}
