import { after } from "next/server";
import { pendingBuild, readState } from "@/lib/state";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";
// a cold instance reads the whole factory history once (~130 getLogs calls): let the build finish
export const maxDuration = 300;

const LIMIT: Limit = { name: "state", limit: 60, windowSec: 60 };

// /api/state: the State of vibe snapshot.
// 200 + snapshot (CDN-cached; a stale one is served while a new build runs in the background),
// 202 {status:"warming"} while the very first build runs (the page polls), 503 when nothing could be built.
export async function GET(req: Request) {
  if (!(await rateLimit(LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  const r = await readState(20_000);
  const job = pendingBuild();
  if (job) after(() => job.catch(() => undefined));
  if (!r.snapshot) {
    return Response.json(
      { status: r.building ? "warming" : "unavailable", stage: r.stage },
      { status: r.building ? 202 : 503, headers: { "cache-control": "no-store", "retry-after": "10" } },
    );
  }
  return Response.json(
    { status: r.fresh ? "ok" : "stale", building: r.building, snapshot: r.snapshot },
    {
      headers: {
        // fresh: the CDN keeps it 15 min (a build is fresh 15 min) and serves it stale for an hour more while one request rebuilds
        "cache-control": r.fresh ? "public, s-maxage=900, stale-while-revalidate=3600" : "public, s-maxage=60, stale-while-revalidate=600",
      },
    },
  );
}
