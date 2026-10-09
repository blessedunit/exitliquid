import { getDoorWithin } from "@/app/door/data";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";

// the page asks once a minute while visible; a few tabs per IP fit easily
const LIMIT: Limit = { name: "door", limit: 30, windowSec: 60 };

// /api/door: the Graduation watch snapshot (one shared build per minute for every viewer).
// 200 + snapshot; 503 when nothing could be built yet (the page says "unknown", never "none").
export async function GET(req: Request) {
  if (!(await rateLimit(LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  const s = await getDoorWithin(20_000);
  if (!s) return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "20" } });
  return Response.json(s, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } });
}
