import { tokenLine } from "@/lib/lines";
import { isAddr, type ChainCost } from "@/lib/walletProfile";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// each token is a full line build when cold (shared with /api/line and My lines), so a call asks for 10 at most
const COST_LIMIT: Limit = { name: "wcost", limit: 20, windowSec: 60 };
const MAX_TOKENS = 10;
const BUDGET_MS = 20_000;


// Chain cost basis when vibe's positions have none: /api/wprofile/<address>/cost?tokens=0x…,0x…
export async function GET(req: Request, ctx: { params: Promise<{ addr: string }> }) {
  const { addr } = await ctx.params;
  if (!isAddr(addr)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(COST_LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  const w = addr.toLowerCase();
  const tokens = [...new Set((new URL(req.url).searchParams.get("tokens") ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(isAddr))].slice(0, MAX_TOKENS);
  const out: Record<string, ChainCost> = {};
  const deadline = Date.now() + BUDGET_MS;
  const queue = [...tokens];
  // two at a time: tokenLine has its own global slots, this only keeps one profile from taking them all
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      if (Date.now() > deadline) {
        out[t] = { costEth: null, status: "unknown" };
        continue;
      }
      const line = await tokenLine(t).catch(() => null);
      if (!line || line === "busy") {
        out[t] = { costEth: null, status: "unknown" };
        continue;
      }
      const me = line.state.line.find((e) => e.wallet === w);
      // 0 = nothing bought (tokens only transferred in): unknown cost, never a free bag
      out[t] = me ? { costEth: me.positionCostEth > 0 ? me.positionCostEth : null, status: "line" } : { costEth: null, status: "absent" };
    }
  };
  await Promise.all([worker(), worker()]);
  const partial = Object.values(out).some((c) => c.status === "unknown");
  return Response.json({ items: out }, { headers: { "cache-control": partial ? "no-store" : "public, s-maxage=30, stale-while-revalidate=120" } });
}
