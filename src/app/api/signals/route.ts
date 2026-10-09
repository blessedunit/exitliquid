import { after } from "next/server";
import { boardSignals, indexInfo, SIGNALS_MAX } from "@/lib/signals";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // the answer leaves by ~9 s; slow cold lines finish behind it (after()) into the cache

const ADDR = /^0x[0-9a-f]{40}$/;

// /api/signals?tokens=0x…,0x…[&at=<createdAt>,<createdAt>…]
// A light Line Health for up to 30 tokens (the board's Signals column). `at` is an optional launch-time
// hint per token (unix seconds, same order): it only narrows the search for the launch event, never the answer.
// Signals, not verdicts. A token we couldn't read comes back "unknown", never "clean".
export async function GET(req: Request) {
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const u = new URL(req.url);
  const raw = (u.searchParams.get("tokens") ?? "").slice(0, SIGNALS_MAX * 43).toLowerCase().split(",").map((t) => t.trim());
  const at = (u.searchParams.get("at") ?? "").slice(0, SIGNALS_MAX * 12).split(",");
  const tokens: string[] = [];
  const hints = new Map<string, number>();
  raw.forEach((t, i) => {
    if (!ADDR.test(t) || tokens.includes(t) || tokens.length >= SIGNALS_MAX) return;
    tokens.push(t);
    const h = Number(at[i]);
    if (Number.isInteger(h) && h > 1_600_000_000 && h < Date.now() / 1000 + 3600) hints.set(t, h);
  });
  if (!tokens.length) return Response.json({ items: {}, index: indexInfo() }, { headers: { "cache-control": "public, s-maxage=300" } });
  try {
    const { items: list, rest } = await boardSignals(tokens, hints);
    after(() => rest.catch(() => {}));
    const anyUnknown = list.some((s) => s.status === "unknown");
    return Response.json(
      { items: Object.fromEntries(list.map((s) => [s.token, s])), index: indexInfo() },
      // a batch with unknown rows is cached briefly (the next ask fills them); a clean batch for 5 min
      { headers: { "cache-control": anyUnknown ? "public, s-maxage=20, stale-while-revalidate=40" : "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch {
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
