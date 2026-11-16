import { sparklines, v6Sparklines, type Spark, type V6SparkAsk } from "@/lib/launches";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// /api/spark?tokens=0x…,0x…        v1: 24 h price sparklines, up to 60 addresses = one batched upstream call
// /api/spark?v6=0x…:1,0x…:5        v6: one candle call per token (vibe has no batch for v6), 1m or 5m candles,
//                                   up to 48; the line also carries the last hour (volume, buys, sells)
// A token missing from "items" is unknown right now (never "flat").
export async function GET(req: Request) {
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const u = new URL(req.url);
  const tokens = (u.searchParams.get("tokens") ?? "").slice(0, 60 * 43).split(",").map((t) => t.trim()).filter(Boolean).slice(0, 60);
  const v6: V6SparkAsk[] = (u.searchParams.get("v6") ?? "")
    .slice(0, 48 * 46)
    .split(",")
    .map((x) => x.trim().split(":"))
    .filter(([t]) => !!t)
    .slice(0, 48)
    .map(([t, iv]) => ({ token: t, iv: iv === "1" ? "1m" : "5m" }));
  if (!tokens.length && !v6.length) return Response.json({ items: {} }, { headers: { "cache-control": "public, s-maxage=60" } });
  try {
    const [a, b] = await Promise.allSettled([tokens.length ? sparklines(tokens) : Promise.resolve({}), v6.length ? v6Sparklines(v6) : Promise.resolve({})]);
    if (a.status === "rejected" && b.status === "rejected") throw a.reason;
    const items: Record<string, Spark> = { ...(a.status === "fulfilled" ? a.value : {}), ...(b.status === "fulfilled" ? b.value : {}) };
    // a v6 answer with tokens left out (slow upstream) is cached briefly: the next ask fills them from the memo
    const partial = v6.length > 0 && v6.some((x) => !items[x.token.toLowerCase()]);
    const cc = partial ? "public, s-maxage=10" : v6.length ? "public, s-maxage=60, stale-while-revalidate=120" : "public, s-maxage=300, stale-while-revalidate=600";
    return Response.json({ items }, { headers: { "cache-control": cc } });
  } catch {
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
