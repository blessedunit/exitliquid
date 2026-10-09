import { buildState } from "@/lib/service";
import { isAddress } from "@/lib/ticket";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/points/[address]">) {
  const { address } = await ctx.params;
  if (!isAddress(address)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.ticket, clientIp(req)))) return tooMany();

  const built = await buildState();
  const unavailable = built.unavailable || built.stale;
  const entry = unavailable ? null : built.state.line.find((person) => person.wallet === address.toLowerCase());
  return Response.json({
    points: unavailable ? null : entry?.lp ?? 0,
    place: entry?.place ?? null,
    unavailable: !!unavailable,
  }, { headers: { "cache-control": unavailable ? "no-store" : "public, s-maxage=15, stale-while-revalidate=30" } });
}
