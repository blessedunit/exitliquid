// Builds API responses from chain data, falling back to labelled mock data.
import "server-only";
import { ACTIVE_TOKEN, EXIT_CREATOR, IS_LIVE } from "./config";
import { buildQueue, curveBuyCost, curvePrice, groupFor, tierFor, type BalanceEvent, type QueueState } from "./queue";
import { fetchLaunch, isVibeLaunch, loadEvents, toBalanceEvents, ZERO, type LaunchMeta, type RawTransfer } from "./chain";
import { mockEvents } from "./mock";
import type { Mode, QueueResponse, WireEntry, WireExit, WireFeed, WireTrade } from "./types";
import type { Hex } from "viem";
import { client } from "./chain";
import { BoundedTtlMap } from "./bounded";

// vibe/vibe protocol contracts that move tokens but are never people.
export const PLUMBING = [
  "0x40f1be6faf8dab9c143cce1a0a04c2075fb2df59", // factory
  "0xa6a5d4c098da8f79eae1203a8e42ff9ac7a17f06", // graduation adapter
  "0x2779651fee12f6fb5a187578de6b63709f85d0cc", // fee hook
  "0xc0a2deebdc40b7083dc9a067f6992f884fb6074d", // liquidity locker
  "0x91719a47f855079678b3d5e3af69cde2b830c5c9", // protocol treasury
  "0x8366a39cc670b4001a1121b8f6a443a643e40951", // v4 pool manager
  "0x8876789976decbfcbbbe364623c63652db8c0904", // universal router
  "0x000000000022d473030f116ddee9f6b43ac78ba3", // permit2
  "0x000000000000000000000000000000000000dead",
  "0x0d0c44bfeb2a60f9b81c221c4cd24ca89acbacec", // legacy liquidity locker
  "0x1ed9e88ae14713ca4bc964bade2bc1e3f5cd501a", // legacy graduation adapter
  "0xc5b22f31f247a6ee33592792d44bde31c0ef10cc", // legacy fee hook
];

export type Built = {
  mode: Mode;
  token: string;
  meta: LaunchMeta | null;
  state: QueueState;
  trades: WireTrade[];
  block: number;
  note?: string;
  unavailable?: boolean; // chain unreachable: numbers are unknown, not zero
  stale?: boolean; // served from the last good snapshot after a failed refresh: never cache it downstream
};

const wholeTokens = (v: bigint) => Number(v / 10n ** 12n) / 1e6;

/**
 * User-facing market legs are the trade tape. Before graduation this is the
 * bonding curve; afterwards swaps travel through PoolManager / router / Permit2.
 */
const TRADE_FEE = 0.0125; // vibe/vibe fee on every curve buy and sell

function tradeFlow(raw: RawTransfer[], curve: string, plumbing: Set<string>): WireTrade[] {
  const c = curve.toLowerCase();
  let sold = 0n;
  const trades: WireTrade[] = [];
  for (const r of [...raw].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    const before = sold;
    const fromMarket = plumbing.has(r.from);
    const toMarket = plumbing.has(r.to);

    // Keep the curve price estimate pinned to real curve trades. The one-off
    // curve-to-pool migration must not look like hundreds of millions sold.
    if (r.from === c && !toMarket) {
      sold += r.value;
    } else if (r.to === c && !fromMarket) {
      sold = sold > r.value ? sold - r.value : 0n;
    }

    const side: WireTrade["side"] | null = fromMarket && !toMarket ? "buy" : !fromMarket && toMarket ? "sell" : null;
    if (!side || r.from === ZERO) continue;
    const tokens = wholeTokens(r.value);
    // Ignore the one-off curve-to-pool migration; the chart is for user trades.
    if (!Number.isFinite(tokens) || tokens <= 0 || tokens > 50_000_000) continue;
    const item: WireTrade = {
      side,
      wallet: side === "buy" ? r.to : r.from,
      tokens,
      priceEth: curvePrice(wholeTokens(sold)),
      // The tape is about the trade at that moment, never today's bag value.
      // Curve reserve integral is the historical ETH input before fees; pool
      // trades get their actual transaction value below when available.
      // curve trades are exact for the whole history: a buy = curve cost + the 1.25% fee the buyer paid,
      // a sell = curve proceeds minus the fee. Pool trades (after graduation) get their tx value below.
      buyCostEth: side === "buy" && r.from === c
        ? curveBuyCost(wholeTokens(before), wholeTokens(sold)) / (1 - TRADE_FEE)
        : null,
      sellValueEth: side === "sell"
        ? r.to === c
          ? curveBuyCost(wholeTokens(sold), wholeTokens(before)) * (1 - TRADE_FEE)
          : null
        : null,
      ts: r.ts,
      tx: r.tx,
    };
    const prev = trades[trades.length - 1];
    if (prev && prev.tx && prev.tx === item.tx && prev.side === item.side) {
      prev.tokens += item.tokens;
      prev.priceEth = item.priceEth;
      if (item.buyCostEth !== null && item.buyCostEth !== undefined) prev.buyCostEth = (prev.buyCostEth ?? 0) + item.buyCostEth;
      if (item.sellValueEth !== null && item.sellValueEth !== undefined) prev.sellValueEth = (prev.sellValueEth ?? 0) + item.sellValueEth;
      prev.ts = item.ts;
    } else {
      trades.push(item);
    }
  }
  // the whole history stays in memory (small objects); responses send the newest 300, older pages via /api/trades
  return trades;
}

const buyTxValues = new Map<string, number>();
async function addActualBuyCosts(trades: WireTrade[]): Promise<void> {
  // only pool buys (no curve cost) need the tx value; curve buys are already exact
  const todo = trades.slice(-48).reverse().filter((t) => t.side === "buy" && t.tx && (t.buyCostEth === null || t.buyCostEth === undefined));
  let next = 0;
  const worker = async () => {
    for (let t = todo[next++]; t; t = todo[next++]) {
      const hash = t.tx!;
      let value = buyTxValues.get(hash);
      if (value === undefined) {
        try {
          const tx = await client.getTransaction({ hash: hash as Hex });
          value = Number(tx.value) / 1e18;
          buyTxValues.set(hash, value);
        } catch { continue; }
      }
      if (value > 0) {
        t.buyCostEth = value;
        t.buyCostExact = true;
      }
    }
  };
  await Promise.race([Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker)), new Promise<void>((resolve) => setTimeout(resolve, 2500))]);
  if (buyTxValues.size > 1000) buyTxValues.clear();
}

function addSaleEstimates(trades: WireTrade[]): void {
  // After graduation the old bonding-curve price is no longer a market price.
  // A nearby observed buy gives a more honest estimate than that stale curve;
  // without one, leave the ETH amount unknown rather than fabricate proceeds.
  let latestObservedEthPerToken: number | null = null;
  for (const trade of trades) {
    if (trade.side === "buy" && trade.buyCostExact && trade.buyCostEth && trade.tokens > 0) {
      latestObservedEthPerToken = trade.buyCostEth / trade.tokens;
    } else if (trade.side === "sell" && trade.sellValueEth == null && latestObservedEthPerToken !== null) {
      trade.sellValueEth = trade.tokens * latestObservedEthPerToken;
      trade.estimated = true;
    }
  }
}

function mockTradeFlow(events: BalanceEvent[]): WireTrade[] {
  return events.slice(-300).map((e, i) => ({
    side: e.delta >= 0n ? "buy" : "sell",
    wallet: e.wallet,
    tokens: wholeTokens(e.delta >= 0n ? e.delta : -e.delta),
    priceEth: curvePrice(i * 1_500_000),
    buyCostEth: e.delta >= 0n ? wholeTokens(e.delta) * curvePrice(i * 1_500_000) : null,
    sellValueEth: e.delta < 0n ? wholeTokens(-e.delta) * curvePrice(i * 1_500_000) : null,
    ts: e.ts,
    tx: e.tx,
  }));
}

let lastGood: Built | null = null;
let lastGoodAt = 0;
// an older snapshot is no longer "the line a moment ago": answer unknown instead
const SNAPSHOT_MAX_AGE = 5 * 60_000;
let memo: { at: number; value: Built } | null = null;
let building: Promise<Built> | null = null;
let failedAt = 0;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function buildFresh(): Promise<Built> {
  const meta = await fetchLaunch(ACTIVE_TOKEN);
  // without the curve address we can't tell the curve from people: refuse to guess
  if (!meta?.curve) throw new Error("no launch meta");
  const cache = await loadEvents(ACTIVE_TOKEN, meta);
  const plumbing = new Set<string>([ZERO, meta.curve, ...PLUMBING]);
  // the factory's launch event is the source of truth; env is only a fallback
  const creator = meta.creator || (IS_LIVE ? EXIT_CREATOR : "") || "";
  const trades = tradeFlow(cache.raw, meta.curve, plumbing);
  await addActualBuyCosts(trades);
  addSaleEstimates(trades);
  // place/points use the deterministic curve cost from toBalanceEvents; the real tx.value (recent buys only,
  // best effort) is for the trade tape, never for the rules, so every server instance builds the same line
  const events = toBalanceEvents(cache.raw, plumbing, meta.curve);
  const state = buildQueue(events, { creator, priceEth: curvePrice(meta.tokensSold) });
  return {
    mode: IS_LIVE ? "live" : "demo",
    token: ACTIVE_TOKEN,
    meta: { ...meta, creator },
    state,
    trades,
    block: Number(cache.lastBlock),
  };
}

/** The last good snapshot, labelled with its age; null once it's too old to show. */
function snapshot(): Built | null {
  const age = Date.now() - lastGoodAt;
  if (!lastGood || age > SNAPSHOT_MAX_AGE) return null;
  const min = Math.max(1, Math.round(age / 60_000));
  const note = `${lastGood.note ? lastGood.note + " " : ""}Chain is slow: showing a snapshot from ${min} min ago`;
  return { ...lastGood, note, stale: true };
}

function unavailableState(): Built {
  return {
    mode: IS_LIVE ? "live" : "demo",
    token: ACTIVE_TOKEN,
    meta: null,
    state: { line: [], exits: [], feed: [], totals: { inLine: 0, exited: 0, everJoined: 0, lpIssued: 0 } },
    trades: [],
    block: 0,
    note: "The chain isn't answering. Retrying.",
    unavailable: true,
  };
}

// One shared build per ~4s; slow or failing chain falls back to the last good snapshot (at most 5 min old).
export async function buildState(): Promise<Built> {
  if (memo && Date.now() - memo.at < 4_000) return memo.value;
  if (ACTIVE_TOKEN) {
    // right after a failure, answer instantly from the last snapshot instead of waiting again
    if (failedAt && Date.now() - failedAt < 20_000 && lastGood) {
      return snapshot() ?? unavailableState();
    }
    try {
      building ??= withTimeout(buildFresh(), lastGood ? 8_000 : 25_000).finally(() => {
        building = null;
      });
      const built = await building;
      lastGood = built;
      lastGoodAt = Date.now();
      memo = { at: Date.now(), value: built };
      failedAt = 0;
      return built;
    } catch (e) {
      failedAt = Date.now();
      // log every failed refresh (at most one per 20 s window), not only the cold-start ones
      console.error("chain read failed", lastGood ? "(serving last good snapshot)" : "", String((e as Error)?.message ?? e).slice(0, 300));
      return snapshot() ?? unavailableState();
    }
  }
  const { events, creator } = mockEvents();
  return {
    mode: "mock",
    token: "",
    meta: null,
    state: buildQueue(events, { creator, priceEth: curvePrice(0.37 * 793_100_000) }),
    trades: mockTradeFlow(events),
    block: 0,
  };
}

export function wireEntry(e: QueueState["line"][number]): WireEntry {
  return {
    wallet: e.wallet,
    place: e.place,
    balance: e.balance.toString(),
    lp: e.lp,
    skin: e.skin,
    tier: e.tier,
    behind: e.behind,
    ahead: e.ahead,
    isCreator: e.isCreator,
    enteredTs: e.enteredTs,
    entryTokens: wholeTokens(e.entryTokens),
    entryValueEth: wholeTokens(e.entryTokens) * e.entryPriceEth,
    positionCostEth: e.positionCostEth,
    entries: e.entries,
  };
}

export function wireExit(x: QueueState["exits"][number]): WireExit {
  return {
    wallet: x.wallet,
    exitedAtPlace: x.exitedAtPlace,
    lpReleased: Math.round(x.lpReleased * 100) / 100,
    exitedTs: x.exitedTs,
    behindAtExit: x.behindAtExit,
    tx: x.tx,
  };
}

export function toQueueResponse(b: Built, limit = 200, ethUsd: number | null = null): QueueResponse {
  const m = b.meta;
  // graduated tokens: price = median ETH/token of the last (up to 7) real pool buys within 6 h,
  // so one odd trade can't swing everyone's PnL; none recent = unknown, never a stale guess
  const recentBuys = [...b.trades].reverse()
    .filter((t) => t.side === "buy" && t.buyCostExact && t.buyCostEth && t.tokens > 0 && t.ts > Date.now() / 1000 - 6 * 3600)
    .slice(0, 7);
  const latestExactBuy = recentBuys[0];
  const perToken = recentBuys.map((t) => t.buyCostEth! / t.tokens).sort((x, y) => x - y);
  const recentPoolMark = perToken.length ? perToken[Math.floor(perToken.length / 2)] : null;
  const markPriceEth = m?.graduated ? recentPoolMark : m ? curvePrice(m.tokensSold) : b.mode === "mock" ? curvePrice(0.37 * 793_100_000) : null;
  // walk-ins (in and out within the hour) stay out of the Hall and the feed
  const feed: WireFeed[] = b.state.feed
    .filter((f) => !(f.kind === "exit" && f.quick))
    .map((f) => {
      const { block: _b, ...rest } = f as typeof f & { quick?: boolean };
      void _b;
      delete (rest as { quick?: boolean }).quick;
      return rest as WireFeed;
    });
  return {
    mode: b.mode,
    token: b.token,
    // $EXIT keeps its brand name; any other vibe token shows its own name and ticker
    name: b.token && b.token !== ACTIVE_TOKEN ? m?.name || "Unknown token" : b.mode === "live" ? "Exit Liquidity" : m?.name || "Exit Liquidity",
    symbol: b.token && b.token !== ACTIVE_TOKEN ? m?.symbol || "???" : b.mode === "live" ? "EXIT" : m?.symbol || "EXIT",
    creator: m?.creator || "",
    updatedAt: Date.now(),
    block: b.block,
    ethUsd,
    markPriceEth: !b.stale && Number.isFinite(markPriceEth) && markPriceEth! > 0 ? markPriceEth : null,
    markPriceTs: b.stale ? null : m?.graduated ? recentPoolMark !== null ? latestExactBuy?.ts ?? null : null : m ? Math.floor(Date.now() / 1000) : null,
    curve: {
      progressBps: m?.progressBps ?? (b.mode === "mock" ? 3700 : 0),
      raisedEth: m?.raisedEth ?? 0,
      targetEth: m?.targetEth ?? 5,
      graduated: m?.graduated ?? false,
    },
    // walk-ins are hidden from the Hall, so they are not counted as exits either
    totals: { ...b.state.totals, exited: b.state.exits.filter((x) => !x.quick).length },
    line: b.state.line.slice(0, limit).map(wireEntry),
    lineTruncated: b.state.line.length > limit,
    exits: b.state.exits.filter((x) => !x.quick).slice(0, 100).map(wireExit),
    feed,
    trades: b.trades.slice(-300),
    note: b.note,
    unavailable: b.unavailable,
  };
}

export { groupFor, tierFor };

/** Older trade-tape rows: skip the newest `skip` trades, return up to `limit` older ones (newest first). */
export function tradesPage(b: Built, skip: number, limit: number): { trades: WireTrade[]; total: number } {
  const all = b.trades;
  const end = Math.max(0, all.length - skip);
  const start = Math.max(0, end - limit);
  return { trades: all.slice(start, end), total: all.length };
}


// ---------- any vibe/vibe token: the same line, built on demand (/line/<token>) ----------
const otherCache = new BoundedTtlMap<Built>(60);
const otherInflight = new Map<string, Promise<Built>>();

const notVibe = new BoundedTtlMap<true>(5_000); // "no factory launched this": remembered for 10 min

async function buildOther(token: string): Promise<Built> {
  if (notVibe.has(token)) throw new Error("not a vibe token");
  const meta = await fetchLaunch(token);
  if (!meta?.curve) {
    // curve unreadable: a stranger contract (answer: not vibe, cached) or a slow chain (unknown, not cached)
    const v = await isVibeLaunch(token).catch(() => "unknown" as const);
    if (v === false) {
      notVibe.set(token, true, 600_000);
      throw new Error("not a vibe token");
    }
    throw new Error("no launch meta");
  }
  // no factory launch event = not a vibe token: never read a stranger contract from block 0
  if (!(meta.createdBlock > 0n)) throw new Error(meta.creationUnknown ? "launch lookup failed" : "not a vibe token");
  // with block-time anchors: the tape and the ticket show real ages
  const cache = await loadEvents(token, meta);
  const plumbing = new Set<string>([ZERO, meta.curve, ...PLUMBING]);
  const trades = tradeFlow(cache.raw, meta.curve, plumbing);
  // graduated tokens trade in the pool: read the real ETH of recent pool buys (tape, volume, mark price)
  if (meta.graduated) await addActualBuyCosts(trades);
  addSaleEstimates(trades);
  const events = toBalanceEvents(cache.raw, plumbing, meta.curve);
  const state = buildQueue(events, { creator: meta.creator, priceEth: curvePrice(meta.tokensSold) });
  return { mode: "live", token, meta, state, trades, block: Number(cache.lastBlock) };
}

/** The line of any vibe/vibe token; $EXIT goes through the main cached build. Throws when unknown. */
export async function buildFor(token: string): Promise<Built> {
  const t = token.toLowerCase();
  if (t === ACTIVE_TOKEN) return buildState();
  const hit = otherCache.get(t);
  if (hit) return hit;
  let job = otherInflight.get(t);
  if (!job) {
    job = withTimeout(buildOther(t), 25_000)
      .then((v) => {
        otherCache.set(t, v, 15_000);
        return v;
      })
      .finally(() => otherInflight.delete(t));
    otherInflight.set(t, job);
  }
  return job;
}
