import { searchSuggest } from "@/lib/launches";
import { client } from "@/lib/chain";
import { clientIp, LIMITS, rateLimit, tooMany } from "@/lib/limits";

export const dynamic = "force-dynamic";

// /api/search?q=<ticker|name|0x…|0x-prefix>: up to 6 slim suggestions for the header search box.
// No ETA, no pictures warmed: 1-2 cached upstream calls per distinct query.
export async function GET(req: Request) {
  if (!(await rateLimit(LIMITS.queue, clientIp(req), { localOnly: true }))) return tooMany();
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 64);
  if (q.replace(/^\$/, "").length < 2) return Response.json({ items: [], more: false, kind: "text" }, { headers: { "cache-control": "public, s-maxage=60" } });
  try {
    const r = await searchSuggest(q);
    // a full address that is no listed token: is it a wallet (no code) or a contract (maybe an unlisted line)?
    // wallet: true -> the box offers the wallet profile; null = the chain didn't answer (offer both)
    if (r.kind === "address" && !r.items.length && /^0x[0-9a-fA-F]{40}$/.test(q)) {
      const wallet = await isWallet(q.toLowerCase());
      return Response.json({ ...r, wallet }, { headers: { "cache-control": wallet === null ? "no-store" : "public, s-maxage=30, stale-while-revalidate=60" } });
    }
    return Response.json(r, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch {
    // unknown right now, never "no match"
    return Response.json({ error: "unknown" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

const codeMemo = new Map<string, boolean>();
async function isWallet(a: `0x${string}` | string): Promise<boolean | null> {
  const hit = codeMemo.get(a);
  if (hit !== undefined) return hit;
  try {
    const code = await Promise.race([
      client.getCode({ address: a as `0x${string}` }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    const w = !code || code === "0x" || code.toLowerCase().startsWith("0xef0100"); // EIP-7702 delegated EOA = a wallet
    if (codeMemo.size > 2000) codeMemo.delete(codeMemo.keys().next().value!);
    codeMemo.set(a, w);
    return w;
  } catch {
    return null;
  }
}
