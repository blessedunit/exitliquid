import { isAddr, walletProfile } from "@/lib/walletProfile";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// a cold profile costs ~10 external calls (all cached afterwards), so the per-IP limit is modest
const PROFILE_LIMIT: Limit = { name: "wprofile", limit: 30, windowSec: 60 };

// Wallet profile: /api/wprofile/<address>. Read-only, public data only.
export async function GET(req: Request, ctx: { params: Promise<{ addr: string }> }) {
  const { addr } = await ctx.params;
  if (!isAddr(addr)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(PROFILE_LIMIT, clientIp(req)))) return tooMany();
  try {
    const p = await walletProfile(addr);
    // a profile with an unknown section must not sit in the CDN as the answer
    const cc = p.partial ? "public, s-maxage=30, stale-while-revalidate=60" : "public, s-maxage=300, stale-while-revalidate=600";
    return Response.json(p, { headers: { "cache-control": cc } });
  } catch {
    return Response.json({ error: "unknown", wallet: addr.toLowerCase() }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
