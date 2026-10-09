// Pure analytics over a token's own Transfer log. No network, no server-only imports: the engine feeds it,
// fixtures can too. Every number here is derived from chain data the engine passes in.
import { curveBuyCost } from "@/lib/queue";
import type { RawTransfer } from "@/lib/chain";
import type { QueueEntry } from "@/lib/queue";
import { FEE, breakEven, buyOut, feesOnlyPct, pctMove, sellOut, tokensForGross, type Reserves } from "./cpmm";
import type { Bucket, Bundle, BundleGroup, ExitMath, Impact, Supply, SupplyRow, TopTrader, Volume, VolWindow, WalletTag } from "./types";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const DEAD = "0x000000000000000000000000000000000000dead";
export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904";
/** fallback only: the engine measures s/block on the chain (engine.secPerBlock); 0.165-0.183 seen 24.09-01.10 */
export const BLOCK_SEC = 0.165;
export const MICRO_ETH = 0.0001;
const ROUND_TRIP_BLOCKS = 2;
const BUNDLE_SCAN = 100;

const whole = (v: bigint) => Number(v / 10n ** 12n) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

/* ---------------- market legs ---------------- */

export type Leg = {
  wallet: string;
  side: "buy" | "sell";
  tokens: number;
  /** ETH size: curve = exact replay (buy incl. fee, sell after fee); pool = the Swap event's ETH side; null = unknown */
  eth: number | null;
  venue: "curve" | "pool";
  block: number;
  logIndex: number;
  ts: number;
  tx: string;
};

export function sortRaw(raw: RawTransfer[]): RawTransfer[] {
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    if (a.block > b.block || (a.block === b.block && a.logIndex > b.logIndex)) {
      return [...raw].sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
    }
  }
  return raw;
}

/**
 * Buys and sells against the curve or the V4 pool, one leg per (tx, wallet, side).
 * `swapEth` maps tx hash -> ETH side of the pool swap (graduated tokens), from PoolManager Swap events.
 */
export function marketLegs(raw: RawTransfer[], curve: string, plumbing: Set<string>, swapEth: Map<string, number> | null): Leg[] {
  const c = curve.toLowerCase();
  let sold = 0n;
  const legs: Leg[] = [];
  const at = new Map<string, number>();
  const usedSwap = new Set<string>();
  for (const r of raw) {
    const before = sold;
    if (r.from === c && !plumbing.has(r.to)) sold += r.value;
    else if (r.to === c && !plumbing.has(r.from)) sold = sold > r.value ? sold - r.value : 0n;
    if (r.value <= 0n || !r.tx) continue;
    let side: "buy" | "sell" | null = null;
    let venue: "curve" | "pool" = "curve";
    let wallet = "";
    if (r.from === c && !plumbing.has(r.to)) { side = "buy"; wallet = r.to; }
    else if (r.to === c && !plumbing.has(r.from)) { side = "sell"; wallet = r.from; }
    else if (r.from === POOL_MANAGER && !plumbing.has(r.to)) { side = "buy"; venue = "pool"; wallet = r.to; }
    else if ((r.to === POOL_MANAGER || r.to === UNIVERSAL_ROUTER) && !plumbing.has(r.from)) { side = "sell"; venue = "pool"; wallet = r.from; }
    if (!side) continue;
    const tokens = whole(r.value);
    let eth: number | null;
    if (venue === "curve") {
      eth = side === "buy"
        ? curveBuyCost(whole(before), whole(sold)) / (1 - FEE)
        : curveBuyCost(whole(sold), whole(before)) * (1 - FEE);
    } else {
      const tx = r.tx.toLowerCase();
      // one swap per tx: the first leg of that tx takes its size, a second leg in the same tx can't be split honestly
      eth = swapEth && swapEth.has(tx) && !usedSwap.has(tx) ? swapEth.get(tx)! : null;
      if (eth !== null) usedSwap.add(tx);
    }
    const key = `${r.tx}:${wallet}:${side}`;
    const i = at.get(key);
    if (i !== undefined) {
      const l = legs[i];
      l.tokens += tokens;
      if (venue === "curve") l.eth = (l.eth ?? 0) + (eth ?? 0);
      else if (eth !== null) l.eth = (l.eth ?? 0) + eth;
      continue;
    }
    at.set(key, legs.length);
    legs.push({ wallet, side, tokens, eth, venue, block: r.block, logIndex: r.logIndex, ts: r.ts, tx: r.tx });
  }
  return legs;
}

/* ---------------- balances, cost basis, gifts ---------------- */

export type Book = {
  balance: Map<string, number>; // every address, plumbing included (whole tokens)
  boughtIn: Map<string, number>; // tokens in through a market buy
  giftIn: Map<string, number>; // tokens in from another wallet
  firstBuyBlock: Map<string, number>;
  /** average-cost basis of the current bag (ETH); gifts cost 0 */
  cost: Map<string, number>;
  /** the wallet bought in the pool and that buy's ETH is unknown (no swap log): its cost is an estimate */
  costUnknown: Set<string>;
  poolBuyer: Set<string>;
  gaveTo: Map<string, Set<string>>; // wallet -> wallets it handed tokens to (no market, no plumbing)
  gaveTokens: Map<string, number>;
  minted: number;
};

export function book(raw: RawTransfer[], legs: Leg[], curve: string, plumbing: Set<string>): Book {
  const c = curve.toLowerCase();
  const legEth = new Map<string, number | null>();
  for (const l of legs) if (l.side === "buy") legEth.set(`${l.tx}:${l.wallet}`, l.eth);
  const b: Book = {
    balance: new Map(), boughtIn: new Map(), giftIn: new Map(), firstBuyBlock: new Map(), cost: new Map(),
    costUnknown: new Set(), poolBuyer: new Set(), gaveTo: new Map(), gaveTokens: new Map(), minted: 0,
  };
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const seenBuyTx = new Set<string>();
  for (const r of raw) {
    const v = whole(r.value);
    if (!(v > 0)) continue;
    if (r.from === ZERO) b.minted += v;
    // sender: the bag shrinks, the cost basis shrinks with it (average cost); the part that left travels
    // with the tokens, so a bag split across wallets keeps its real cost instead of looking free
    let movedCost = 0;
    if (r.from !== ZERO) {
      const held = b.balance.get(r.from) ?? 0;
      const left = Math.max(0, held - v);
      b.balance.set(r.from, left);
      if (!plumbing.has(r.from) && r.from !== c) {
        const cost = b.cost.get(r.from) ?? 0;
        b.cost.set(r.from, held > 0 ? cost * (left / held) : 0);
        movedCost = held > 0 ? cost - cost * (left / held) : 0;
      }
    }
    add(b.balance, r.to, v);
    if (plumbing.has(r.to) || r.to === c || r.to === ZERO) continue;
    const market = r.from === c || r.from === POOL_MANAGER;
    if (market) {
      add(b.boughtIn, r.to, v);
      if (!b.firstBuyBlock.has(r.to)) b.firstBuyBlock.set(r.to, r.block);
      if (r.from === POOL_MANAGER) b.poolBuyer.add(r.to);
      // the leg carries the ETH of the whole (tx, wallet) buy: count it once
      const k = `${r.tx}:${r.to}`;
      if (!seenBuyTx.has(k)) {
        seenBuyTx.add(k);
        const eth = legEth.get(k);
        if (eth === null || eth === undefined) b.costUnknown.add(r.to);
        else add(b.cost, r.to, eth);
      }
    } else if (!plumbing.has(r.from) && r.from !== ZERO) {
      add(b.giftIn, r.to, v);
      if (movedCost > 0) add(b.cost, r.to, movedCost);
      if (b.costUnknown.has(r.from)) b.costUnknown.add(r.to);
      if (!b.gaveTo.has(r.from)) b.gaveTo.set(r.from, new Set());
      b.gaveTo.get(r.from)!.add(r.to);
      add(b.gaveTokens, r.from, v);
    }
  }
  return b;
}

/* ---------------- 1. bundle ---------------- */

/** push into a Map of arrays without copying (spreading made grouping quadratic per key) */
function group<K, V>(m: Map<K, V[]>, k: K, v: V) {
  let a = m.get(k);
  if (!a) m.set(k, (a = []));
  a.push(v);
}

/** a same-block group is only a signal with 3+ wallets or 0.5%+ of supply: 0.18 s blocks line up by chance */
const BLOCK_MIN_WALLETS = 3;
const BLOCK_MIN_PCT = 0.5;

export function bundle(legs: Leg[], bk: Book, creator: string, createdBlock: number, supply: number, cluster: Map<string, number> | null, checked: Set<string>, startKnown = true): Bundle {
  const allBuys = legs.filter((l) => l.side === "buy").slice(0, BUNDLE_SCAN);
  // dust buys (< 0.0001 ETH) bundle nothing: four dust wallets holding 0.01% made a "BUNDLE" chip
  const buys = allBuys.filter((l) => l.eth === null || l.eth >= MICRO_ETH);
  const byTx = new Map<string, Leg[]>();
  const byBlock = new Map<number, Leg[]>();
  for (const l of buys) {
    group(byTx, l.tx, l);
    group(byBlock, l.block, l);
  }
  const distinct = (ls: Leg[]) => new Set(ls.map((l) => l.wallet));
  const groups: BundleGroup[] = [];
  const inTxGroup = new Set<string>(); // tx hashes already reported as a same-tx group
  const pct = (tokens: number) => (supply > 0 ? (tokens / supply) * 100 : 0);
  const make = (kind: BundleGroup["kind"], ls: Leg[]): BundleGroup | null => {
    const ws = [...distinct(ls)];
    if (ws.length < 2) return null;
    const people = ws.filter((w) => w !== creator); // the dev's own launch buy is the dev bag, not a bundle share
    if (!people.length) return null;
    const bought = ls.filter((l) => l.wallet !== creator).reduce((s, l) => s + l.tokens, 0);
    const held = people.reduce((s, w) => s + (bk.balance.get(w) ?? 0), 0);
    const funders = cluster ? new Map<number, number>() : null;
    if (funders) for (const w of people) { const c = cluster!.get(w); if (c !== undefined) funders.set(c, (funders.get(c) ?? 0) + 1); }
    const sameFunder = funders ? [...funders.values()].filter((n) => n >= 2).reduce((s, n) => s + n, 0) : 0;
    return {
      kind,
      block: ls[0].block,
      txs: [...new Set(ls.map((l) => l.tx))],
      wallets: ws,
      boughtPct: r2(pct(bought)),
      heldPct: r2(pct(held)),
      sameFunder,
    };
  };
  for (const [tx, ls] of byTx) {
    const g = make("tx", ls);
    if (g) { groups.push(g); inTxGroup.add(tx); }
  }
  for (const [block, ls] of byBlock) {
    // a block whose buys all sit in one same-tx group is already reported
    const txs = new Set(ls.map((l) => l.tx));
    if (txs.size === 1 && inTxGroup.has(ls[0].tx)) continue;
    const kind = block === createdBlock ? "launch" : "block";
    const g = make(kind, ls);
    if (g && (kind === "launch" || g.wallets.length >= BLOCK_MIN_WALLETS || g.boughtPct >= BLOCK_MIN_PCT)) groups.push(g);
  }
  // the launch block on its own: anyone but the dev buying in the creation block
  const launchBuyers = new Set(buys.filter((l) => l.block === createdBlock && l.wallet !== creator).map((l) => l.wallet));
  // union of grouped wallets: the shares count each wallet / buy once
  const grouped = new Set<string>();
  const groupedTx = new Set<string>();
  for (const g of groups) for (const w of g.wallets) if (w !== creator) grouped.add(w);
  for (const g of groups) for (const t of g.txs) groupedTx.add(t);
  const groupedBlocks = new Set(groups.map((g) => g.block));
  let bought = 0;
  for (const l of buys) {
    if (l.wallet === creator || !grouped.has(l.wallet)) continue;
    if (groupedTx.has(l.tx) || groupedBlocks.has(l.block)) bought += l.tokens;
  }
  const held = [...grouped].reduce((s, w) => s + (bk.balance.get(w) ?? 0), 0);
  const rank = { tx: 0, launch: 1, block: 2 } as const;
  groups.sort((a, b) => rank[a.kind] - rank[b.kind] || b.heldPct - a.heldPct || b.boughtPct - a.boughtPct);
  const funderChecked = [...grouped].filter((w) => checked.has(w)).length;
  // the launch rush: distinct buyers (dev excluded) within 60 s of the first buy, whole history only
  const t0 = allBuys[0]?.ts ?? 0;
  const firstMinuteBuyers = startKnown && t0 > 0
    ? new Set(legs.filter((l) => l.side === "buy" && l.wallet !== creator && l.ts > 0 && l.ts - t0 <= 60).map((l) => l.wallet)).size
    : null;
  return {
    scanned: allBuys.length,
    buyers: distinct(allBuys).size,
    boughtPct: r2(pct(bought)),
    heldPct: r2(pct(held)),
    wallets: grouped.size,
    launchBlockBuyers: launchBuyers.size,
    firstMinuteBuyers,
    groups: groups.slice(0, 40),
    sameFunderWallets: cluster ? [...grouped].filter((w) => cluster.has(w)).length : null,
    funderChecked,
  };
}

/* ---------------- 2. exit math ---------------- */

const BUCKETS: { id: Bucket["id"]; label: string; lo: number; hi: number }[] = [
  { id: "loss", label: "<1x", lo: 0, hi: 1 },
  { id: "x1", label: "1–2x", lo: 1, hi: 2 },
  { id: "x2", label: "2–3x", lo: 2, hi: 3 },
  { id: "x3", label: "3x+", lo: 3, hi: Infinity },
];

export type Quotes = {
  /** contract quotes: tokens out for each impact size (null = failed) */
  buy: (number | null)[];
  /** contract quote: ETH out for selling every bag in profit (null = failed / skipped) */
  dump: number | null;
};

export const IMPACT_SIZES = [0.1, 0.5, 1];
const BREAK_EVEN_SIZE = 0.1;

export function exitMath(
  line: QueueEntry[],
  bk: Book,
  m: { venue: "curve" | "pool"; spotEth: number; reserves: Reserves; realEthReserve: number | null; tokensLeft: number | null },
  supply: number,
  quotes: Quotes | null,
): ExitMath & { profitTokensExact: number } {
  const spot = m.spotEth;
  const buckets = BUCKETS.map((b) => ({ id: b.id, label: b.label, holders: 0, tokens: 0, supplyPct: 0, linePct: 0 }));
  let lineTokens = 0;
  let exact = 0;
  let estimated = 0;
  let profitHolders = 0;
  let profitTokens = 0;
  let noCostHolders = 0;
  let noCostTokens = 0;
  for (const e of line) {
    const tokens = whole(e.balance);
    if (!(tokens > 0)) continue;
    // our own replay (exact curve cost, exact pool swap ETH) first; the queue's estimate when a pool buy's ETH is unknown
    const own = bk.cost.get(e.wallet);
    const useOwn = own !== undefined && !bk.costUnknown.has(e.wallet);
    const cost = useOwn ? own : e.positionCostEth;
    // a bag with no buy cost behind it (came by transfer from a wallet we can't price): cost unknown,
    // never "infinitely in profit" (that put sybil splits in 3x+ and in the dump)
    if (!(cost > 0)) {
      noCostHolders++;
      noCostTokens += tokens;
      continue;
    }
    lineTokens += tokens;
    if (useOwn) exact++;
    else estimated++;
    const value = tokens * spot;
    const mult = value / cost;
    const b = BUCKETS.findIndex((x) => mult >= x.lo && mult < x.hi);
    const k = buckets[b < 0 ? 3 : b];
    k.holders++;
    k.tokens += tokens;
    if (mult * (1 - FEE) > 1) {
      profitHolders++;
      profitTokens += tokens;
    }
  }
  for (const b of buckets) {
    b.supplyPct = r2(supply > 0 ? (b.tokens / supply) * 100 : 0);
    b.linePct = r2(lineTokens > 0 ? (b.tokens / lineTokens) * 100 : 0);
    b.tokens = Math.round(b.tokens);
  }

  // everyone in profit sells now, one after another: the curve / pool walks down the same x*y=k
  let dumpPricePct: number | null = null;
  let dumpEthOut: number | null = null;
  let dumpNote: string | null = null;
  if (profitTokens > 0) {
    const s = sellOut(m.reserves, profitTokens);
    dumpPricePct = r2(pctMove(m.reserves, s.after));
    dumpEthOut = quotes?.dump ?? s.net;
    if (m.venue === "curve" && m.realEthReserve !== null && s.gross > m.realEthReserve + 1e-9) {
      dumpNote = `The curve holds ${m.realEthReserve.toFixed(3)} ETH: it can't pay out more.`;
      dumpEthOut = m.realEthReserve * (1 - FEE);
    }
  } else {
    dumpPricePct = 0;
    dumpEthOut = 0;
    dumpNote = "Nobody in line is in profit after fees.";
  }

  const be = breakEven(m.reserves, BREAK_EVEN_SIZE);
  const impact: Impact[] = IMPACT_SIZES.map((eth, i) => {
    const model = buyOut(m.reserves, eth);
    const q = quotes?.buy[i] ?? null;
    let buyTokens: number | null = q ?? model.tokens;
    let note: string | null = null;
    let buyPriceAfterPct: number | null = r2(pctMove(m.reserves, model.after));
    if (m.venue === "curve" && m.tokensLeft !== null && model.tokens > m.tokensLeft) {
      buyTokens = null;
      buyPriceAfterPct = null;
      note = "Fills the curve: the rest graduates.";
    }
    const buyImpactPct = buyTokens ? r2(((eth / buyTokens) / m.spotEth - 1) * 100) : null;
    let sellTokens = tokensForGross(m.reserves, eth);
    let sellPriceAfterPct: number | null = sellTokens === null ? null : r2(pctMove(m.reserves, sellOut(m.reserves, sellTokens).after));
    if (m.venue === "curve" && m.realEthReserve !== null && eth > m.realEthReserve) {
      sellTokens = null;
      sellPriceAfterPct = null;
      note = note ?? `Curve holds ${m.realEthReserve.toFixed(3)} ETH.`;
    }
    return {
      eth,
      buyTokens: buyTokens === null ? null : Math.round(buyTokens),
      buyImpactPct,
      buyPriceAfterPct,
      sellTokens: sellTokens === null ? null : Math.round(sellTokens),
      sellPriceAfterPct,
      note,
      quoted: q !== null,
    };
  });

  // the biggest sell that keeps spot within -10%: (t / (t + dx))^2 = 0.9 on x*y=k
  let maxSell10: ExitMath["maxSell10"] = null;
  if (m.reserves.t > 0 && m.reserves.e > 0) {
    const dx = m.reserves.t * (1 / Math.sqrt(0.9) - 1);
    const s = sellOut(m.reserves, dx);
    let eth = s.net;
    let capped = false;
    if (m.venue === "curve" && m.realEthReserve !== null && s.gross > m.realEthReserve) {
      eth = m.realEthReserve * (1 - FEE);
      capped = true;
    }
    maxSell10 = { tokens: Math.round(dx), eth: r4(eth), capped };
  }

  return {
    spotEth: spot,
    venue: m.venue,
    inLine: line.length,
    exactCost: exact,
    estimatedCost: estimated,
    buckets,
    noCostHolders,
    noCostTokens: Math.round(noCostTokens),
    profitHolders,
    profitTokens: Math.round(profitTokens),
    profitTokensExact: profitTokens,
    profitSupplyPct: r2(supply > 0 ? (profitTokens / supply) * 100 : 0),
    dumpPricePct,
    dumpEthOut: dumpEthOut === null ? null : r4(dumpEthOut),
    dumpNote,
    breakEvenPct: r2(be.risePct),
    breakEvenEth: r4(be.othersEth),
    breakEvenSize: BREAK_EVEN_SIZE,
    feesOnlyPct: r2(feesOnlyPct()),
    impact,
    maxSell10,
  };
}

/* ---------------- 3. volume ---------------- */

/**
 * `since` = first block of each window ("1h", "24h"), measured on the chain (engine.windowStart);
 * without it the windows fall back to the interpolated log timestamps.
 */
export function volume(legs: Leg[], nowSec: number, labels: { sniper: Set<string>; farm: Set<string> } | null, since?: { h1: number; d1: number } | null): Volume {
  // wash, part 2: one wallet in and out (either order) within 2 blocks
  const wash = new Set<Leg>();
  const byWallet = new Map<string, Leg[]>();
  for (const l of legs) group(byWallet, l.wallet, l);
  const roundTrip = new Set<Leg>();
  for (const ls of byWallet.values()) {
    for (let i = 0; i < ls.length; i++) {
      for (let j = i + 1; j < ls.length && ls[j].block - ls[i].block <= ROUND_TRIP_BLOCKS; j++) {
        if (ls[j].side !== ls[i].side) { roundTrip.add(ls[i]); roundTrip.add(ls[j]); }
      }
    }
  }
  for (const l of legs) if (roundTrip.has(l) || (l.eth !== null && l.eth < MICRO_ETH)) wash.add(l);

  const windows: VolWindow[] = ([["1h", 3600], ["24h", 86_400], ["all", Infinity]] as const).map(([label, sec]) => {
    const from = since ? (label === "1h" ? since.h1 : label === "24h" ? since.d1 : 0) : null;
    const ls = from !== null ? legs.filter((l) => l.block >= from) : legs.filter((l) => nowSec - l.ts <= sec);
    let volumeEth = 0, washEth = 0, botEth = 0, micro = 0, unknown = 0;
    let buys = 0, sells = 0, trips = 0;
    const buyers = new Set<string>();
    for (const l of ls) {
      if (l.side === "buy") { buys++; buyers.add(l.wallet); } else sells++;
      if (l.eth === null) { unknown++; continue; }
      volumeEth += l.eth;
      if (wash.has(l)) washEth += l.eth;
      if (l.eth < MICRO_ETH) micro++;
      if (roundTrip.has(l)) trips++;
      // a bot's dust or round trip is already wash: counted there once, never twice
      if (!wash.has(l) && labels && (labels.sniper.has(l.wallet) || labels.farm.has(l.wallet))) botEth += l.eth;
    }
    return {
      label,
      trades: ls.length,
      volumeEth: r4(volumeEth),
      realEth: r4(Math.max(0, volumeEth - washEth - botEth)),
      washEth: r4(washEth),
      microTrades: micro,
      roundTrips: Math.round(trips / 2),
      buys,
      sells,
      buyers: buyers.size,
      buysPerBuyer: buyers.size ? r2(buys / buyers.size) : null,
      botEth: labels ? r4(botEth) : null,
      unknownTrades: unknown,
    };
  });

  // who makes the volume: last 24 h, else the whole history
  const day = legs.filter((l) => (since ? l.block >= since.d1 : nowSec - l.ts <= 86_400) && l.eth !== null);
  const topTradersWindow: Volume["topTradersWindow"] = day.length ? "24h" : "all";
  const pool = day.length ? day : legs.filter((l) => l.eth !== null);
  const total = pool.reduce((s, l) => s + (l.eth ?? 0), 0);
  const per = new Map<string, { eth: number; trades: number }>();
  for (const l of pool) {
    const p = per.get(l.wallet) ?? { eth: 0, trades: 0 };
    p.eth += l.eth ?? 0;
    p.trades++;
    per.set(l.wallet, p);
  }
  const topTraders: TopTrader[] = [...per.entries()]
    .sort((a, b) => b[1].eth - a[1].eth)
    .slice(0, 8)
    .map(([wallet, p]) => ({
      wallet,
      eth: r4(p.eth),
      sharePct: r2(total > 0 ? (p.eth / total) * 100 : 0),
      trades: p.trades,
      tag: labels?.sniper.has(wallet) ? "sniper" : labels?.farm.has(wallet) ? "farm" : null,
    }));
  const venues = new Set(legs.map((l) => l.venue));
  return { venue: venues.size === 2 ? "both" : venues.has("pool") ? "pool" : "curve", windows, topTraders, topTradersWindow, labelsAsOf: null };
}

/* ---------------- 4. supply ---------------- */

export type HolderExtra = {
  cluster: Map<string, number> | null;
  /** first ETH funding block per wallet (holders.ts); missing = unknown */
  fundedBlock: Map<string, number>;
  /** wallets holders.ts looked up (funding known, any kind) */
  checked: Set<string>;
  nonce: Map<string, number>;
  labels: { sniper: Set<string>; farm: Set<string> } | null;
  /** measured seconds per block (engine.secPerBlock); null = the BLOCK_SEC fallback */
  secPerBlock: number | null;
  /** the creator's record (whole history); null = creator or start of history unknown */
  dev: { sells: number; movedTo: number } | null;
};

export function supplyOf(bk: Book, curve: string, plumbing: Set<string>, creator: string, x: HolderExtra): Supply {
  const c = curve.toLowerCase();
  const total = bk.minted > 0 ? bk.minted : 1_000_000_000;
  const people: [string, number][] = [];
  let market = 0;
  for (const [w, v] of bk.balance) {
    if (!(v > 0)) continue;
    if (w === c || w === POOL_MANAGER) { market += v; continue; }
    if (plumbing.has(w) || w === ZERO || w === DEAD) continue;
    people.push([w, v]);
  }
  people.sort((a, b) => b[1] - a[1]);
  const held = people.reduce((s, [, v]) => s + v, 0);
  const pct = (v: number) => r2((v / total) * 100);
  const giftShare = (w: string) => {
    const g = bk.giftIn.get(w) ?? 0;
    const b = bk.boughtIn.get(w) ?? 0;
    return g + b > 0 ? g / (g + b) : 0;
  };
  const top = people.slice(0, 10);
  // "fresh" = funded < 24 h before the first buy; the window in blocks follows the measured block time
  const FRESH_BLOCKS = Math.round(86_400 / (x.secPerBlock ?? BLOCK_SEC));
  const top10: SupplyRow[] = top.map(([w, v]) => {
    const fb = x.fundedBlock.get(w);
    const buy = bk.firstBuyBlock.get(w);
    // fresh = first ETH (from a wallet / contract, holders.ts) arrived < 24 h before the first buy.
    // Faucet / bridge funding carries no block, a gifted wallet has no buy: both stay unknown, never "not fresh".
    const fresh = fb !== undefined && buy !== undefined ? buy - fb >= 0 && buy - fb < FRESH_BLOCKS : null;
    const nonce = x.nonce.has(w) ? x.nonce.get(w)! : null;
    const cl = x.cluster?.get(w) ?? null;
    const gp = giftShare(w);
    const flags: SupplyRow["flags"] = [];
    if (w === creator) flags.push("creator");
    if (gp >= 0.5) flags.push("gifted");
    if (fresh) flags.push("fresh");
    if (cl !== null) flags.push("cluster");
    if (nonce !== null && nonce <= 2) flags.push("lownonce");
    if (x.labels?.sniper.has(w)) flags.push("sniper");
    else if (x.labels?.farm.has(w)) flags.push("farm");
    return { wallet: w, pct: pct(v), giftedPct: Math.round(gp * 100), nonce, fresh, cluster: cl, flags };
  });
  const top10Tokens = top.reduce((s, [, v]) => s + v, 0);
  let giftedHolders = 0;
  let giftedTokens = 0;
  for (const [w, v] of people) {
    const gp = giftShare(w);
    if (gp >= 0.999) giftedHolders++;
    giftedTokens += v * gp;
  }
  const gifters = [...bk.gaveTo.entries()]
    .filter(([, to]) => to.size >= 3)
    .map(([w, to]) => ({ wallet: w, to: to.size, pct: pct(bk.gaveTokens.get(w) ?? 0), isCreator: w === creator }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 6);
  const freshKnown = top10.filter((r) => r.fresh !== null);
  const nonceKnown = top10.filter((r) => r.nonce !== null);
  return {
    circulatingPct: pct(held),
    marketPct: pct(market),
    holders: people.length,
    top10Pct: pct(top10Tokens),
    top10OfCirculatingPct: r2(held > 0 ? (top10Tokens / held) * 100 : 0),
    top10,
    giftedHolders,
    giftedPct: Math.round((giftedTokens / total) * 100_000) / 1000,
    gifters,
    freshTop10: freshKnown.length ? freshKnown.filter((r) => r.fresh).length : null,
    freshChecked: freshKnown.length,
    lowNonceTop10: nonceKnown.length ? nonceKnown.filter((r) => r.nonce! <= 2).length : null,
    lowNonceChecked: nonceKnown.length,
    creatorPct: creator ? pct(bk.balance.get(creator) ?? 0) : null,
    devSells: x.dev ? x.dev.sells : null,
    devMovedTo: x.dev ? x.dev.movedTo : null,
  };
}

/* ---------------- 5. wallet tags (tape, ticket) ---------------- */

/**
 * One tag per wallet for the latest `recent` trades plus the creator: dev > sniper > farm > gifted
 * (most of the bag came by transfer, not a buy). Free: the same labels the line already shows elsewhere.
 */
export function walletTags(legs: Leg[], bk: Book, creator: string, labels: { sniper: Set<string>; farm: Set<string> } | null, recent = 400): Record<string, WalletTag> {
  const out: Record<string, WalletTag> = {};
  const ws = new Set<string>();
  for (let i = Math.max(0, legs.length - recent); i < legs.length; i++) ws.add(legs[i].wallet);
  if (creator) ws.add(creator);
  for (const w of ws) {
    if (creator && w === creator) { out[w] = "dev"; continue; }
    if (labels?.sniper.has(w)) { out[w] = "sniper"; continue; }
    if (labels?.farm.has(w)) { out[w] = "farm"; continue; }
    const g = bk.giftIn.get(w) ?? 0;
    const b = bk.boughtIn.get(w) ?? 0;
    if (g > 0 && g >= b) out[w] = "gifted";
  }
  return out;
}
