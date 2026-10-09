import { statusReport } from "@/lib/status";
import { clientIp, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// Freshness of every data source (same probes as /status). Probes are shared for 60 s across visitors.
export async function GET(req: Request) {
  if (!(await rateLimit({ name: "status", limit: 60, windowSec: 60 }, clientIp(req), { localOnly: true }))) return tooMany();
  const r = await statusReport();
  return Response.json(r, { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=120" } });
}
