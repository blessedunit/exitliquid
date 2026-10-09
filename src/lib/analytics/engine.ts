// Token analytics engine: one answer per token for /api/analytics/<token>.
// Server only. Reuses the line build (service.buildFor -> chain.loadEvents) so a token page costs no
// extra Transfer-log reads; adds live curve / pool reads (market.ts), V4 Swap events for graduated
// tokens, top-holder funding clusters (holders.ts, cached), nonces and same-ticker launches (vibe search).
//
// Unknown is never zero: a section that can't be computed is { data: null, reason }.
// Cache: the whole answer 30 s per token (the free route adds a short CDN s-maxage); slow history parts cache
// longer in their own modules (clones 30 min, nonces 10 min, swaps incremental, pool keys forever).
import "server-only";
import { buildFor, PLUMBING } from "@/lib/service";
import { client, loadEvents, ZERO } from "@/lib/chain";
import { explorerBudgetShare, topHolders } from "@/lib/holders";
import { BoundedTtlMap } from "@/lib/bounded";
import { earlyIndex, perIndex } from "@/lib/earlyIndex";
import { marketOf, poolSwapEth, quoteBuy, quoteSell, type MarketState } from "./market";
import { BLOCK_SEC, book, bundle, exitMath, IMPACT_SIZES, marketLegs, POOL_MANAGER, sortRaw, supplyOf, volume, walletTags, type HolderExtra, type Leg, type Quotes } from "./compute";
import { healthOf } from "./healthMemo";
import { clonesOf } from "./clones";
import { chipsFor } from "./chips";
import type { Analytics, ExitMath, Field, Market, Volume } from "./types";
import type { Address } from "viem";

const INDEX_MAX_AGE = 14 * 86_400;
// below the client's 45 s poll: a lone viewer's poll lands on an expired answer and gets a fresh build
// (raced against 2 s, see analyticsFor), not the build their previous poll started
const ANSWER_TTL = 30_000;
const SIDE_BUDGET_MS = 4_500; // holders / clones / nonces: what isn't back by then fills the cache for the next poll

const answers = new BoundedTtlMap<Analytics>(200);
const inflight = new Map<string, Promise<Analytics>>();

function labels(nowSec: number): { sniper: Set<string>; farm: Set<string> } | null {
  if (nowSec - earlyIndex().generatedAt > INDEX_MAX_AGE) return null; // too old to lean on: unknown
  // rebuilt only when the hourly index job writes a new index (lib/earlyIndex)
  return perIndex("engine.labels", (ix) => ({
    sniper: new Set(ix.snipers.map((w) => w.toLowerCase())),
    farm: new Set(ix.farms.flatMap((f) => f.wallets.map((w) => w.toLowerCase()))),
  }));
}

/** a section: short user-facing source ("chain", "chain + Blockscout", "vibe API") + the technical one for the tooltip */
type Src = readonly [source: string, detail: string];
const field = <T,>(data: T | null, src: Src, reason: string | null = null, at = Date.now()): Field<T> => ({ data, reason: data === null ? reason ?? "Unknown right now." : reason, source: src[0], detail: src[1], computedAt: at });

/** resolves with the promise, or with `fallback` after `ms` (the promise keeps running and fills its cache) */
function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/** like within(), but says WHY there is no value: the budget ran out (still running, fills its cache)
 *  or the call failed. A slow answer and a dead service get different words. */
type Settled<T> = { ok: true; v: T } | { ok: false; timedOut: boolean };
function settle<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    p.then((v) => { clearTimeout(t); resolve({ ok: true, v }); }, () => { clearTimeout(t); resolve({ ok: false, timedOut: false }); });
  });
}

/* ---------------- nonces (top holders): one eth_getTransactionCount each, 5 at a time, 10 min ---------------- */

const nonces = new BoundedTtlMap<number>(20_000);
async function nonceOf(wallets: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const todo: string[] = [];
  for (const w of wallets) {
    const n = nonces.get(w);
    if (n !== undefined) out.set(w, n);
    else todo.push(w);
  }
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async (w) => {
      try {
        const n = await client.getTransactionCount({ address: w as Address });
        nonces.set(w, n, 600_000);
        out.set(w, n);
      } catch { /* unknown, retried next time */ }
    }));
  }
  return out;
}

/* ---------------- window starts: the block of "now - 1h" / "now - 24h", measured (chain-wide, 60 s) ---------------- */

/* ---------------- seconds per block, measured: head vs head - 1M (1 h per process) ---------------- */

// 0.165 s/block was measured on 24.09; 01.10 the chain ran 0.1826 s over 100k blocks, so a fixed
// constant made "fresh < 24 h" cover ~26.6 h. Unknown (RPC down) = the constant, said nowhere as exact.
let spb: { v: number; at: number } | null = null;
let spbJob: Promise<number | null> | null = null;
async function secPerBlock(head: number): Promise<number | null> {
  if (spb && Date.now() - spb.at < 3_600_000) return spb.v;
  if (!spbJob) {
    spbJob = (async () => {
      try {
        const span = Math.min(1_000_000, head - 1);
        if (span < 10_000) return null;
        const [a, b] = await Promise.all([client.getBlock({ blockNumber: BigInt(head) }), client.getBlock({ blockNumber: BigInt(head - span) })]);
        const v = (Number(a.timestamp) - Number(b.timestamp)) / span;
        if (!(v > 0.05 && v < 2)) return null;
        spb = { v, at: Date.now() };
        return v;
      } catch {
        return spb?.v ?? null;
      } finally {
        spbJob = null;
      }
    })();
  }
  return spbJob;
}

const starts = new BoundedTtlMap<number>(8);
async function blockAt(targetSec: number, head: number, headTs: number): Promise<number> {
  // two secant steps from the measured s/block estimate land within a few blocks
  const sec = spb?.v ?? BLOCK_SEC;
  let b = Math.max(0, Math.round(head - (headTs - targetSec) / sec));
  for (let i = 0; i < 2; i++) {
    const blk = await client.getBlock({ blockNumber: BigInt(b) });
    const err = Number(blk.timestamp) - targetSec;
    if (Math.abs(err) <= 1) break;
    b = Math.max(0, Math.min(head, Math.round(b - err / sec)));
  }
  return b;
}
async function windowStarts(head: number): Promise<{ h1: number; d1: number } | null> {
  const k = `${Math.floor(head / 360)}`; // ~1 min of blocks
  const h1 = starts.get(`h1:${k}`);
  const d1 = starts.get(`d1:${k}`);
  if (h1 !== undefined && d1 !== undefined) return { h1, d1 };
  try {
    const top = await client.getBlock({ blockNumber: BigInt(head) });
    const ts = Number(top.timestamp);
    const [a, b] = await Promise.all([blockAt(ts - 3600, head, ts), blockAt(ts - 86_400, head, ts)]);
    starts.set(`h1:${k}`, a, 120_000);
    starts.set(`d1:${k}`, b, 120_000);
    return { h1: a, d1: b };
  } catch {
    return null; // fall back to the log's interpolated times
  }
}

/* ---------------- the answer ---------------- */

export class NotVibeError extends Error {}

const lastGood = new BoundedTtlMap<Analytics>(200); // served while a refresh runs (stale-while-revalidate)
const STALE_MAX = 5 * 60_000;
// An old answer goes out only when the refresh is slow: the refresh gets RACE_MS first. An old answer past
// STALE_SERVE_MAX is never served while a refresh may still land: the caller waits for it (a failed refresh
// still answers with the old one, up to STALE_MAX). Before, a lone viewer always saw the previous build.
const RACE_MS = 2_000;
const STALE_SERVE_MAX = 90_000;

export function analyticsFor(token: string): Promise<Analytics> {
  const t = token.toLowerCase();
  const hit = answers.get(t);
  if (hit) return Promise.resolve(hit);
  let job = inflight.get(t);
  if (!job) {
    job = build(t)
      .then((a) => {
        answers.set(t, a, ANSWER_TTL);
        lastGood.set(t, a, STALE_MAX);
        return a;
      })
      .finally(() => inflight.delete(t));
    inflight.set(t, job);
  }
  const old = lastGood.get(t);
  if (!old) return job;
  const orOld = job.catch(() => old);
  if (Date.now() - old.computedAt > STALE_SERVE_MAX) return orOld;
  return Promise.race([orOld, new Promise<Analytics>((resolve) => setTimeout(() => resolve(old), RACE_MS))]);
}

const marketWhy = (e: unknown) =>
  String((e as Error)?.message ?? e).includes("not an ETH pool") ? "Not an ETH pool: price math skipped." : "Curve / pool state unreadable right now.";

async function build(token: string): Promise<Analytics> {
  let built;
  try {
    built = await buildFor(token);
  } catch (e) {
    if (String((e as Error)?.message).includes("not a vibe token")) throw new NotVibeError("not a vibe token");
    throw e;
  }
  const meta = built.meta;
  if (built.unavailable || built.stale || !meta?.curve) throw new Error("chain unavailable");
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const cache = await loadEvents(token, meta);
  const head = Number(cache.lastBlock);
  const raw = sortRaw(cache.raw);
  const curve = meta.curve.toLowerCase();
  const creator = (meta.creator || "").toLowerCase();
  const plumbing = new Set<string>([ZERO, curve, ...PLUMBING]);
  const createdBlock = Number(meta.createdBlock);
  const startKnown = createdBlock > 0 && !meta.creationUnknown;
  const lb = labels(nowSec);

  // Every side lookup starts now and runs in parallel under ONE deadline (before: holders 4.5 s, then
  // nonces another 4.5 s, one after the other). What isn't back by then fills its cache for the next poll.
  const deadline = Date.now() + SIDE_BUDGET_MS;
  const left = () => Math.max(0, deadline - Date.now());
  // the analytics pass spends only the first half of this minute's explorer budget: token-hopping can't starve the Top holders card
  const holdersP = topHolders(token, { lookups: explorerBudgetShare() > 0.5 });
  const clonesP = clonesOf(token, meta.symbol, meta.name);
  const marketP = marketOf(token, curve).then((m) => ({ m, why: null as string | null }), (e) => ({ m: null, why: marketWhy(e) }));
  const sinceP = windowStarts(head);
  const spbP = secPerBlock(head);
  // awaited with the deadline below; a failure there is "unknown", never an unhandled rejection
  holdersP.catch(() => {});
  clonesP.catch(() => {});
  spbP.catch(() => {});

  // ---- legs: graduated tokens need the pool (market) first, for the pool's own Swap events ----
  let mkt = meta.graduated ? await marketP : null;
  let swapEth: Map<string, number> | null = null;
  let swapReason: string | null = null;
  if (meta.graduated) {
    const gradBlock = raw.find((r) => r.to === POOL_MANAGER || r.from === POOL_MANAGER)?.block;
    if (mkt?.m?.poolId && gradBlock !== undefined) {
      try {
        swapEth = await poolSwapEth(mkt.m.poolId, gradBlock, head);
      } catch {
        swapReason = "Pool swap log unreadable: pool trade sizes unknown.";
      }
    } else swapReason = "Pool unknown: pool trade sizes unknown.";
  }
  const legs: Leg[] = marketLegs(raw, curve, plumbing, swapEth);
  const bk = book(raw, legs, curve, plumbing);
  const supplyTotal = bk.minted > 0 ? bk.minted : 1_000_000_000;

  // the top-10 nonces need only the book: they start now, alongside holders / clones / market
  const people = [...bk.balance.entries()]
    .filter(([w, v]) => v > 0 && !plumbing.has(w) && w !== POOL_MANAGER && w !== curve)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);
  const nonceP = nonceOf(people);

  if (!mkt) mkt = await marketP;
  const market: MarketState | null = mkt.m;
  const marketReason = mkt.why;

  // ---- holders.ts clusters + funding blocks (shared cache with the Top holders card) ----
  const holdersS = await settle(holdersP, left());
  const holders = holdersS.ok ? holdersS.v : null;
  const holdersWhy = holdersS.ok ? null : holdersS.timedOut ? "Funding clusters still loading, next refresh." : "Funding clusters: explorer didn't answer.";
  const cluster = holders ? new Map<string, number>() : null;
  const fundedBlock = new Map<string, number>();
  const checked = new Set<string>();
  if (holders) {
    for (const r of holders.rows) {
      if (r.cluster !== null) cluster!.set(r.address, r.cluster);
      if (r.status === "ok") checked.add(r.address);
      if (r.funding?.kind === "source") fundedBlock.set(r.address, r.funding.block);
    }
  }

  // ---- 1. bundle ----
  const bundleData = legs.some((l) => l.side === "buy")
    ? bundle(legs, bk, creator, createdBlock, supplyTotal, cluster, checked, startKnown)
    : null;
  const bundleF = field(bundleData, ["chain + Blockscout", "Transfer logs, first 100 buys · funding clusters from Blockscout (top holders)"],
    bundleData ? (holders ? (holders.pending ? `Funding read for ${checked.size} of ${checked.size + holders.pending} top holders so far; the rest on the next refresh.` : null) : holdersWhy) : "No buys yet.", now);

  // ---- 2. exit math ----
  let exitF: Field<ExitMath>;
  const exitSrc: Src = ["chain", market?.venue === "pool" ? "Line replay · V4 pool slot0 / liquidity + V4 Quoter" : "Line replay · curve reserves + quoteBuy / quoteSell eth_call"];
  if (!market) {
    exitF = field<ExitMath>(null, exitSrc, marketReason, now);
  } else {
    const line = built.state.line;
    // first pass without quotes tells us the dump size; the buy quotes came with the market read (one batch),
    // the dump quote is the one extra call
    const pre = exitMath(line, bk, market, supplyTotal, null);
    const quotes: Quotes = { buy: [], dump: null };
    const [buys, dump] = await Promise.all([
      Promise.all(IMPACT_SIZES.map((e) => quoteBuy(market, e))),
      pre.profitTokensExact > 0 ? quoteSell(market, pre.profitTokensExact) : Promise.resolve(null),
    ]);
    quotes.buy = buys;
    quotes.dump = dump;
    const { profitTokensExact: _p, ...em } = exitMath(line, bk, market, supplyTotal, quotes);
    void _p;
    const reason = [
      em.estimatedCost ? `${em.estimatedCost} of ${em.inLine} cost bases are estimates (pool buys without a swap size).` : null,
      em.noCostHolders ? `${em.noCostHolders} bag${em.noCostHolders === 1 ? "" : "s"} came by transfer with no known cost: left out.` : null,
      swapReason,
    ].filter(Boolean).join(" ") || null;
    exitF = field(em, exitSrc, reason, now);
  }

  // ---- 3. volume ----
  // windows are cut by measured block numbers; the log's interpolated times are only the fallback
  const since = legs.length ? await sinceP : null;
  const tsMissing = !since && legs.some((l) => !l.ts);
  let volF: Field<Volume>;
  const volSrc: Src = ["chain", meta.graduated ? "Transfer logs + PoolManager Swap events" : "Transfer logs, exact curve replay"];
  if (!legs.length) volF = field<Volume>(null, volSrc, "No trades yet.", now);
  else {
    const v = volume(legs, nowSec, lb, since);
    v.labelsAsOf = lb ? earlyIndex().generatedAt : null;
    if (tsMissing) {
      // block times unknown: the time windows can't be cut honestly, only the whole history stays
      v.windows = v.windows.filter((w) => w.label === "all");
      v.topTradersWindow = "all";
    }
    const reasons = [
      tsMissing ? "Block times unknown: 1h / 24h hidden." : null,
      swapReason,
      lb ? null : "Bot labels too old: bot share unknown.",
    ].filter(Boolean).join(" ") || null;
    volF = field(v, volSrc, reasons, now);
  }

  // ---- 4. supply ----
  const [nonce, spbV] = await Promise.all([within(nonceP, left(), new Map<string, number>()), within(spbP, left(), null)]);
  const dev = creator && startKnown
    ? { sells: legs.filter((l) => l.wallet === creator && l.side === "sell").length, movedTo: bk.gaveTo.get(creator)?.size ?? 0 }
    : null;
  const extra: HolderExtra = { cluster, fundedBlock, checked, nonce, labels: lb, secPerBlock: spbV, dev };
  const sup = supplyOf(bk, curve, plumbing, creator, extra);
  const supReasons = [
    holders ? null : holdersS.ok ? null : holdersS.timedOut ? "Funding (fresh / cluster) still loading, next refresh." : "Funding (fresh / cluster): explorer didn't answer.",
    nonce.size < people.length ? "Some nonces unknown." : null,
  ].filter(Boolean).join(" ") || null;
  const supplyF = field(sup, ["chain + Blockscout", "Transfer log replay · nonces eth_getTransactionCount · first funding from Blockscout"], supReasons, now);

  // ---- 5. clones ----
  const clS = await settle(clonesP, left());
  const cl = clS.ok ? clS.v : null;
  const clonesF = field(cl, ["vibe API", "vibe/vibe search, exact ticker or name"], cl ? (cl.partial ? "Read the 200 newest matches: an older one may exist." : null) : clS.ok ? null : clS.timedOut ? "Search still loading, next refresh." : "vibe/vibe search didn't answer.", now);

  // ---- Line Health (one replay per token per 20 s, shared with /api/health) ----
  let health: Analytics["health"] = null;
  try {
    const h = healthOf({ token, creator, curve, raw, plumbing, complete: startKnown, headBlock: head, nowSec });
    health = { grade: h.grade, score: h.score, partial: h.partial, high: h.high, snipers: h.counts.snipers, farm: h.counts.farm, firstBuyers: h.counts.firstBuyers };
  } catch { /* the strip shows "—" */ }

  const supplyKnown = bk.minted > 0 ? bk.minted : null;
  const marketF: Field<Market> = market
    ? field<Market>(
      (({ reserves: _r, curve: _c, poolKey: _k, buyQuotes: _q, ...m }) => (void _r, void _c, void _k, void _q, { ...m, supply: supplyKnown, mcapEth: supplyKnown === null ? null : m.spotEth * supplyKnown }))(market),
      ["chain", market.venue === "curve" ? "curve reserves eth_call" : "V4 PoolManager extsload + V4 Quoter"], null, now)
    : field<Market>(null, ["chain", "curve / V4 pool eth_call"], marketReason, now);

  const out: Analytics = {
    token,
    symbol: meta.symbol,
    block: head,
    computedAt: now,
    graduated: meta.graduated,
    health,
    market: marketF,
    bundle: bundleF,
    exitMath: exitF,
    volume: volF,
    supply: supplyF,
    clones: clonesF,
    chips: [],
    tags: walletTags(legs, bk, creator, lb),
  };
  out.chips = chipsFor(out);
  return out;
}
