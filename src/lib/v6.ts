// v6 (taxed) launches: our own "line lite" for them. Our chain engine only understands v1 curves, so
// everything on a v6 line is read from vibe/vibe's own indexer, in two cached calls per refresh:
//   GET /v6/launches/<token>?limit=1        the launch: name, pair, tax, target, pair reserve, lifecycle
//   GET /v6/launches/<token>/market?limit=N holders (by balance), traders, last N trades, 1h/24h stats
// plus one multicall on the chain for the token's totalSupply (and the pair's decimals), cached for 10 min.
// Endpoints found in vibe/vibe's own client (static-v2 bundle, checked 30.09.2026).
import "server-only";
import { parseAbi, type Address } from "viem";
import { CHAIN_ID } from "./config";
import { client } from "./chain";
import type { LaunchSocials } from "./launches";

const API = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
const HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "exitliquid.fun (read-only directory)" };
const ADDR = /^0x[0-9a-f]{40}$/;
const isInt = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const big = (v: unknown) => (isInt(v) ? BigInt(v) : null);

export type V6Holder = { address: string; balance: string; /** share of total supply in bps; null = supply unknown */ shareBps: number | null; isCreator: boolean };
export type V6Trade = { id: string; side: "BUY" | "SELL"; actor: string; tokens: string; pair: string; at: number; tx: string };
export type V6Line = {
  token: string;
  curve: string;
  creator: string;
  name: string;
  symbol: string;
  image: string | null;
  description: string | null;
  socials: LaunchSocials | null;
  createdAt: number;
  taxBps: number;
  /** where the tax goes, bps of the tax: cash (project), holders, burn */
  taxSplit: { cashBps: number; holdersBps: number; burnBps: number } | null;
  pair: { symbol: string; native: boolean; decimals: number | null };
  /** pair units (as strings, pair decimals) */
  reserve: string | null;
  target: string | null;
  doorBps: number | null;
  graduated: boolean;
  lifecycle: string;
  holderCount: number | null;
  /** biggest bag first (vibe's order), at most 100 */
  holders: V6Holder[];
  holdersComplete: boolean;
  /** newest first */
  trades: V6Trade[];
  stats: {
    volume1h: string | null; volume24h: string | null;
    buys1h: number | null; sells1h: number | null; buys24h: number | null; sells24h: number | null;
    buyers24h: number | null; change1hBps: number | null; change24hBps: number | null;
  };
  /** last trade's price, pair units (pair decimals) per whole token */
  lastPrice: string | null;
  coverageComplete: boolean;
  updatedAt: number;
};

async function api<T>(path: string, revalidate: number, timeout = 6_000): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: HEADERS, next: { revalidate }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`vibe api ${r.status}`);
  return (await r.json()) as T;
}

// short memo shared by everyone looking at the same line (the data cache covers other instances)
const memo = new Map<string, { at: number; v: unknown }>();
const running = new Map<string, Promise<unknown>>();
async function memoized<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const busy = running.get(key);
  if (busy) return busy as Promise<T>;
  const p = run()
    .then((v) => {
      if (memo.size > 300) memo.clear();
      memo.set(key, { at: Date.now(), v });
      return v;
    })
    .finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(CTRL, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : t;
}
function safeUrl(raw: unknown, hosts?: string[]): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const t = raw.replace(CTRL, "").trim();
  const withBase = hosts && /^@?[A-Za-z0-9_]{1,32}$/.test(t) ? `https://${hosts[0]}/${t.replace(/^@/, "")}` : t;
  try {
    const u = new URL(withBase);
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    const host = u.hostname.toLowerCase();
    if (hosts && !hosts.some((h) => host === h || host === `www.${h}`)) return undefined;
    return u.toString().slice(0, 200);
  } catch {
    return undefined;
  }
}
function socialsOf(v: unknown): LaunchSocials | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: LaunchSocials = {};
  const x = safeUrl(o.x ?? o.twitter, ["x.com", "twitter.com"]);
  if (x) out.x = x;
  const tg = safeUrl(o.telegram, ["t.me", "telegram.me"]);
  if (tg) out.telegram = tg;
  const web = safeUrl(o.website);
  if (web) out.website = web;
  return Object.keys(out).length ? out : null;
}
function gateway(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice(7).split("/")[0];
    return /^[a-zA-Z0-9]{46,100}$/.test(cid) ? `/api/img/${cid}?w=96` : null;
  }
  return uri.startsWith("https://") ? uri : null;
}

type ApiLaunch = {
  tokenAddress?: string; curveAddress?: string; launcherAddress?: string; name?: string; symbol?: string; createdAt?: string;
  content?: { image?: { uri?: string }; description?: unknown; socials?: unknown }; moderation?: { visibility?: string };
  pairCurrencyAddress?: string; pairIsNative?: boolean; pairSymbol?: string | null; targetPairUnits?: string; taxBps?: number;
  weights?: { cashBps?: number; holdersBps?: number; burnBps?: number };
  lifecycle?: string; graduated?: boolean; curve?: { pairReserveUnits?: string };
};
type ApiMarket = {
  coverage?: { complete?: boolean };
  trades?: { id?: string; side?: string; actorAddress?: string; recipientAddress?: string; tokenAmountUnits?: string; pairAmountUnits?: string; occurredAt?: string; transactionHash?: string; executionPricePairUnitsPerToken?: string }[];
  holders?: { address?: string; balanceUnits?: string }[];
  page?: { hasMore?: boolean };
  stats?: {
    volume1hPairUnits?: string; volume24hPairUnits?: string; buyCount1h?: number; sellCount1h?: number; buyCount24h?: number; sellCount24h?: number;
    uniqueBuyers24h?: number; holderCount?: number; priceChange1hBps?: number | string | null; priceChange24hBps?: number | string | null;
  };
};

const erc20 = parseAbi(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"]);

/** totalSupply of the token and the pair's decimals (18 for native ETH). Unknown pieces are null. */
async function chainFacts(token: string, pair: string | null, native: boolean): Promise<{ supply: bigint | null; decimals: number | null }> {
  return memoized(`v6chain:${token}`, 10 * 60_000, async () => {
    const calls = [{ address: token as Address, abi: erc20, functionName: "totalSupply" as const }];
    const pairCall = !native && pair && ADDR.test(pair) ? [{ address: pair as Address, abi: erc20, functionName: "decimals" as const }] : [];
    try {
      const r = await client.multicall({ contracts: [...calls, ...pairCall], allowFailure: true });
      const supply = r[0]?.status === "success" ? (r[0].result as bigint) : null;
      const decimals = native ? 18 : r[1]?.status === "success" ? Number(r[1].result) : null;
      return { supply: supply && supply > 0n ? supply : null, decimals };
    } catch {
      return { supply: null, decimals: native ? 18 : null };
    }
  });
}

/** The launch record alone (1 call, cached 15 s). null = vibe does not know it as a v6 launch; throws when vibe is down. */
export async function v6Launch(token: string): Promise<ApiLaunch | null> {
  const t = token.toLowerCase();
  if (!ADDR.test(t)) return null;
  return memoized(`v6launch:${t}`, 15_000, async () => {
    const r = await fetch(`${API}/v6/launches/${t}?limit=1`, { headers: HEADERS, next: { revalidate: 15 }, signal: AbortSignal.timeout(4_000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`vibe api ${r.status}`);
    const j = (await r.json()) as { data?: { launch?: ApiLaunch } };
    const l = j.data?.launch;
    return l && l.tokenAddress && l.moderation?.visibility !== "HIDDEN" ? l : null;
  });
}

const TRADES = 60;

/** Everything a v6 line shows. null = not a v6 launch; throws when vibe does not answer (the page says unknown). */
export async function v6Line(token: string): Promise<V6Line | null> {
  const t = token.toLowerCase();
  if (!ADDR.test(t)) return null;
  const [l, m] = await Promise.all([
    v6Launch(t),
    memoized(`v6market:${t}`, 12_000, () => api<{ data?: ApiMarket }>(`/v6/launches/${t}/market?limit=${TRADES}`, 15)).catch(() => null),
  ]);
  if (!l) return null;
  const native = l.pairIsNative === true;
  const facts = await chainFacts(t, (l.pairCurrencyAddress || "").toLowerCase(), native);
  const creator = (l.launcherAddress || "").toLowerCase();
  const target = big(l.targetPairUnits);
  const reserve = big(l.curve?.pairReserveUnits);
  const graduated = l.graduated === true || l.lifecycle === "GRADUATED";
  const doorBps = graduated ? 10_000 : target && target > 0n && reserve !== null ? Math.min(10_000, Number((reserve * 10_000n) / target)) : null;
  const d = m?.data;
  const s = d?.stats;
  const holders: V6Holder[] = (d?.holders ?? [])
    .filter((h) => typeof h.address === "string" && ADDR.test(h.address.toLowerCase()) && isInt(h.balanceUnits) && BigInt(h.balanceUnits) > 0n)
    .slice(0, 100)
    .map((h) => {
      const bal = BigInt(h.balanceUnits as string);
      const a = (h.address as string).toLowerCase();
      return { address: a, balance: bal.toString(), shareBps: facts.supply ? Number((bal * 10_000n) / facts.supply) : null, isCreator: a === creator };
    });
  const trades: V6Trade[] = (d?.trades ?? [])
    .filter((x) => (x.side === "BUY" || x.side === "SELL") && typeof x.actorAddress === "string" && isInt(x.tokenAmountUnits) && isInt(x.pairAmountUnits))
    .map((x) => ({
      id: String(x.id ?? `${x.transactionHash}`),
      side: x.side as "BUY" | "SELL",
      actor: (x.recipientAddress && x.side === "BUY" ? x.recipientAddress : x.actorAddress as string).toLowerCase(),
      tokens: x.tokenAmountUnits as string,
      pair: x.pairAmountUnits as string,
      at: Math.floor(Date.parse(x.occurredAt ?? "") / 1000) || 0,
      tx: typeof x.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(x.transactionHash) ? x.transactionHash : "",
    }))
    .sort((a, b) => b.at - a.at);
  const lastPrice = d?.trades?.find((x) => isInt(x.executionPricePairUnitsPerToken))?.executionPricePairUnitsPerToken ?? null;
  const holderCount = num(s?.holderCount);
  const w = l.weights;
  return {
    token: t,
    curve: (l.curveAddress || "").toLowerCase(),
    creator,
    name: String(l.name ?? "").slice(0, 40),
    symbol: String(l.symbol ?? "").slice(0, 16),
    image: gateway(l.content?.image?.uri),
    description: cleanText(l.content?.description, 280),
    socials: socialsOf(l.content?.socials),
    createdAt: Math.floor(Date.parse(l.createdAt ?? "") / 1000) || 0,
    taxBps: Math.max(0, Number(l.taxBps ?? 0)),
    taxSplit: w ? { cashBps: Number(w.cashBps ?? 0), holdersBps: Number(w.holdersBps ?? 0), burnBps: Number(w.burnBps ?? 0) } : null,
    pair: { symbol: native ? "ETH" : String(l.pairSymbol || "token").slice(0, 12), native, decimals: facts.decimals },
    reserve: reserve === null ? null : reserve.toString(),
    target: target === null ? null : target.toString(),
    doorBps,
    graduated,
    lifecycle: String(l.lifecycle ?? ""),
    holderCount,
    holders,
    // vibe's holder list is complete when it holds as many rows as the count (or no market came back: unknown)
    holdersComplete: !!d && holderCount !== null && holders.length >= holderCount,
    trades,
    stats: {
      volume1h: isInt(s?.volume1hPairUnits) ? s.volume1hPairUnits : null,
      volume24h: isInt(s?.volume24hPairUnits) ? s.volume24hPairUnits : null,
      buys1h: num(s?.buyCount1h), sells1h: num(s?.sellCount1h),
      buys24h: num(s?.buyCount24h), sells24h: num(s?.sellCount24h),
      buyers24h: num(s?.uniqueBuyers24h),
      change1hBps: num(s?.priceChange1hBps), change24hBps: num(s?.priceChange24hBps),
    },
    lastPrice: isInt(lastPrice) ? lastPrice : null,
    coverageComplete: d?.coverage?.complete === true,
    updatedAt: d ? Date.now() : 0, // 0 = the market part did not come back (unknown, not empty)
  };
}
