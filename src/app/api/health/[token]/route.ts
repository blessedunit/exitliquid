import { buildFor, PLUMBING } from "@/lib/service";
import { loadEvents, ZERO } from "@/lib/chain";
import { healthCached, healthOf } from "@/lib/analytics/healthMemo";
import { earlyIndex } from "@/lib/earlyIndex";
import type { HealthResult } from "@/lib/health";
import { isAddress } from "@/lib/ticket";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

type Body = {
  token: string; grade: string; score: number; verdict: string; partial: boolean;
  reasons: { id: string; label: string; detail: string; severity: string; points: number }[];
  firstBuyers: { wallet: string; tag: string | null; stillHolds: boolean }[];
  counts: unknown; indexAge: number | null; indexStale: boolean; indexWindowDays: number; block: number;
};
// One replay per token per 20 s, shared with the analytics engine (lib/analytics/healthMemo).
function bodyOf(h: HealthResult & { block: number }): Body {
  return {
    token: h.token,
    grade: h.grade,
    score: h.score,
    verdict: h.verdict,
    partial: h.partial,
    reasons: h.reasons,
    firstBuyers: h.firstBuyers.map(({ wallet, tag, stillHolds }) => ({ wallet, tag, stillHolds })),
    counts: h.counts,
    indexAge: h.indexAge,
    indexStale: h.indexStale,
    indexWindowDays: earlyIndex().windowDays,
    block: h.block,
  };
}

// Open to everyone (09.10): every signal with its detail, the first 20 buyers and the counts, for every viewer.
// No cookie read, the same body for everyone, so the CDN carries it. `?vip=1` (old clients) is ignored.
const FREE_HEADERS = { "cache-control": "public, s-maxage=120, stale-while-revalidate=300" };

// Line Health of any vibe/vibe token: /api/health/<token>
// Signals, not verdicts. 404 = not a vibe token; 503 = the chain didn't answer (unknown, never "clean").
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token: rawToken } = await ctx.params;
  if (!isAddress(rawToken)) return Response.json({ error: "bad_address" }, { status: 400, headers: { "cache-control": "no-store" } });
  if (!(await rateLimit(LIMITS.line, clientIp(req), { localOnly: true }))) return tooMany();
  const token = rawToken.toLowerCase();
  try {
    const send = (b: Body) =>
      Response.json(b, { headers: FREE_HEADERS });
    const hit = healthCached(token);
    if (hit) return send(bodyOf(hit));
    const built = await buildFor(token);
    const meta = built.meta;
    if (built.unavailable || built.stale || !meta?.curve) {
      return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    // the raw log behind the line (served from the same per-token cache buildFor just filled)
    const cache = await loadEvents(token, meta);
    const plumbing = new Set<string>([ZERO, meta.curve, ...PLUMBING]);
    const complete = meta.createdBlock > 0n && !meta.creationUnknown;
    const h = healthOf({ token, creator: meta.creator.toLowerCase(), curve: meta.curve.toLowerCase(), raw: cache.raw, plumbing, complete, headBlock: Number(cache.lastBlock), nowSec: Math.floor(Date.now() / 1000) });
    return send(bodyOf(h));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const notVibe = msg.includes("not a vibe token");
    return Response.json({ error: notVibe ? "not_vibe" : "unknown" }, { status: notVibe ? 404 : 503, headers: { "cache-control": "no-store" } });
  }
}
