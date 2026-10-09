import { sparklines } from "@/lib/launches";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// /api/spark?tokens=0x…,0x…   24 h price sparklines, up to 60 addresses = one batched upstream call.
// A token missing from "items" is unknown right now (never "flat").
export async function GET(req: Request) {
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const u = new URL(req.url);
  const tokens = (u.searchParams.get("tokens") ?? "").slice(0, 60 * 43).split(",").map((t) => t.trim()).filter(Boolean).slice(0, 60);
  if (!tokens.length) return Response.json({ items: {} }, { headers: { "cache-control": "public, s-maxage=60" } });
  try {
    const items = await sparklines(tokens);
    return Response.json({ items }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
  } catch {
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
