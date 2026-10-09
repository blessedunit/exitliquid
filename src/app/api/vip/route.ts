import { ACTIVE_TOKEN } from "@/lib/config";
import { isAddress } from "@/lib/ticket";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";
import { VIP_MIN_TOKENS } from "@/lib/vip";
import { exitBalance } from "@/lib/vipGate";

export const dynamic = "force-dynamic";

// Balance check only: does this wallet hold VIP_MIN_TOKENS $EXIT right now (read from the chain, cached 30 s).
// It opens nothing by itself: VIP data needs a signed session (POST /api/vip/session).
export async function GET(req: Request) {
  const wallet = (new URL(req.url).searchParams.get("wallet") ?? "").toLowerCase();
  if (!isAddress(wallet) || !ACTIVE_TOKEN) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.line, clientIp(req), { localOnly: true }))) return tooMany();
  const tokens = await exitBalance(wallet);
  if (tokens === null) return Response.json({ wallet, tokens: null, vip: null, min: VIP_MIN_TOKENS }, { status: 503, headers: { "cache-control": "no-store" } });
  return Response.json({ wallet, tokens, vip: tokens >= VIP_MIN_TOKENS, min: VIP_MIN_TOKENS }, { headers: { "cache-control": "private, max-age=30" } });
}
