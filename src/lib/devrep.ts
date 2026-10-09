// Dev reputation: every launch by one creator, from the vibe/vibe public API, in ONE call.
// Facts only (how many launches, how many graduated); the page words them, never as a verdict.
import "server-only";
import { CHAIN_ID } from "./config";
import { BoundedTtlMap } from "./bounded";
import { explorer, funding, isHub, KNOWN_HUBS, HUB_CHILDREN, type Funding } from "./holders";
import { earlyIndex, earlyIndexAgeSec, perIndex } from "@/lib/earlyIndex";
import { chainDevCount, type ChainDevCount } from "./state";
import { addressTransfers } from "./blockscout";

const API = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
const HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "Mozilla/5.0" };
const TTL_S = 600; // 10 min: a dev's history changes slowly

export type DevLaunch = {
  token: string;
  symbol: string;
  createdAt: number; // unix seconds, 0 = unknown
  progressBps: number;
  graduated: boolean;
  /** hidden by vibe/vibe moderation: listed, never linked */
  hidden: boolean;
  /** a taxed v6 launch (its own factory and list on vibe) */
  taxed?: boolean;
};

/** "full" = both of vibe's lists (curve launches and taxed v6) answered; "v1-only" = the v6 list failed: its launches are unknown */
export type DevCoverage = "full" | "v1-only";

export type DevRep = {
  creator: string;
  /** launches by this creator as vibe reports them; null = more than we loaded and no total given */
  total: number | null;
  /** how many launches are in `launches` (vibe caps one page at 100) */
  loaded: number;
  /** graduated among the loaded launches */
  graduated: number;
  launches: DevLaunch[]; // newest first
  /**
   * The factory history's count, set only when it is above what vibe lists: vibe's creator lists leave out
   * the first and legacy factories, so vibe can say 0 for a wallet the chain shows with hundreds of launches.
   */
  onChain?: ChainDevCount;
  coverage: DevCoverage;
};

/** The chain's count when it beats vibe's (null/undefined otherwise). Never waits long, never throws. */
async function chainAbove(creator: string, vibeTotal: number | null, loaded: number): Promise<ChainDevCount | undefined> {
  const c = await Promise.race([chainDevCount(creator).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1_500))]);
  return c && c.launches > (vibeTotal ?? loaded) ? c : undefined;
}

type ApiItem = {
  tokenAddress?: string; symbol?: string; createdAt?: string;
  moderation?: { visibility?: string };
  curve?: { lifecycle?: string; progressBps?: number; graduatedAt?: string | null };
};
type ApiPage = { data?: { items?: ApiItem[]; page?: { totalCount?: number; hasMore?: boolean } } };

const memo = new BoundedTtlMap<DevRep>(2_000);
const inflight = new Map<string, Promise<DevRep>>();

async function load(creator: string): Promise<DevRep> {
  // offset=0 makes vibe add page.totalCount (checked 29.09: a creator with 115 launches reports 115 with 100 items)
  const r = await fetch(`${API}/launches?creatorAddress=${creator}&limit=100&offset=0`, {
    headers: HEADERS,
    next: { revalidate: TTL_S },
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`vibe api ${r.status}`);
  const j = (await r.json()) as ApiPage;
  const items = j.data?.items;
  if (!Array.isArray(items)) throw new Error("vibe api: no items");
  const launches: DevLaunch[] = items
    .filter((x) => typeof x.tokenAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.tokenAddress))
    .map((x) => ({
      token: x.tokenAddress!.toLowerCase(),
      symbol: String(x.symbol ?? "").slice(0, 16),
      createdAt: Math.floor(Date.parse(x.createdAt ?? "") / 1000) || 0,
      progressBps: Math.max(0, Math.min(10_000, Number(x.curve?.progressBps ?? 0) || 0)),
      graduated: x.curve?.lifecycle === "GRADUATED" || !!x.curve?.graduatedAt,
      hidden: x.moderation?.visibility === "HIDDEN",
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const page = j.data?.page ?? {};
  const reported = Number(page.totalCount);
  const v1Total = Number.isFinite(reported) && reported >= launches.length ? reported : page.hasMore ? null : launches.length;
  // taxed v6 launches live in their own list: without them a v6-only dev read as "0 launches"
  const v6 = await v6Launches(creator, TTL_S).catch(() => null);
  const all = [...launches, ...(v6?.launches ?? []).map((l): DevLaunch => ({ token: l.token, symbol: l.symbol, createdAt: l.createdAt, progressBps: l.progressBps, graduated: l.graduated, hidden: l.hidden, taxed: true }))]
    .sort((a, b) => b.createdAt - a.createdAt);
  // v6 failed: vibe's v1 count stands, marked "v1-only" (the page says v6 is not covered, never 0)
  const total = v1Total === null ? null : !v6 ? v1Total : v6.total === null ? null : v1Total + v6.total;
  const onChain = await chainAbove(creator, total, all.length);
  return { creator, total, loaded: all.length, graduated: all.filter((l) => l.graduated).length, launches: all, coverage: v6 ? "full" : "v1-only", ...(onChain ? { onChain } : {}) };
}

/* ---------------- vibe: taxed v6 launches by one creator ---------------- */

type V6ListItem = {
  tokenAddress?: string; curveAddress?: string; launcherAddress?: string; name?: string; symbol?: string; createdAt?: string;
  moderation?: { visibility?: string } | null; lifecycle?: string; graduated?: boolean;
  graduation?: { at?: string } | null; targetPairUnits?: string; curve?: { pairReserveUnits?: string };
  market?: { holderCount?: number | null } | null;
};
const V6_PAGES = 3; // 150 launches

/**
 * Every taxed v6 launch by `creator`. vibe's /v6/launches has no creator filter; its search (`q`) matches the
 * launcher address (checked 09.10.2026: 13 of 13 for 0xc11c…97c7), and every item is filtered on launcherAddress
 * so a name or token match can't slip in. Throws when vibe does not answer (the caller marks v6 as not covered).
 */
async function v6Launches(creator: string, revalidateS: number): Promise<{ launches: VibeLaunch[]; total: number | null }> {
  const out: VibeLaunch[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let complete = false;
  for (let p = 0; p < V6_PAGES; p++) {
    const j: { data?: { items?: V6ListItem[]; page?: { hasMore?: boolean; nextCursor?: string | null } } } = await vibeJson(
      `/v6/launches?q=${creator}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      9_000,
      revalidateS,
    );
    const got = j.data?.items;
    if (!Array.isArray(got)) throw new Error("vibe v6: no items");
    for (const x of got) {
      if (typeof x.tokenAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x.tokenAddress)) continue;
      if (String(x.launcherAddress ?? "").toLowerCase() !== creator) continue;
      const token = x.tokenAddress.toLowerCase();
      if (seen.has(token)) continue;
      seen.add(token);
      const graduated = x.graduated === true || x.lifecycle === "GRADUATED";
      const target = big(x.targetPairUnits);
      const reserve = big(x.curve?.pairReserveUnits);
      const gAt = Math.floor(Date.parse(x.graduation?.at ?? "") / 1000);
      const hc = Number(x.market?.holderCount);
      out.push({
        token,
        symbol: cleanStr(x.symbol, 16),
        name: cleanStr(x.name, 40),
        curve: typeof x.curveAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.curveAddress) ? x.curveAddress.toLowerCase() : "",
        createdAt: Math.floor(Date.parse(x.createdAt ?? "") / 1000) || 0,
        progressBps: graduated ? 10_000 : target && target > 0n && reserve !== null ? Math.min(10_000, Number((reserve * 10_000n) / target)) : 0,
        graduated,
        graduatedAt: Number.isFinite(gAt) && gAt > 0 ? gAt : null,
        hidden: x.moderation?.visibility === "HIDDEN",
        holders: x.market?.holderCount === undefined || x.market?.holderCount === null || !Number.isFinite(hc) ? null : Math.max(0, Math.floor(hc)),
        taxed: true,
      });
    }
    cursor = j.data?.page?.hasMore && j.data.page.nextCursor ? j.data.page.nextCursor : null;
    if (!cursor) {
      complete = true;
      break;
    }
  }
  return { launches: out, total: complete ? out.length : null };
}

/** Throws when vibe does not answer: the caller shows nothing (unknown), never "1st launch". */
export async function devReputation(creator: string): Promise<DevRep> {
  const c = creator.toLowerCase();
  const hit = memo.get(c);
  if (hit) return hit;
  const running = inflight.get(c);
  if (running) return running;
  const p = load(c)
    .then((v) => {
      memo.set(c, v, TTL_S * 1000);
      return v;
    })
    .finally(() => inflight.delete(c));
  inflight.set(c, p);
  return p;
}

/* ======================================================================================
 * Dev Passport (/dev/<addr>): the whole history of one creator, facts only.
 *
 * Costs per creator (cold), all cached:
 * - vibe: 1 call per 100 launches (max 3 pages) + 1 call for creator fees. 5 min.
 * - Blockscout: the creator's ERC-20 transfers back to its oldest launch (newest first, up to 40 pages;
 *   the node caps an address-list getLogs at 100,000 blocks since 05.10.2026). Block times come with them.
 * - Linked wallets (separate, slower): Blockscout via holders.ts (shared budget) + up to
 *   SIBLING_CHECKS small vibe calls + a few Blockscout pages per linked wallet (incoming transfers). 30 min.
 * Unknown is never zero: every number that could not be read is null and the page says why.
 * ====================================================================================== */

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // graduated tokens trade in the V4 pool
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const MAX_PAGES = 3; // 300 launches: enough for the page, bounded for vibe
const PASSPORT_TTL = 300_000;
/** the passport's launch list rides the data cache like devReputation's: the wallet page and the passport agree during a vibe blip */
const LIST_REVALIDATE_S = 300;
/** last good passport per creator: served (marked stale) when vibe fails, instead of "not answering" */
const LAST_GOOD_TTL = 24 * 3600_000;
const LINKED_TTL = 1_800_000;
const SIBLING_CHECKS = 8; // vibe calls for "did this linked wallet launch tokens?"
const LINK_LIST_MAX = 40; // wallets shown per linked list
const SENDER_HUB_CHECKS = 3; // explorer counters calls for "is this ETH sender a hub?"
const FAST_SELL_S = 600;
const INDEX_MAX_AGE = 14 * 86_400;

const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a);

/* ---------------- Early Index labels (offline, free) ---------------- */

// read at runtime (lib/earlyIndex): the sets are rebuilt only when a new index lands on disk
const tagSets = () =>
  perIndex("devrep.tags", (ix) => {
    const farmOf = new Map<string, number>();
    for (const f of ix.farms) for (const w of f.wallets) farmOf.set(w.toLowerCase(), f.id);
    return { snipers: new Set(ix.snipers.map((w) => w.toLowerCase())), verified: new Set(ix.verifiedEarly.map((w) => w.toLowerCase())), farmOf };
  });

export type WalletTags = { sniper: boolean; farm: number | null; verified: boolean };
export function walletTags(a: string): WalletTags {
  const w = a.toLowerCase();
  const t = tagSets();
  return { sniper: t.snipers.has(w), farm: t.farmOf.get(w) ?? null, verified: t.verified.has(w) };
}
/** seconds since the Early Index was built */
export const earlyIndexAge = () => earlyIndexAgeSec();

/** at most `n` promises at once, order kept */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/* ---------------- vibe: every launch (up to 300) + fees ---------------- */

type FullItem = ApiItem & { name?: string; curveAddress?: string; holderCount?: number | null };

export type VibeLaunch = {
  token: string;
  symbol: string;
  name: string;
  curve: string;
  createdAt: number; // unix seconds, 0 = unknown
  progressBps: number;
  graduated: boolean;
  graduatedAt: number | null;
  hidden: boolean;
  /** holders as vibe reports them; null = not given */
  holders: number | null;
  /** a taxed v6 launch (graduates at its own target, 4 ETH on ETH pairs) */
  taxed?: boolean;
};

// same rule as lib/chain.ts cleanText (that file pulls the whole viem client; this keeps devrep light)
const UNSAFE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]", "g");
const cleanStr = (v: unknown, max: number) => String(v ?? "").replace(UNSAFE, "").trim().slice(0, max);

/** revalidateS: answer from the data cache (and keep answering through a vibe blip), like devReputation's list */
async function vibeJson<T>(path: string, timeoutMs = 9_000, revalidateS?: number): Promise<T> {
  const cacheOpt: RequestInit = revalidateS ? { next: { revalidate: revalidateS } } : { cache: "no-store" };
  const r = await fetch(`${API}${path}`, { headers: HEADERS, ...cacheOpt, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`vibe api ${r.status}`);
  return (await r.json()) as T;
}

async function allLaunches(creator: string): Promise<{ launches: VibeLaunch[]; total: number | null }> {
  const items: FullItem[] = [];
  let total: number | null = null;
  let complete = false;
  for (let p = 0; p < MAX_PAGES; p++) {
    const j = await vibeJson<{ data?: { items?: FullItem[]; page?: { totalCount?: number; hasMore?: boolean } } }>(
      `/launches?creatorAddress=${creator}&limit=100&offset=${p * 100}`,
      9_000,
      LIST_REVALIDATE_S,
    );
    const got = j.data?.items;
    if (!Array.isArray(got)) throw new Error("vibe api: no items");
    items.push(...got);
    const tc = Number(j.data?.page?.totalCount);
    if (j.data?.page?.totalCount !== undefined && Number.isFinite(tc)) total = tc;
    if (!j.data?.page?.hasMore || got.length < 100) {
      complete = true;
      break;
    }
  }
  const seen = new Set<string>();
  const launches: VibeLaunch[] = [];
  for (const x of items) {
    if (typeof x.tokenAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x.tokenAddress)) continue;
    const token = x.tokenAddress.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    const gAt = Math.floor(Date.parse(x.curve?.graduatedAt ?? "") / 1000);
    const hc = Number(x.holderCount);
    launches.push({
      token,
      symbol: cleanStr(x.symbol, 16),
      name: cleanStr(x.name, 40),
      curve: typeof x.curveAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(x.curveAddress) ? x.curveAddress.toLowerCase() : "",
      createdAt: Math.floor(Date.parse(x.createdAt ?? "") / 1000) || 0,
      progressBps: Math.max(0, Math.min(10_000, Number(x.curve?.progressBps ?? 0) || 0)),
      graduated: x.curve?.lifecycle === "GRADUATED" || !!x.curve?.graduatedAt,
      graduatedAt: Number.isFinite(gAt) && gAt > 0 ? gAt : null,
      hidden: x.moderation?.visibility === "HIDDEN",
      holders: x.holderCount === undefined || x.holderCount === null || !Number.isFinite(hc) ? null : Math.max(0, Math.floor(hc)),
    });
  }
  launches.sort((a, b) => b.createdAt - a.createdAt);
  if (total === null && complete) total = launches.length;
  return { launches, total: total !== null && total >= launches.length ? total : complete ? launches.length : null };
}

type FeeItem = {
  tokenAddress?: string;
  curveClaimableWei?: string | null;
  curveForwardedWei?: string | null;
  hookClaimableWei?: string | null;
  hookClaimedWei?: string | null;
};
const big = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

/** Creator fees as vibe reports them, per token: still on the curve + already sent to the vault + hook (after graduation). */
async function creatorFees(creator: string): Promise<Map<string, bigint | null>> {
  const j = await vibeJson<{ data?: { items?: FeeItem[] } }>(`/creators/${creator}/fees`);
  const items = j.data?.items;
  if (!Array.isArray(items)) throw new Error("vibe fees: no items");
  const m = new Map<string, bigint | null>();
  for (const x of items) {
    if (typeof x.tokenAddress !== "string") continue;
    const parts = [x.curveClaimableWei, x.curveForwardedWei, x.hookClaimableWei, x.hookClaimedWei].map(big);
    // a part vibe did not give makes that token's total unknown, never a smaller number
    m.set(x.tokenAddress.toLowerCase(), parts.some((p) => p === null) ? null : parts.reduce<bigint>((s, p) => s + (p as bigint), 0n));
  }
  return m;
}

/* ---------------- chain: the dev's own token moves ---------------- */

export type DevMoves = {
  /** tokens that reached the dev (curve buys, transfers in), wei */
  receivedWei: string;
  /** tokens the dev sent to the curve or the V4 pool = sells, wei */
  soldWei: string;
  /** tokens the dev sent to any other address (not a sale, but they left the dev), wei */
  movedWei: string;
  sells: number;
  firstSellBlock: number | null;
  /** unix seconds; null when there is no sell or the block time could not be read */
  firstSellAt: number | null;
  /** sold / received in bps; null when nothing was received */
  soldBps: number | null;
};

// The creator's own transfers come from Blockscout (one newest-first stream, both directions): the node caps an
// address-list getLogs at 100,000 blocks since 05.10.2026, so 50 launches x the whole history is no longer one call.
const MOVES_PAGES = 40; // 2,000 transfers; an older launch past the cap is unknown (null), never "no sells"
const MOVES_BUDGET_MS = 10_000;
const LAUNCH_MARGIN_S = 6 * 3600; // vibe's createdAt is its indexer's time: read a little past the oldest launch

async function devMoves(creator: string, launches: VibeLaunch[]): Promise<Map<string, DevMoves>> {
  const known = launches.filter((l) => l.createdAt > 0);
  const oldest = known.length === launches.length && known.length ? Math.min(...known.map((l) => l.createdAt)) - LAUNCH_MARGIN_S : undefined;
  const hist = await addressTransfers(creator, { maxPages: MOVES_PAGES, stopBeforeTs: oldest, deadline: Date.now() + MOVES_BUDGET_MS });
  // an incomplete read covers launches made after its oldest transfer (a token's transfers start at its launch)
  const covered = (l: VibeLaunch) => hist.complete || (l.createdAt > 0 && hist.oldestTs !== null && l.createdAt - LAUNCH_MARGIN_S >= hist.oldestTs);
  const curveOf = new Map(launches.map((l) => [l.token, l.curve]));
  type Acc = { inW: bigint; sold: bigint; moved: bigint; sells: number; first: number | null; firstTs: number | null };
  const acc = new Map<string, Acc>(launches.filter(covered).map((l) => [l.token, { inW: 0n, sold: 0n, moved: 0n, sells: 0, first: null, firstTs: null }]));
  const seen = new Set<string>();
  for (const t of hist.items) {
    const a = acc.get(t.token);
    if (!a || t.from === t.to) continue; // not this dev's launch, or a self-transfer: nothing moved
    const key = `${t.tx}:${t.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.to === creator) a.inW += t.value;
    else if (t.from === creator) {
      const curve = curveOf.get(t.token);
      if ((curve && t.to === curve) || t.to === POOL_MANAGER) {
        a.sold += t.value;
        a.sells++;
        if (a.first === null || t.block < a.first) {
          a.first = t.block;
          a.firstTs = t.ts;
        }
      } else if (t.to !== ZERO_ADDR) a.moved += t.value;
    }
  }
  const out = new Map<string, DevMoves>();
  for (const [token, a] of acc) {
    out.set(token, {
      receivedWei: a.inW.toString(),
      soldWei: a.sold.toString(),
      movedWei: a.moved.toString(),
      sells: a.sells,
      firstSellBlock: a.first,
      firstSellAt: a.firstTs,
      soldBps: a.inW > 0n ? Number(((a.sold > a.inW ? a.inW : a.sold) * 10_000n) / a.inW) : null,
    });
  }
  return out;
}

/* ---------------- the passport ---------------- */

export type PassportLaunch = VibeLaunch & {
  /** null = the chain read failed (unknown, not "no sells") */
  dev: DevMoves | null;
  /** creator fees for this token in wei; null = unknown */
  feesWei: string | null;
};

export type Fact = { id: string; label: string; detail: string; tone: "good" | "info" | "warn" | "bad" };

export type DevPassport = {
  creator: string;
  tags: WalletTags;
  indexAge: number;
  /** launches vibe reports for this creator; null = more than we loaded and no total given */
  total: number | null;
  loaded: number;
  graduated: number;
  launches: PassportLaunch[]; // newest first
  chain: "ok" | "unknown";
  /** factory-history count when it is above vibe's (vibe's lists leave the first and legacy factories out) */
  onChain: ChainDevCount | null;
  /** "v1-only" = vibe's taxed v6 list did not answer: those launches are unknown, not absent */
  coverage: DevCoverage;
  fees: { status: "ok" | "partial" | "unknown"; totalWei: string | null; tokens: number };
  summary: {
    /** launches where the dev ever held the token (null = chain unknown) */
    devHeld: number | null;
    /** launches where the dev sold into the curve / pool */
    soldIn: number | null;
    /** median seconds from launch to the dev's first sell (sells with a known time only) */
    medianFirstSell: number | null;
    timedSells: number;
    /** first sell within 10 min; null when chain is unknown or a sell has no time */
    within10m: number | null;
    heldThroughGrad: number | null;
    gradWithDevBag: number | null;
  };
  facts: Fact[];
  updatedAt: number;
  /** true = vibe failed just now; this is the last good read, as of updatedAt */
  stale?: boolean;
};

const passportMemo = new BoundedTtlMap<DevPassport>(1_000);
const passportLastGood = new BoundedTtlMap<DevPassport>(1_000);
const passportInflight = new Map<string, Promise<DevPassport>>();

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** 42s, 7 min, 3.4 h, 2.1 d */
export function fmtDuration(s: number) {
  if (s < 60) return `${Math.max(0, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${(s / 3600).toFixed(s < 36_000 ? 1 : 0)} h`;
  return `${(s / 86_400).toFixed(1)} d`;
}

function buildFacts(p: Omit<DevPassport, "facts">): Fact[] {
  const f: Fact[] = [];
  const s = p.summary;
  const n = Math.max(p.total ?? p.loaded, p.onChain?.launches ?? 0);
  if (p.tags.sniper) f.push({ id: "sniper", label: "Known sniper wallet", detail: "Early Index: among the first buyers on 50+ tokens in a week.", tone: "bad" });
  if (p.tags.farm !== null) f.push({ id: "farm", label: `Farm group #${p.tags.farm}`, detail: "Early Index: one of a group of wallets funded from one source and buying together.", tone: "bad" });
  if (p.tags.verified) f.push({ id: "verified", label: "Verified early", detail: "Early Index: a verified early buyer.", tone: "good" });
  if (p.total === 1 && !p.onChain && p.coverage === "full") f.push({ id: "first", label: "1st launch", detail: "The only token this wallet launched on vibe/vibe.", tone: "info" });
  else if (n >= 10) f.push({ id: "serial", label: `Serial launcher ${p.total === null && !p.onChain ? `${p.loaded}+` : n}×`, detail: "10+ launches from one wallet.", tone: "warn" });
  if (p.graduated > 0) f.push({ id: "grad", label: `Graduated ${p.graduated}×`, detail: `${p.graduated} of ${p.loaded} loaded launches filled their curve (5 ETH; 4 ETH on taxed v6) and moved to Uniswap V4.`, tone: "good" });
  if (p.chain === "ok" && s.devHeld !== null) {
    if (s.devHeld === 0 && p.loaded > 0) f.push({ id: "nobag", label: "No dev bag", detail: "The dev never held their own token on any loaded launch.", tone: "info" });
    if (s.devHeld >= 2 && s.soldIn === 0) f.push({ id: "neversold", label: "Never sold", detail: `Held on ${s.devHeld} launches, sold on none.`, tone: "good" });
    if (s.heldThroughGrad !== null && s.heldThroughGrad > 0)
      f.push({ id: "heldgrad", label: "Held through graduation", detail: `No sell before graduation on ${s.heldThroughGrad} of ${s.gradWithDevBag} graduated launches with a dev bag.`, tone: "good" });
    // most of the dev's sells come in the first 10 minutes (and there is more than one, or the only bag was sold so)
    if (s.within10m !== null && s.soldIn !== null && s.within10m > 0 && s.within10m * 2 >= s.soldIn && (s.within10m >= 2 || s.devHeld === 1))
      f.push({ id: "fast", label: "Sells within 10 min", detail: `First sell within 10 min of launch on ${s.within10m} of the ${s.soldIn} launches the dev sold on (${s.devHeld} held).`, tone: "bad" });
    // the median itself is a summary stat, not repeated here
    if (s.devHeld >= 3 && s.soldIn !== null && s.soldIn * 4 >= s.devHeld * 3)
      f.push({ id: "sellsmost", label: "Sells most bags", detail: `Sold on ${s.soldIn} of ${s.devHeld} launches with a dev bag.`, tone: "warn" });
  }
  return f;
}

async function loadPassport(creator: string): Promise<DevPassport> {
  const [v1, v6, fees] = await Promise.all([
    allLaunches(creator),
    v6Launches(creator, LIST_REVALIDATE_S).catch(() => null),
    creatorFees(creator).catch(() => null),
  ]);
  // one list for the page: curve launches + taxed v6 (newest first); v6 unknown = "v1-only", never "none"
  const list = {
    launches: [...v1.launches, ...(v6?.launches ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    total: v1.total === null ? null : !v6 ? v1.total : v6.total === null ? null : v1.total + v6.total,
  };
  const onChain = (await chainAbove(creator, list.total, list.launches.length)) ?? null;
  let moves: Map<string, DevMoves> | null;
  try {
    // taxed v6 launches are left out of the dev-bag read: checked 09.10 on $GHJ, the chain shows the creator receiving
    // tokens while this read said "never held" (v6 also pays holder tax as token transfers). Unknown, never "never held".
    const curveOnly = list.launches.filter((l) => !l.taxed);
    moves = curveOnly.length ? await devMoves(creator, curveOnly) : new Map();
  } catch {
    moves = null;
  }
  const launches: PassportLaunch[] = list.launches.map((l) => {
    const fw = fees?.get(l.token);
    return { ...l, dev: moves?.get(l.token) ?? null, feesWei: fw === undefined || fw === null ? null : fw.toString() };
  });

  // fees: a token missing from vibe's fee list is unknown, not zero
  let feeTotal = 0n;
  let feeKnown = 0;
  for (const l of launches)
    if (l.feesWei !== null) {
      feeTotal += BigInt(l.feesWei);
      feeKnown++;
    }
  const feeStatus = fees === null || feeKnown === 0 ? (launches.length === 0 && fees ? "ok" : "unknown") : feeKnown === launches.length ? "ok" : "partial";

  const chainOk = moves !== null;
  // dev-bag stats cover curve launches only (v6 bags are not read): none of those = unknown, not "never held"
  const devKnown = chainOk && launches.some((l) => !l.taxed);
  const held = launches.filter((l) => l.dev && BigInt(l.dev.receivedWei) > 0n);
  const sold = held.filter((l) => l.dev!.sells > 0);
  const delays = sold.filter((l) => l.dev!.firstSellAt !== null && l.createdAt > 0).map((l) => Math.max(0, l.dev!.firstSellAt! - l.createdAt));
  const untimed = sold.length - delays.length;
  const gradHeld = held.filter((l) => l.graduated && l.graduatedAt !== null);
  // "held through": no sell, or the first sell is known to be after graduation
  const through = gradHeld.filter((l) => l.dev!.sells === 0 || (l.dev!.firstSellAt !== null && l.dev!.firstSellAt >= l.graduatedAt!));

  const base: Omit<DevPassport, "facts"> = {
    creator,
    tags: walletTags(creator),
    indexAge: earlyIndexAge(),
    total: list.total,
    loaded: launches.length,
    graduated: launches.filter((l) => l.graduated).length,
    launches,
    chain: chainOk ? "ok" : "unknown",
    onChain,
    coverage: v6 ? "full" : "v1-only",
    fees: { status: feeStatus, totalWei: feeStatus === "unknown" ? null : feeTotal.toString(), tokens: feeKnown },
    summary: {
      devHeld: devKnown ? held.length : null,
      soldIn: devKnown ? sold.length : null,
      medianFirstSell: median(delays),
      timedSells: delays.length,
      within10m: devKnown && untimed === 0 ? delays.filter((d) => d <= FAST_SELL_S).length : null,
      heldThroughGrad: devKnown ? through.length : null,
      gradWithDevBag: devKnown ? gradHeld.length : null,
    },
    updatedAt: Date.now(),
  };
  return { ...base, facts: buildFacts(base) };
}

/** Throws when vibe does not answer the launch list (nothing to show); chain / fee failures come back as unknown parts. */
export async function devPassport(creator: string): Promise<DevPassport> {
  const c = creator.toLowerCase();
  if (!isAddr(c)) throw new Error("bad address");
  const hit = passportMemo.get(c);
  if (hit) return hit;
  const running = passportInflight.get(c);
  if (running) return running;
  const p = loadPassport(c)
    .then((v) => {
      // a passport with an unknown part is kept for a minute only, so it heals soon
      passportMemo.set(c, v, v.chain === "ok" && v.fees.status !== "unknown" ? PASSPORT_TTL : 60_000);
      passportLastGood.set(c, v, LAST_GOOD_TTL);
      return v;
    })
    .catch((e) => {
      // vibe failed: the last good copy (marked stale) beats "not answering"; none = the caller shows unknown
      const old = passportLastGood.get(c);
      if (!old) throw e;
      const stale: DevPassport = { ...old, stale: true };
      passportMemo.set(c, stale, 30_000);
      return stale;
    })
    .finally(() => passportInflight.delete(c));
  passportInflight.set(c, p);
  return p;
}

/* ---------------- linked wallets (funding cluster) ---------------- */

export type LinkedWallet = {
  address: string;
  tags: WalletTags;
  /** launches on vibe/vibe; null = not checked (budget) or vibe failed — see launchesChecked */
  launches: number | null;
  launchesChecked: boolean;
  /** how many of THIS dev's launches the wallet received tokens on; null = unknown */
  boughtDevLaunches: number | null;
};

export type DevLinks = {
  creator: string;
  /** how the dev got its first ETH; null = explorer failed (unknown) */
  funding: Funding | null;
  funder: (LinkedWallet & { hub: boolean | null }) | null;
  /** other wallets the funder sent ETH to (oldest first, capped) */
  siblings: LinkedWallet[];
  siblingsSeen: number;
  /** the funder's history is longer than what we read */
  siblingsCut: boolean;
  /** wallets the dev itself sent plain ETH to */
  funded: LinkedWallet[];
  fundedSeen: number;
  fundedCut: boolean;
  /** wallets that sent the dev plain ETH (any time in the read window), hubs dropped; ETH summed */
  senders: (LinkedWallet & { eth: number; txs: number })[];
  sendersSeen: number;
  /** senders left out because they are hubs (faucet, exchange, bot hub) */
  sendersHubs: number;
  /** parts that failed: "funding" | "hub" | "siblings" | "funded" | "launches" | "bought" */
  unknown: string[];
  updatedAt: number;
};

type BsTx = { from?: string; to?: string; value?: string; isError?: string; input?: string };
type BsList = { status?: string; message?: string; result?: BsTx[] | string };

async function bsList(action: "txlist" | "txlistinternal", address: string, n: number): Promise<BsTx[]> {
  const j = await explorer<BsList>(`/api?module=account&action=${action}&address=${address}&sort=asc&page=1&offset=${n}`);
  if (Array.isArray(j.result)) return j.result;
  if (j.status === "0" && /^No (internal )?transactions found/i.test(String(j.message ?? ""))) return [];
  throw new Error("explorer: bad answer");
}

/** distinct wallets that got ETH from `from`; contract calls are skipped (a buy pays the curve, not a person) */
function recipients(txs: BsTx[], from: string, plainOnly: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of txs) {
    const f = x.from?.toLowerCase();
    const t = x.to?.toLowerCase();
    if (f !== from || !t || !isAddr(t) || t === from || seen.has(t)) continue;
    if (x.isError === "1" || !/^\d+$/.test(x.value ?? "") || BigInt(x.value!) === 0n) continue;
    if (plainOnly && x.input && x.input !== "0x") continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

const launchCounts = new BoundedTtlMap<number>(20_000);
async function launchCount(addr: string): Promise<number | null> {
  const hit = launchCounts.get(addr);
  if (hit !== undefined) return hit;
  try {
    const j = await vibeJson<{ data?: { items?: unknown[]; page?: { totalCount?: number; hasMore?: boolean } } }>(
      `/launches?creatorAddress=${addr}&limit=1&offset=0`,
      6_000,
    );
    const items = j.data?.items;
    if (!Array.isArray(items)) return null;
    const tc = Number(j.data?.page?.totalCount);
    const v1 = j.data?.page?.totalCount !== undefined && Number.isFinite(tc) ? tc : !j.data?.page?.hasMore ? items.length : null;
    if (v1 === null) return null;
    // + taxed v6 launches (their own list): a v6-only dev must not read as "launched 0"
    const v6 = await v6Launches(addr, 3_600);
    if (v6.total === null) return null;
    const n = v1 + v6.total;
    launchCounts.set(addr, n, 3_600_000);
    return n;
  } catch {
    return null;
  }
}

const linksMemo = new BoundedTtlMap<DevLinks>(1_000);
const linksInflight = new Map<string, Promise<DevLinks>>();

async function loadLinks(creator: string): Promise<DevLinks> {
  const unknown: string[] = [];
  // 1) the dev's first funder (holders.ts: faucet / bridge / L1-alias aware, cached forever)
  const f = await funding(creator);
  if (!f) unknown.push("funding");

  // 2) the funder's other children, unless it is a hub (faucet, exchange, bot hub)
  let funder: DevLinks["funder"] = null;
  let siblingAddrs: string[] = [];
  let siblingsSeen = 0;
  let siblingsCut = false;
  if (f?.kind === "source") {
    const hub = KNOWN_HUBS.has(f.from) ? true : await isHub(f.from);
    funder = { address: f.from, tags: walletTags(f.from), launches: null, launchesChecked: false, boughtDevLaunches: null, hub };
    if (hub === null) unknown.push("hub");
    if (hub !== true) {
      try {
        const [txs, internal] = await Promise.all([bsList("txlist", f.from, 200), bsList("txlistinternal", f.from, 200)]);
        const kids = [...new Set([...recipients(txs, f.from, true), ...recipients(internal, f.from, false)])].filter((a) => a !== creator);
        siblingsSeen = kids.length;
        siblingsCut = txs.length >= 200 || internal.length >= 200;
        if (kids.length > HUB_CHILDREN) funder.hub = true; // funded a crowd: a hub, not a cluster
        else siblingAddrs = kids;
      } catch {
        unknown.push("siblings");
      }
    }
  }

  // 3) the dev's own plain ETH transfers, both ways (one list): who the dev funded, who topped the dev up.
  // Most devs start from the public faucet, so the first funder alone often says nothing; a later top-up can.
  let fundedAddrs: string[] = [];
  let fundedSeen = 0;
  let fundedCut = false;
  const sendAcc = new Map<string, { wei: bigint; txs: number }>();
  try {
    const txs = await bsList("txlist", creator, 200);
    fundedAddrs = recipients(txs, creator, true).filter((a) => a !== funder?.address);
    fundedSeen = fundedAddrs.length;
    fundedCut = txs.length >= 200;
    for (const x of txs) {
      const from = x.from?.toLowerCase() ?? "";
      // the first funder has its own row above; the faucet says nothing
      if (x.to?.toLowerCase() !== creator || !isAddr(from) || from === creator || from === funder?.address || KNOWN_HUBS.has(from)) continue;
      if (x.isError === "1" || !/^\d+$/.test(x.value ?? "") || BigInt(x.value!) === 0n || (x.input && x.input !== "0x")) continue;
      const a = sendAcc.get(from) ?? { wei: 0n, txs: 0 };
      a.wei += BigInt(x.value!);
      a.txs++;
      sendAcc.set(from, a);
    }
  } catch {
    unknown.push("funded");
  }
  // the biggest senders first; the top few are checked for hubs (cached), hubs are dropped
  const sendersAll = [...sendAcc.entries()].sort((a, b) => (b[1].wei > a[1].wei ? 1 : b[1].wei < a[1].wei ? -1 : 0));
  const hubFlags = await pool(sendersAll.slice(0, SENDER_HUB_CHECKS), 3, ([a]) => isHub(a));
  let sendersHubs = 0;
  const senderList = sendersAll.filter(([, ], i) => {
    if (i < SENDER_HUB_CHECKS && hubFlags[i] === true) {
      sendersHubs++;
      return false;
    }
    return true;
  });

  const mk = (a: string): LinkedWallet => ({ address: a, tags: walletTags(a), launches: null, launchesChecked: false, boughtDevLaunches: null });
  const siblings = siblingAddrs.slice(0, LINK_LIST_MAX).map(mk);
  const funded = fundedAddrs.slice(0, LINK_LIST_MAX).map(mk);
  const senders = senderList.slice(0, LINK_LIST_MAX).map(([a, v]) => ({ ...mk(a), eth: Number(v.wei / 10n ** 12n) / 1e6, txs: v.txs }));

  // 4) who of them launched tokens: a few small vibe calls, the funder first
  const toCheck: LinkedWallet[] = [...(funder && funder.hub !== true ? [funder] : []), ...senders.slice(0, 3), ...siblings].slice(0, SIBLING_CHECKS);
  await pool(toCheck, 3, async (w) => {
    w.launches = await launchCount(w.address);
    w.launchesChecked = true;
  });
  if (toCheck.some((w) => w.launches === null)) unknown.push("launches");

  // 5) did any linked wallet get tokens of this dev's launches? Blockscout: each wallet's incoming transfers back
  // to the dev's oldest launch (a few pages each); a wallet whose history runs past the cap stays unknown (null)
  const linked: LinkedWallet[] = [...(funder && funder.hub !== true ? [funder] : []), ...siblings, ...funded, ...senders];
  if (linked.length) {
    try {
      const rep = await devPassport(creator);
      const tokens = new Set(rep.launches.map((l) => l.token.toLowerCase()));
      const times = rep.launches.map((l) => l.createdAt).filter((t) => t > 0);
      const since = times.length === rep.launches.length && times.length ? Math.min(...times) - LAUNCH_MARGIN_S : undefined;
      const addrs = [...new Set(linked.map((w) => w.address))];
      let failed = false;
      const counts = new Map<string, number | null>();
      await pool(addrs, 4, async (a) => {
        try {
          const r = await addressTransfers(a, { filter: "to", maxPages: 4, stopBeforeTs: since });
          const got = new Set(r.items.filter((t) => tokens.has(t.token)).map((t) => t.token));
          // an incomplete read still proves the tokens it found; zero found on a partial read is unknown
          counts.set(a, r.complete || got.size ? got.size : null);
        } catch {
          failed = true;
          counts.set(a, null);
        }
      });
      for (const w of linked) w.boughtDevLaunches = counts.get(w.address) ?? null;
      if (failed || [...counts.values()].some((v) => v === null)) unknown.push("bought");
    } catch {
      unknown.push("bought");
    }
  }

  return {
    creator, funding: f, funder, siblings, siblingsSeen, siblingsCut, funded, fundedSeen, fundedCut,
    senders, sendersSeen: senderList.length, sendersHubs, unknown, updatedAt: Date.now(),
  };
}

/** Never throws for a valid address: failed parts are listed in `unknown`. */
export async function devLinks(creator: string): Promise<DevLinks> {
  const c = creator.toLowerCase();
  if (!isAddr(c)) throw new Error("bad address");
  const hit = linksMemo.get(c);
  if (hit) return hit;
  const running = linksInflight.get(c);
  if (running) return running;
  const p = loadLinks(c)
    .then((v) => {
      linksMemo.set(c, v, v.unknown.length ? 120_000 : LINKED_TTL);
      return v;
    })
    .finally(() => linksInflight.delete(c));
  linksInflight.set(c, p);
  return p;
}

/* ---------------- lookup landings (/w, /dev): real examples only, never a made-up address ---------------- */

export type RecentDev = {
  creator: string;
  /** launches as vibe (or the chain, when higher) reports them; null = unknown right now */
  launches: number | null;
  graduated: number | null;
  last: { token: string; symbol: string; createdAt: number; progressBps: number; graduated: boolean; hidden: boolean };
};

/** Creators of the newest launches, with their counts. [] when vibe does not answer (the page hides the block). */
export async function recentDevs(n = 5, budgetMs = 2_500): Promise<RecentDev[]> {
  const { launchPage } = await import("./launches");
  const page = await Promise.race([launchPage("new", "", null, 24, 60).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), budgetMs))]);
  if (!page) return [];
  const seen = new Set<string>();
  const picks = page.items.filter((l) => {
    const c = l.creator;
    if (!isAddr(c) || seen.has(c)) return false;
    seen.add(c);
    return true;
  }).slice(0, n);
  const reps = await Promise.all(
    picks.map((l) => Promise.race([devReputation(l.creator).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), budgetMs))])),
  );
  return picks.map((l, i) => {
    const rep = reps[i];
    const total = rep ? (rep.total ?? null) : null;
    return {
      creator: l.creator,
      launches: rep ? Math.max(total ?? rep.loaded, rep.onChain?.launches ?? 0, 1) : null, // it made at least the launch we see
      graduated: rep ? Math.max(rep.graduated, rep.onChain?.grads ?? 0) : null,
      last: { token: l.token, symbol: l.symbol, createdAt: l.createdAt, progressBps: l.progressBps, graduated: l.graduated, hidden: false },
    };
  });
}

/** A wallet on the Early Index sniper list; null when the index is too old to trust (labels unknown). */
export function exampleSniper(): string | null {
  if (earlyIndexAge() > INDEX_MAX_AGE) return null;
  const w = earlyIndex().snipers.find((x) => isAddr(x.toLowerCase()));
  return w ? w.toLowerCase() : null;
}
