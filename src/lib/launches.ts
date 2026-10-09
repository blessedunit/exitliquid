// All vibe/vibe launches, from the vibe/vibe public API (list, sort, search).
// The list is a directory only: every number on a /line/<token> page is read from the chain.
import "server-only";
import { CHAIN_ID } from "./config";

export type LaunchTab = "new" | "hot" | "door" | "grad";

export type LaunchCard = {
  token: string;
  curve: string;
  creator: string;
  name: string;
  symbol: string;
  image: string | null; // https gateway url
  createdAt: number; // unix seconds
  progressBps: number;
  graduated: boolean;
  holders: number | null;
  volume24hEth: number | null;
  volume1hEth: number | null;
  buyers1h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  /** buys / sells in the last 24 h (v6 list only; v1 has 1h counts only); null = unknown */
  buys24h: number | null;
  sells24h: number | null;
  change1hBps: number | null;
  priceEth: number | null;
  /** ETH still missing before the door opens (curve.ethRemainingWei); null = unknown / not an ETH pair */
  ethRemainingEth: number | null;
  /** ETH raised net of sells so far (curve.netRaisedWei); null = unknown */
  netRaisedEth: number | null;
  /** hours to graduation at the slower of two paces (24 h net inflow, last hour's volume); null = no honest estimate */
  etaHours: number | null;
  /** walking to the door but stalled: no buys in the last hour, draining, or the last hour far slower than the day */
  etaStalled: boolean;
  /** v6 factory launch (taxed token, not in /launches): its line lite is /line/<token> (read from vibe/vibe) */
  v6: { taxBps: number; pair: string } | null;
  /** creator's description (trimmed, control chars removed, <=280 chars); null = none given */
  description: string | null;
  /** creator's links, validated (https only / x.com / t.me); null = none given */
  socials: LaunchSocials | null;
};

export type LaunchSocials = { x?: string; telegram?: string; website?: string };

export type LaunchPage = {
  items: LaunchCard[];
  next: string | null;
  asOfBlock: number | null;
  /** v6 launches in this page: "ok", "error" (unknown right now, not "none"), "off" (not part of this list) */
  v6: "ok" | "error" | "off";
};

const API = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
const HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "exitliquid.fun (read-only directory)" };

const TAB_QUERY: Record<LaunchTab, string> = {
  new: "sort=CREATED_DESC",
  hot: "sort=TRENDING",
  door: "sort=PROGRESS_DESC&lifecycle=CURVE_TRADING",
  grad: "lifecycle=GRADUATED",
};

const isInt = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const wei = (v: unknown) => (isInt(v) ? Number(BigInt(v) / 10n ** 9n) / 1e9 : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function gateway(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  // our own cached proxy (/api/img): public IPFS gateways are slow or blocked in some regions
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice(7).split("/")[0];
    return /^[a-zA-Z0-9]{46,100}$/.test(cid) ? `/api/img/${cid}?w=96` : null;
  }
  return uri.startsWith("https://") ? uri : null;
}

async function api<T>(path: string, revalidate: number, timeout = 8_000): Promise<T> {
  // Vercel data cache: shared by every server instance, so a cold function answers from cache too
  const r = await fetch(`${API}${path}`, { headers: HEADERS, next: { revalidate }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`vibe api ${r.status}`);
  return (await r.json()) as T;
}

// short memo: the directory is shared by everyone browsing it; callers asking at the same time share one call
const memo = new Map<string, { at: number; v: unknown }>();
const running = new Map<string, Promise<unknown>>();
async function memoized<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const busy = running.get(key);
  if (busy) return busy as Promise<T>;
  const p = run()
    .then((v) => {
      if (memo.size > 400) memo.clear();
      memo.set(key, { at: Date.now(), v });
      return v;
    })
    .finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

/** resolves with the promise, or with `fallback` after `ms` (the promise keeps running and fills the memo) */
function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}

/* ---------------- creator content (description, socials) ---------------- */

type ApiContent = { image?: { uri?: string }; description?: unknown; socials?: unknown };

// C0/C1 controls, bidi overrides and zero-width chars: never let them into the page
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function cleanDescription(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(CTRL, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const chars = Array.from(t); // do not cut an emoji in half
  return chars.length > 280 ? chars.slice(0, 279).join("").trimEnd() + "\u2026" : t;
}

function safeUrl(raw: string, hosts?: string[]): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (hosts && !hosts.some((h) => host === h || host === `www.${h}`)) return null;
    if (!hosts && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    return u.toString().slice(0, 200);
  } catch {
    return null;
  }
}

function handleUrl(v: unknown, base: string, hosts: string[]): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(CTRL, "").trim();
  if (!t) return undefined;
  if (/^@?[A-Za-z0-9_]{1,32}$/.test(t)) return `${base}/${t.replace(/^@/, "")}`;
  const bare = /^(www\.)?[a-z.]+\//i.test(t) ? `https://${t}` : t;
  return safeUrl(bare, hosts) ?? undefined;
}

function cleanSocials(v: unknown): LaunchSocials | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const out: LaunchSocials = {};
  const x = handleUrl(o.x ?? o.twitter, "https://x.com", ["x.com", "twitter.com"]);
  if (x) out.x = x;
  const tg = handleUrl(o.telegram, "https://t.me", ["t.me", "telegram.me"]);
  if (tg) out.telegram = tg;
  const web = typeof o.website === "string" ? safeUrl(o.website.replace(CTRL, "").trim()) : null;
  if (web) out.website = web;
  return Object.keys(out).length ? out : null;
}

/* ---------------- v1 launches (/launches) ---------------- */

type ApiItem = {
  tokenAddress: string; curveAddress: string; creatorAddress: string; name: string; symbol: string; createdAt: string;
  content?: ApiContent; moderation?: { visibility?: string };
  curve?: { lifecycle?: string; progressBps?: number; ethRemainingWei?: string; netRaisedWei?: string };
  analytics?: { volume24hWei?: string; volume1hWei?: string; uniqueBuyers1h?: number; buyCount1h?: number; sellCount1h?: number; priceChange1hBps?: string; lastPriceWeiPerToken?: string };
  holderCount?: number; asOfBlock?: string;
};
type ApiPage<I> = { data?: { items?: I[]; page?: { nextCursor?: string; hasMore?: boolean; snapshotBlock?: string } } };

function toCard(x: ApiItem): LaunchCard {
  const a = x.analytics ?? {};
  const price = isInt(a.lastPriceWeiPerToken) ? Number(a.lastPriceWeiPerToken) / 1e18 : null;
  const graduated = x.curve?.lifecycle === "GRADUATED";
  return {
    token: x.tokenAddress.toLowerCase(),
    curve: (x.curveAddress || "").toLowerCase(),
    creator: (x.creatorAddress || "").toLowerCase(),
    name: String(x.name ?? "").slice(0, 40),
    symbol: String(x.symbol ?? "").slice(0, 16),
    image: gateway(x.content?.image?.uri),
    createdAt: Math.floor(Date.parse(x.createdAt) / 1000) || 0,
    progressBps: Math.max(0, Math.min(10_000, Number(x.curve?.progressBps ?? 0))),
    graduated,
    holders: num(x.holderCount),
    volume24hEth: wei(a.volume24hWei),
    volume1hEth: wei(a.volume1hWei),
    buyers1h: num(a.uniqueBuyers1h),
    buys1h: num(a.buyCount1h),
    sells1h: num(a.sellCount1h),
    buys24h: null,
    sells24h: null,
    change1hBps: num(a.priceChange1hBps),
    priceEth: price,
    ethRemainingEth: graduated ? 0 : wei(x.curve?.ethRemainingWei),
    netRaisedEth: wei(x.curve?.netRaisedWei),
    etaHours: null,
    etaStalled: false,
    v6: null,
    description: cleanDescription(x.content?.description),
    socials: cleanSocials(x.content?.socials),
  };
}

const visible = (x: { tokenAddress?: string; moderation?: { visibility?: string } }) => !!x?.tokenAddress && x.moderation?.visibility !== "HIDDEN";

async function v1Page(tab: LaunchTab, q: string, cursor: string | null, limit: number, revalidate: number) {
  // vibe answers 400 to sort=TRENDING together with q=: a search on Hot is sorted by newest instead
  const qs = [q && tab === "hot" ? TAB_QUERY.new : TAB_QUERY[tab], `limit=${limit}`];
  if (q) qs.push(`q=${encodeURIComponent(q)}`);
  if (cursor) qs.push(`cursor=${encodeURIComponent(cursor)}`);
  const key = qs.join("&");
  // sort=PROGRESS_DESC takes vibe 6-9 s (measured 29.09, sometimes a 502): a longer wait, a longer shared
  // cache (door % moves slowly), and the last good page when vibe fails (the poll corrects it later)
  const slow = tab === "door" && !q;
  try {
    return await memoized(`v1:${key}`, slow ? 30_000 : 15_000, async () => {
      const j = await api<ApiPage<ApiItem>>(`/launches?${key}`, slow ? Math.max(revalidate, 60) : revalidate, slow ? 15_000 : 8_000);
      const page = j.data?.page;
      const v = {
        items: (j.data?.items ?? []).filter(visible).map(toCard),
        next: page?.hasMore && page.nextCursor ? page.nextCursor : null,
        asOfBlock: num(page?.snapshotBlock),
      };
      if (slow) lastGood.set(key, { at: Date.now(), v });
      return v;
    });
  } catch (e) {
    const old = slow ? lastGood.get(key) : undefined;
    if (old && Date.now() - old.at < 15 * 60_000) return old.v;
    throw e;
  }
}
const lastGood = new Map<string, { at: number; v: { items: LaunchCard[]; next: string | null; asOfBlock: number | null } }>();

/* ---------------- v6 launches (/v6/launches: taxed tokens, missing from /launches) ---------------- */

type V6Item = {
  tokenAddress: string; curveAddress?: string; launcherAddress?: string; name?: string; symbol?: string; createdAt?: string;
  content?: ApiContent; moderation?: { visibility?: string };
  pairIsNative?: boolean; pairSymbol?: string | null; targetPairUnits?: string; taxBps?: number;
  lifecycle?: string; graduated?: boolean;
  curve?: { pairReserveUnits?: string };
  market?: { holderCount?: number; volume24hPairUnits?: string; buyCount24h?: number; sellCount24h?: number; priceChange1hBps?: number | string | null };
};

function v6Card(x: V6Item): LaunchCard {
  const native = x.pairIsNative === true;
  const target = isInt(x.targetPairUnits) ? BigInt(x.targetPairUnits) : 0n;
  const reserveRaw = x.curve?.pairReserveUnits;
  const reserve = isInt(reserveRaw) ? BigInt(reserveRaw) : 0n;
  const graduated = x.graduated === true || x.lifecycle === "GRADUATED";
  // door % = pair reserve on the curve / pair target of the curve (both in pair units)
  const progressBps = graduated ? 10_000 : target > 0n ? Math.min(10_000, Number((reserve * 10_000n) / target)) : 0;
  const m = x.market ?? {};
  return {
    token: x.tokenAddress.toLowerCase(),
    curve: (x.curveAddress || "").toLowerCase(),
    creator: (x.launcherAddress || "").toLowerCase(),
    name: String(x.name ?? "").slice(0, 40),
    symbol: String(x.symbol ?? "").slice(0, 16),
    image: gateway(x.content?.image?.uri),
    createdAt: Math.floor(Date.parse(x.createdAt ?? "") / 1000) || 0,
    progressBps,
    graduated,
    holders: num(m.holderCount),
    // volumes are in the pair currency: only an ETH pair is comparable with the rest of the board
    volume24hEth: native ? wei(m.volume24hPairUnits) : null,
    volume1hEth: null, // the list has no 1h window for v6
    buyers1h: null,
    buys1h: null,
    sells1h: null,
    buys24h: num(m.buyCount24h),
    sells24h: num(m.sellCount24h),
    change1hBps: num(m.priceChange1hBps),
    priceEth: null,
    ethRemainingEth: native && target > 0n && !graduated ? wei(String(target > reserve ? target - reserve : 0n)) : null,
    netRaisedEth: native ? wei(String(reserve)) : null,
    etaHours: null,
    etaStalled: false,
    v6: { taxBps: Math.max(0, Number(x.taxBps ?? 0)), pair: native ? "ETH" : String(x.pairSymbol || "token").slice(0, 12) },
    description: cleanDescription(x.content?.description),
    socials: cleanSocials(x.content?.socials),
  };
}

async function v6Page(q: string, cursor: string | null, limit: number, revalidate: number) {
  const qs = [`limit=${Math.min(50, limit)}`];
  if (q) qs.push(`q=${encodeURIComponent(q)}`);
  if (cursor) qs.push(`cursor=${encodeURIComponent(cursor)}`);
  const key = qs.join("&");
  return memoized(`v6:${key}`, 15_000, async () => {
    const j = await api<ApiPage<V6Item>>(`/v6/launches?${key}`, revalidate);
    const page = j.data?.page;
    return {
      items: (j.data?.items ?? []).filter(visible).map(v6Card),
      next: page?.hasMore && page.nextCursor ? page.nextCursor : null,
    };
  });
}

/* ---------------- graduation ETA (flow24h: net inflow of the last 24 h) ---------------- */

type Flow = { data?: { buyVolumeWei?: string; sellVolumeWei?: string } };

type Eta = { hours: number | null; stalled: boolean };
const NO_ETA: Eta = { hours: null, stalled: false };
const ETA_BUDGET_MS = 2_000;

/**
 * Honest ETA. Two paces: the net ETH inflow of the last 24 h (or since launch when younger), and the
 * last hour's volume (buys + sells, so an upper bound of the last hour's net inflow). The slower one wins.
 * No buys in the last hour, a draining day, or a last hour under 10% of the day's pace = "stalled", no ETA.
 */
async function etaFor(c: LaunchCard): Promise<Eta> {
  if (c.graduated || c.v6 || c.ethRemainingEth === null || c.ethRemainingEth <= 0) return NO_ETA;
  if (c.buys1h === 0) return { hours: null, stalled: true }; // free: nobody bought this hour, no call needed
  if (c.buys1h === null) return NO_ETA; // unknown window: no badge either way
  const ageH = (Date.now() / 1000 - c.createdAt) / 3600;
  if (!(ageH >= 1)) return NO_ETA; // under an hour of history is noise, not a rate
  const f = await memoized(`flow:${c.token}`, 120_000, () => api<Flow>(`/launches/${c.token}/flow24h`, 300, 4_000));
  const buy = wei(f.data?.buyVolumeWei);
  const sell = wei(f.data?.sellVolumeWei);
  if (buy === null || sell === null) return NO_ETA;
  const day = (buy - sell) / Math.min(24, ageH);
  if (!(day > 0)) return { hours: null, stalled: true }; // flat or draining: the door is not getting closer
  const hour = c.volume1hEth;
  // only a near-dead hour counts as stalled (young tokens' daily pace includes the launch burst);
  // a slower-but-alive hour just makes the ETA longer through the min() below
  if (hour !== null && hour < day * 0.1) return { hours: null, stalled: true };
  const pace = hour === null ? day : Math.min(day, hour);
  return { hours: c.ethRemainingEth / pace, stalled: false };
}

/** door tab: every walking row (up to 30); elsewhere rows at 20 %+ (up to 24). Never more calls than that per page. */
async function withEta(items: LaunchCard[], all = false, budgetMs = ETA_BUDGET_MS): Promise<LaunchCard[]> {
  const pick = items
    .filter((c) => !c.v6 && !c.graduated && (all || c.progressBps >= 2_000))
    .sort((a, b) => b.progressBps - a.progressBps)
    .slice(0, all ? 30 : 24);
  if (!pick.length) return items;
  // the list never waits long for ETAs: a slow one is left out now (unknown, no badge) and lands in the
  // memo for the next poll
  const got = await Promise.all(pick.map((c) => within(etaFor(c), budgetMs, NO_ETA)));
  const eta = new Map<string, Eta>();
  pick.forEach((c, i) => eta.set(c.token, got[i]));
  return items.map((c) => {
    const e = eta.get(c.token);
    return e ? { ...c, etaHours: e.hours, etaStalled: e.stalled } : c;
  });
}

/* ---------------- search helpers ---------------- */

const FULL_ADDR = /^0x[0-9a-f]{40}$/;
const PART_ADDR = /^0x[0-9a-f]{4,39}$/;

/** exact ticker first, then tickers that start with the query; otherwise the list order stays */
function pinExact(items: LaunchCard[], q: string): LaunchCard[] {
  const t = q.replace(/^\$/, "").trim().toLowerCase();
  if (!t) return items;
  const rank = (c: LaunchCard) => (c.symbol.toLowerCase() === t ? 0 : c.symbol.toLowerCase().startsWith(t) ? 1 : 2);
  // several tokens with the exact ticker (or the same prefix): the one most people hold first (a fresh copycat of $TREE listed
  // above the real $TREE only because it is newer was the top suggestion, checked 29.09)
  const held = (x: { c: LaunchCard; r: number }) => (x.r <= 1 ? (x.c.holders ?? -1) : 0);
  return items.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || held(b) - held(a) || a.i - b.i).map((x) => x.c);
}

/**
 * The vibe API only finds a full address. A partial one (0x + 4..39 hex) is matched against the
 * first pages everyone is already browsing (the same cached calls as the board), so it costs nothing extra.
 */
async function prefixSearch(prefix: string, revalidate = 15): Promise<{ items: LaunchCard[]; v6: "ok" | "error" }> {
  // the door list can take vibe 6-9 s: a partial match never waits for it longer than 2.5 s
  const late = new Error("late");
  const got = await Promise.allSettled([
    v1Page("hot", "", null, 24, revalidate),
    v1Page("new", "", null, 24, revalidate),
    within(v1Page("door", "", null, 24, revalidate), 2_500, late).then((v) => {
      if (v === late) throw late;
      return v as Awaited<ReturnType<typeof v1Page>>;
    }),
    v1Page("grad", "", null, 24, revalidate),
    v6Page("", null, 24, revalidate),
  ]);
  if (got.every((r) => r.status === "rejected")) throw new Error("vibe api down");
  const seen = new Map<string, LaunchCard>();
  for (const r of got) if (r.status === "fulfilled") for (const c of r.value.items) if (c.token.startsWith(prefix) && !seen.has(c.token)) seen.set(c.token, c);
  return { items: [...seen.values()].sort((a, b) => b.createdAt - a.createdAt), v6: got[4].status === "fulfilled" ? "ok" : "error" };
}

/* ---------------- pages ---------------- */

// New tab (and a search on Hot): v1 and v6 in one list, each side with its own cursor
type Mixed = { a: string | null; b: string | null; da: boolean; db: boolean };
const packMixed = (m: Mixed) => "m." + Buffer.from(JSON.stringify(m)).toString("base64url");
function unpackMixed(c: string | null): Mixed | null {
  if (!c?.startsWith("m.")) return null;
  try {
    const m = JSON.parse(Buffer.from(c.slice(2), "base64url").toString("utf8")) as Mixed;
    return { a: typeof m.a === "string" ? m.a : null, b: typeof m.b === "string" ? m.b : null, da: !!m.da, db: !!m.db };
  } catch {
    return null;
  }
}

/** One page of launches. Throws when the vibe API does not answer (the caller says "unknown", never "none"). */
export async function launchPage(tab: LaunchTab, q: string, cursor: string | null, limit = 24, revalidate = 15): Promise<LaunchPage> {
  const lq = q.trim().toLowerCase();
  if (PART_ADDR.test(lq)) {
    // a partial contract: the loaded first pages, filtered (tab-independent, one page, no cursor)
    const p = await prefixSearch(lq, revalidate);
    return { items: await withEta(p.items), next: null, asOfBlock: null, v6: p.v6 };
  }
  const mixed = tab === "new" || (tab === "hot" && !!q);
  if (!mixed) {
    const p = await v1Page(tab, q, cursor, limit, revalidate);
    const items = q && !cursor ? pinExact(p.items, q) : p.items;
    return { items: await withEta(items, tab === "door"), next: p.next, asOfBlock: p.asOfBlock, v6: "off" };
  }
  const m = unpackMixed(cursor) ?? { a: null, b: null, da: false, db: false };
  const [ra, rb] = await Promise.allSettled([
    m.da ? Promise.resolve(null) : v1Page(tab, q, m.a, limit, revalidate),
    m.db ? Promise.resolve(null) : v6Page(q, m.b, limit, revalidate),
  ]);
  if (ra.status === "rejected" && rb.status === "rejected") throw ra.reason;
  const a = ra.status === "fulfilled" ? ra.value : null;
  const b = rb.status === "fulfilled" ? rb.value : null;
  let items = [...(a?.items ?? []), ...(b?.items ?? [])];
  if (tab === "new" || q) items.sort((x, y) => y.createdAt - x.createdAt);
  if (q && !cursor) items = pinExact(items, q);
  // New: young lines rarely have an ETA, and two vibe calls already took ~1.3 s; a short ETA wait keeps the
  // server render under its 3 s cap (the rest land in the memo for the next poll)
  items = await withEta(items, false, tab === "new" ? 700 : ETA_BUDGET_MS);
  // a side that failed keeps its cursor (retried on "More"); a side that ran out is marked done
  const next: Mixed = {
    a: a ? a.next : m.a,
    b: b ? b.next : m.b,
    da: m.da || (!!a && !a.next),
    db: m.db || (!!b && !b.next),
  };
  return {
    items,
    next: next.da && next.db ? null : packMixed(next),
    asOfBlock: a?.asOfBlock ?? null,
    v6: rb.status === "fulfilled" ? "ok" : "error",
  };
}

/** Cards for a list of token addresses (the watchlist), in the order given. Missing = not found right now. */
export async function launchCards(tokens: string[], opts: { v6Lookup?: boolean } = {}): Promise<{ items: LaunchCard[]; missing: string[] }> {
  const list = [...new Set(tokens.map((t) => t.toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)))].slice(0, 20);
  if (!list.length) return { items: [], missing: [] };
  const key = [...list].sort().join(",");
  // one batched call for the whole list (throws when vibe is down: unknown, not "empty")
  const j = await memoized(`cards:${key}`, 15_000, () => api<ApiPage<ApiItem>>(`/launches/cards?tokens=${key}`, 15));
  const found = new Map<string, LaunchCard>();
  for (const x of (j.data?.items ?? []).filter(visible)) found.set(x.tokenAddress.toLowerCase(), toCard(x));
  // anything the v1 directory does not know may be a v6 launch: look those up by address
  // (skipped for a refresh of rows already known to be v1: one upstream call, nothing more)
  const rest = opts.v6Lookup === false ? [] : list.filter((t) => !found.has(t));
  const v6 = await Promise.allSettled(rest.map((t) => v6Page(t, null, 1, 15)));
  v6.forEach((r) => {
    if (r.status === "fulfilled") for (const c of r.value.items) if (rest.includes(c.token)) found.set(c.token, c);
  });
  const items = await withEta(list.map((t) => found.get(t)).filter((c): c is LaunchCard => !!c));
  return { items, missing: list.filter((t) => !found.has(t)) };
}

/**
 * Holders and 24 h volume as vibe/vibe's list reports them. The single-token endpoint has no market block
 * for a graduated token (checked 29.09 on $VDA: market = null), the batched cards endpoint does.
 * Null when vibe is slow or does not know the token (the line shows its own numbers or a dash).
 */
export type LaunchMarket = {
  holders: number | null;
  volume24hEth: number | null;
  /** price change over the last hour (bps), as the board shows it; null = unknown */
  change1hBps: number | null;
  /** door ETA (the board's honest ETA, 1 s budget on the token page); null = none / unknown */
  etaHours: number | null;
  etaStalled: boolean;
};

export async function launchMarket(token: string): Promise<LaunchMarket | null> {
  const t = token.toLowerCase();
  if (!FULL_ADDR.test(t)) return null;
  try {
    const j = await memoized(`cards:${t}`, 15_000, () => api<ApiPage<ApiItem>>(`/launches/cards?tokens=${t}`, 15, 1_500));
    const x = (j.data?.items ?? []).find((i) => i.tokenAddress?.toLowerCase() === t);
    if (!x || !visible(x)) return null;
    const c = toCard(x);
    // the same ETA as the board row, so the click from the board keeps it (a slow flow call = no ETA, never a guess)
    const e = await within(etaFor(c), 1_000, NO_ETA);
    return { holders: c.holders, volume24hEth: c.volume24hEth, change1hBps: c.change1hBps, etaHours: e.hours, etaStalled: e.stalled };
  } catch {
    return null;
  }
}

/** Header info for one token page (name, ticker, picture); null when the API does not know it. */
export async function launchInfo(token: string): Promise<LaunchCard | null> {
  const t = token.toLowerCase();
  try {
    // the single-token endpoint answers in 0.2-1.3 s (the search took up to 8 s); name and picture never change
    const j = await api<{ data?: ApiItem }>(`/launches/${t}`, 600, 1_800);
    return j.data && visible(j.data) ? toCard(j.data) : null;
  } catch {
    return null; // LiveHero falls back to the queue's own name/symbol
  }
}

/**
 * true only when vibe/vibe answers 404 for this address in the v1 directory (a final "not a v1 launch");
 * false when it is a launch or when vibe did not answer (unknown is never "missing").
 */
export async function launchMissing(token: string): Promise<boolean> {
  try {
    await api<unknown>(`/launches/${token.toLowerCase()}`, 600, 1_800);
    return false;
  } catch (e) {
    return (e as Error).message === "vibe api 404";
  }
}

/* ---------------- header search suggestions ---------------- */

export type Suggestion = {
  token: string; symbol: string; name: string; image: string | null;
  progressBps: number; graduated: boolean; v6: boolean;
};
export type SuggestResult = { items: Suggestion[]; more: boolean; kind: "text" | "prefix" | "address" };

const slim = (c: LaunchCard): Suggestion => ({
  token: c.token, symbol: c.symbol, name: c.name, image: c.image, progressBps: c.progressBps, graduated: c.graduated, v6: !!c.v6,
});

/**
 * Up to 6 suggestions for the header search. No ETA calls: 1-2 upstream calls per query, and the
 * text search shares its cache entries with the board's own search (same query strings).
 * Throws when vibe does not answer at all (the caller shows "unknown", never "no match").
 */
export async function searchSuggest(raw: string): Promise<SuggestResult> {
  const q = raw.replace(/^\$/, "").trim().slice(0, 64);
  const lq = q.toLowerCase();
  if (FULL_ADDR.test(lq)) {
    return memoized(`sug:${lq}`, 30_000, async () => {
      const [a, b] = await Promise.allSettled([
        api<{ data?: ApiItem }>(`/launches/${lq}`, 300, 3_000),
        v6Page(lq, null, 1, 60),
      ]);
      const v1 = a.status === "fulfilled" && a.value.data && visible(a.value.data) ? toCard(a.value.data) : null;
      const v6 = b.status === "fulfilled" ? (b.value.items.find((c) => c.token === lq) ?? null) : null;
      // a 404 from the single-token endpoint is a real "not a v1 launch"; anything else failing on both sides is unknown
      const v1Unknown = a.status === "rejected" && !/ 404$/.test(String((a.reason as Error | undefined)?.message));
      if (!v1 && !v6 && (v1Unknown || b.status === "rejected")) throw new Error("vibe api down");
      const items = [v1, v6].filter((c): c is LaunchCard => !!c).map(slim);
      return { items, more: false, kind: "address" as const };
    });
  }
  if (PART_ADDR.test(lq)) {
    const p = await prefixSearch(lq);
    return { items: p.items.slice(0, 6).map(slim), more: p.items.length > 6, kind: "prefix" };
  }
  const [a, b] = await Promise.allSettled([v1Page("new", q, null, 24, 15), v6Page(q, null, 24, 15)]);
  if (a.status === "rejected" && b.status === "rejected") throw a.reason;
  const all = [...(a.status === "fulfilled" ? a.value.items : []), ...(b.status === "fulfilled" ? b.value.items : [])].sort((x, y) => y.createdAt - x.createdAt);
  const items = pinExact(all, q);
  return { items: items.slice(0, 6).map(slim), more: items.length > 6, kind: "text" };
}

/* ---------------- 24 h price sparklines (/sparklines?tokens=: up to 60 tokens per call) ---------------- */

/**
 * One token's last 24 h, ready to draw: x and y on a 0..1000 grid (x = time inside the window,
 * y = close between the window's min and max). The last close is carried to the right edge
 * (a price holds until the next trade). Empty x = no trade in the window (a real "no trades",
 * vibe reports full coverage); a token missing from the map = unknown.
 */
export type Spark = { x: number[]; y: number[]; chgBps: number | null };

type ApiSpark = { data?: { from?: string; toExclusive?: string; tokens?: Record<string, { times?: unknown; closes?: unknown }> } };

const SPARK_BATCH = 60; // vibe answers 400 above 60 tokens
const SPARK_POINTS = 64; // one point per pixel of a 64 px sparkline is enough

function toSpark(times: unknown, closes: unknown, from: number, to: number): Spark | null {
  if (!Array.isArray(times) || !Array.isArray(closes) || times.length !== closes.length) return null;
  const pts: { t: number; p: number }[] = [];
  for (let i = 0; i < times.length; i++) {
    const t = Number(times[i]);
    const p = isInt(closes[i]) ? Number(closes[i]) : NaN;
    if (Number.isFinite(t) && Number.isFinite(p) && p > 0) pts.push({ t, p });
  }
  if (pts.length !== times.length) return null; // a malformed series is unknown, not flat
  if (!pts.length) return { x: [], y: [], chgBps: null };
  pts.sort((a, b) => a.t - b.t);
  // thin to at most SPARK_POINTS buckets (last close of each), then carry the last close to "now"
  const span = Math.max(1, to - from);
  const thin = new Map<number, { t: number; p: number }>();
  for (const q of pts) thin.set(Math.min(SPARK_POINTS - 1, Math.max(0, Math.floor(((q.t - from) / span) * SPARK_POINTS))), q);
  const kept = [...thin.values()];
  const last = kept[kept.length - 1];
  const series = [...kept, { t: to, p: last.p }];
  const ps = series.map((q) => q.p);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  const x = series.map((q) => Math.round(Math.min(1000, Math.max(0, ((q.t - from) / span) * 1000))));
  const y = series.map((q) => (max === min ? 500 : Math.round(((q.p - min) / (max - min)) * 1000)));
  const first = pts[0].p;
  return { x, y, chgBps: Math.round((last.p / first - 1) * 10_000) };
}

/** 24 h price sparklines for up to 120 tokens (at most 2 upstream calls). Throws when vibe does not answer at all. */
export async function sparklines(tokens: string[]): Promise<Record<string, Spark>> {
  const list = [...new Set(tokens.map((t) => t.toLowerCase()).filter((t) => FULL_ADDR.test(t)))].sort().slice(0, SPARK_BATCH * 2);
  if (!list.length) return {};
  const parts = [list.slice(0, SPARK_BATCH), list.slice(SPARK_BATCH)].filter((p) => p.length);
  const got = await Promise.allSettled(
    parts.map((p) => {
      const key = p.join(",");
      // 15 min candles: 96 at most per token, thinned to 64 here; the data cache shares them for a minute
      return memoized(`spark:${key}`, 60_000, () => api<ApiSpark>(`/sparklines?interval=15m&tokens=${key}`, 60, 6_000));
    }),
  );
  if (got.every((r) => r.status === "rejected")) throw new Error("vibe api down");
  const out: Record<string, Spark> = {};
  for (const r of got) {
    if (r.status !== "fulfilled") continue; // that half stays unknown
    const d = r.value.data;
    const from = Date.parse(d?.from ?? "") / 1000;
    const to = Date.parse(d?.toExclusive ?? "") / 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    for (const [tk, v] of Object.entries(d?.tokens ?? {})) {
      const t = tk.toLowerCase();
      if (!list.includes(t)) continue;
      const s = toSpark(v?.times, v?.closes, from, to);
      if (s) out[t] = s;
    }
  }
  return out;
}
