import { isAddress } from "@/lib/ticket";
import { scanComplete, scanWallet } from "@/lib/lines";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// My Lines: the vibe tokens a wallet holds + ETH and stock balances. Read-only.
export async function GET(req: Request, ctx: RouteContext<"/api/wallet/[address]">) {
  const { address } = await ctx.params;
  if (!isAddress(address)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.wallet, clientIp(req)))) return tooMany();
  const scan = await scanWallet(address);
  if (!scan) return Response.json({ error: "unknown", wallet: address.toLowerCase() }, { status: 503, headers: { "cache-control": "no-store" } });
  // a partial scan (ETH, stocks or some tokens unread) must not sit in the CDN as if it were the answer
  const cc = scanComplete(scan) ? "public, s-maxage=60, stale-while-revalidate=120" : "no-store";
  return Response.json(scan, { headers: { "cache-control": cc } });
}
