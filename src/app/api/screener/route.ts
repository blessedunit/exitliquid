import { board, ensureScreener, ON_CF, screenerStats, snapshot } from "@/lib/screener";
import { presentRow } from "@/lib/screener-rules";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";
import type { ScreenerBoard, ScreenerResponse, ScreenerRow } from "@/lib/screener-types";

export const dynamic = "force-dynamic";

// The screener: /api/screener                     -> every graded row (newest launch first)
//               /api/screener?board=clean|risk|sniped|devdump|realvol|whales&limit=10
//               /api/screener?tokens=0x…,0x…     -> rows of these tokens only (the board's grade cells)
//               /api/screener?creator=0x…        -> rows of one creator's launches (the report's dev track)
// Never computes inside the request: the warm loop (lib/screener.ts) fills memory, this serves it.
const BOARDS: ScreenerBoard[] = ["clean", "risk", "sniped", "devdump", "realvol", "whales"];
const HEADERS = { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" };
const ADDR = /^0x[0-9a-f]{40}$/;

/* ---------------- Cloudflare copy: no loop, a pushed or shipped snapshot ---------------- */

let cfSnap: { at: number; v: ScreenerResponse } | null = null;
async function cfSnapshot(req: Request): Promise<ScreenerResponse> {
  if (cfSnap && Date.now() - cfSnap.at < 10 * 60_000) return cfSnap.v;
  let v: ScreenerResponse | null = null;
  try {
    // OpenNext keeps the Workers env on this global (what getCloudflareContext() reads); KV "screener" = PC push
    const ctx = (globalThis as unknown as Record<symbol, { env?: { EXIT_KV?: { get(k: string): Promise<string | null> } } }>)[Symbol.for("__cloudflare-context__")];
    const raw = ctx?.env?.EXIT_KV ? await ctx.env.EXIT_KV.get("screener") : null;
    if (raw) v = JSON.parse(raw) as ScreenerResponse;
  } catch { /* fall through to the static copy */ }
  if (!v) {
    try {
      const r = await fetch(new URL("/screener.json", req.url), { signal: AbortSignal.timeout(4_000) });
      if (r.ok) v = (await r.json()) as ScreenerResponse;
    } catch { /* unknown */ }
  }
  // a snapshot pushed or shipped under other rules: its rows are served without their grades
  const tokens = v && Array.isArray(v.tokens) ? v.tokens.filter((r) => r && typeof r.token === "string").map(presentRow) : [];
  const out = { asOf: Number(v?.asOf) || 0, checked: tokens.filter((r) => r.verdict !== "unknown").length, tokens };
  cfSnap = { at: Date.now(), v: out };
  return out;
}

export async function GET(req: Request) {
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const u = new URL(req.url);
  if (!ON_CF) ensureScreener();
  const snap = ON_CF ? await cfSnapshot(req) : snapshot();

  if (u.searchParams.get("stats") === "1" && !ON_CF) {
    return Response.json({ ...screenerStats(), asOf: snap.asOf, checked: snap.checked }, { headers: { "cache-control": "no-store" } });
  }

  let rows: ScreenerRow[] = snap.tokens;
  const tokens = u.searchParams.get("tokens");
  const creator = (u.searchParams.get("creator") ?? "").toLowerCase();
  const b = BOARDS.find((x) => x === u.searchParams.get("board"));
  if (tokens !== null) {
    const want = new Set(tokens.slice(0, 200 * 43).toLowerCase().split(",").map((t) => t.trim()).filter((t) => ADDR.test(t)));
    rows = rows.filter((r) => want.has(r.token));
  } else if (ADDR.test(creator)) {
    rows = rows.filter((r) => r.creator === creator);
  }
  if (b) rows = board(rows, b);
  else rows = [...rows].sort((x, y) => (x.ageMin ?? 1e12) - (y.ageMin ?? 1e12));
  const lim = Number(u.searchParams.get("limit"));
  if (Number.isFinite(lim) && lim > 0) rows = rows.slice(0, Math.min(500, Math.floor(lim)));

  const body: ScreenerResponse = { asOf: snap.asOf, checked: snap.checked, ...(b ? { board: b } : {}), tokens: rows };
  return Response.json(body, { headers: HEADERS });
}
