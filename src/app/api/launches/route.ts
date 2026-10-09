import { after } from "next/server";
import { launchCards, launchPage, type LaunchCard, type LaunchTab } from "@/lib/launches";
import { ipfsImage } from "@/lib/ipfsImage";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

const TABS: LaunchTab[] = ["new", "hot", "door", "grad"];

// warm a page's pictures in the background (data cache): the next viewer gets them instantly
function warmImages(items: LaunchCard[]) {
  after(async () => {
    const cids = items.map((c) => c.image?.match(/^\/api\/img\/([a-zA-Z0-9]+)(?:\?|$)/)?.[1]).filter((x): x is string => !!x);
    for (let i = 0; i < cids.length; i += 6) await Promise.all(cids.slice(i, i + 6).map((c) => ipfsImage(c, 12_000)));
  });
}

// /api/launches?tab=new|hot|door|grad&q=<ticker|name|0x…>&cursor=…
// /api/launches?tokens=0x…,0x…   (watchlist: up to 20 addresses, one batched upstream call)
// /api/launches?tokens=…&v1=1    (live refresh of rows loaded with "More": known v1 rows, no v6 lookups)
export async function GET(req: Request) {
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const u = new URL(req.url);
  try {
    const tokensParam = u.searchParams.get("tokens");
    if (tokensParam !== null) {
      const tokens = tokensParam.slice(0, 20 * 43).split(",").map((t) => t.trim()).filter(Boolean);
      const r = await launchCards(tokens, { v6Lookup: u.searchParams.get("v1") !== "1" });
      warmImages(r.items);
      return Response.json({ items: r.items, next: null, asOfBlock: null, v6: "off", missing: r.missing }, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } });
    }
    const tab = (TABS.find((t) => t === u.searchParams.get("tab")) ?? "new") as LaunchTab;
    const q = (u.searchParams.get("q") ?? "").trim().slice(0, 64);
    const cursor = u.searchParams.get("cursor");
    const page = await launchPage(tab, q, cursor && cursor.length < 4000 ? cursor : null);
    warmImages(page.items);
    // the door list costs vibe 6-9 s and its % moves slowly: keep it longer at the edge so viewers rarely wait on it
    const cc = tab === "door" && !q ? "public, s-maxage=60, stale-while-revalidate=300" : "public, s-maxage=30, stale-while-revalidate=120";
    return Response.json(page, { headers: { "cache-control": cc } });
  } catch {
    // the directory is down right now: unknown, not "no launches"
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
