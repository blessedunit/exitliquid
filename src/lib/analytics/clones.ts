// Same ticker / same name on vibe/vibe: the vibe search is fuzzy (q=TREE also finds "Wall Street"),
// so every hit is filtered to an exact ticker or exact name match. The earliest createdAt is the first
// launch with that ticker, which is not proof of anything: it only says who used the name first.
import "server-only";
import { CHAIN_ID } from "@/lib/config";
import { cleanText } from "@/lib/chain";
import { BoundedTtlMap } from "@/lib/bounded";
import { noteVibeStatus, vibeCoolingDown } from "@/lib/vibeCooldown";
import type { CloneItem, Clones } from "./types";

const API = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
const HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "Mozilla/5.0" };
const PAGES = 4; // 4 x 50 = the 200 newest fuzzy hits
const TTL = 30 * 60_000;
const FAIL_TTL = 90_000; // vibe didn't answer this search: unknown for 90 s, no repeat call on every rebuild

type Item = { tokenAddress?: string; name?: string; symbol?: string; createdAt?: string; holderCount?: number; lifecycle?: string; graduated?: boolean; moderation?: { visibility?: string } };
type Page = { data?: { items?: Item[]; page?: { nextCursor?: string; hasMore?: boolean } } };

// keyed by the search (ticker + name), not the token: a ticker family (CAT###, OISHI x2) shares one search
type Found = { items: CloneItem[]; partial: boolean };
const memo = new BoundedTtlMap<Found>(2_000);
const failed = new BoundedTtlMap<string>(2_000);
const inflight = new Map<string, Promise<Found>>();
const norm = (s: string) => s.replace(/^\$/, "").trim().toLowerCase();

async function page(q: string, cursor: string | null): Promise<Page> {
  const qs = [`sort=CREATED_DESC`, `limit=50`, `q=${encodeURIComponent(q)}`];
  if (cursor) qs.push(`cursor=${encodeURIComponent(cursor)}`);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API}/launches?${qs.join("&")}`, { headers: HEADERS, next: { revalidate: 1800 }, signal: AbortSignal.timeout(8_000) });
    if (r.ok) return (await r.json()) as Page;
    noteVibeStatus(r.status);
    // 429: one polite retry, then unknown
    if (r.status === 429 && attempt < 1) {
      await new Promise((res) => setTimeout(res, 1_500));
      continue;
    }
    throw new Error(`vibe api ${r.status}`);
  }
}

/** Launches with the same ticker or name as this token. Throws when vibe doesn't answer (unknown, never "no clones"). */
export async function clonesOf(token: string, symbol: string, name: string): Promise<Clones> {
  const t = token.toLowerCase();
  const key = `${norm(symbol)}|${norm(name)}`;
  let found = memo.get(key);
  if (!found) {
    const why = failed.get(key);
    if (why) throw new Error(why);
    if (vibeCoolingDown()) throw new Error("vibe api cooling down");
    let job = inflight.get(key);
    if (!job) {
      job = search(symbol, name)
        .then((v) => {
          memo.set(key, v, TTL);
          return v;
        })
        .catch((e) => {
          failed.set(key, String((e as Error)?.message ?? e).slice(0, 80), FAIL_TTL);
          throw e;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    found = await job;
  }
  return shape(t, symbol, found);
}

/** this token's view of a shared search: `self` and "earliest" are per token */
function shape(token: string, symbol: string, f: Found): Clones {
  const items = f.items.map((x) => ({ ...x, self: x.token === token }));
  const earliest = items[0] ?? null;
  return {
    symbol,
    matches: items.filter((x) => !x.self).length,
    isEarliest: !!earliest && earliest.self,
    earliest,
    // the list a viewer needs: the earliest few and the biggest ones, this token included
    items: [...new Map([...items.slice(0, 5), ...[...items].sort((a, b) => (b.holders ?? -1) - (a.holders ?? -1)).slice(0, 5), ...items.filter((x) => x.self)].map((x) => [x.token, x])).values()]
      .sort((a, b) => a.createdAt - b.createdAt),
    partial: f.partial,
  };
}

async function search(symbol: string, name: string): Promise<Found> {
  const sym = norm(symbol);
  const nm = norm(name);
  const seen = new Map<string, CloneItem>();
  let cursor: string | null = null;
  let more = false;
  for (let i = 0; i < PAGES; i++) {
    const j = await page(sym || nm, cursor);
    for (const x of j.data?.items ?? []) {
      const a = String(x.tokenAddress ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a) || x.moderation?.visibility === "HIDDEN") continue;
      const s = cleanText(x.symbol, 16);
      const n = cleanText(x.name, 40);
      if (norm(s) !== sym && !(nm && norm(n) === nm)) continue;
      seen.set(a, {
        token: a,
        symbol: s,
        name: n,
        createdAt: Math.floor(Date.parse(x.createdAt ?? "") / 1000) || 0,
        holders: typeof x.holderCount === "number" ? x.holderCount : null,
        graduated: x.graduated === true || x.lifecycle === "GRADUATED",
        self: false,
      });
    }
    const p = j.data?.page;
    more = !!(p?.hasMore && p.nextCursor);
    if (!more) break;
    cursor = p!.nextCursor!;
  }
  const items = [...seen.values()].filter((x) => x.createdAt > 0).sort((a, b) => a.createdAt - b.createdAt);
  return { items, partial: more };
}
