// Token analytics for taxed v6 launches: the same `Analytics` answer as the v1 engine (engine.ts), built from
// the chain: the token's own Transfer log (chain.loadEvents, the same per-token cache), the curve's Buy / Sell
// events (exact pair sizes), the V4 pool's Swap events after graduation, live curve / pool state (v6market.ts).
// The vibe API adds only what the chain can't say cheaply: the gift list, the tax split, the dev's own part.
//
// v6 differences the replay handles (measured 16.10 on PAK07ADS, LEADER):
// - tax transfers: curve / pool -> token contract (holder rewards, then token -> 0xdead burn), token -> wallet
//   (reward payouts). The token contract is plumbing: rewards are free tokens, never a buy or a gift.
// - pool trades go through vibe's zaps (one per v6 factory): PoolManager -> zap -> buyer, seller -> zap -> PoolManager.
//   Every zap hop is collapsed so a pool buy reads as PoolManager -> buyer (the same shape the v1 compute expects).
// - the gift list: the creator delivers equal slices to thousands of wallets (3,879 on LEADER). That is vibe's
//   airdrop, not the dev moving tokens: those transfers come from a synthetic "gift list" address instead.
//
// Unknown is never zero: a section that can't be computed is { data: null, reason }.
import "server-only";
import { client, loadEvents, tokenAbi, v6LaunchCreation, type LaunchMeta, type RawTransfer } from "@/lib/chain";
import { PLUMBING, POOL_MANAGER, V6_PLUMBING, V6_ZAPS, V6_ZAP_SET } from "@/lib/factories";
import { explorerBudgetShare, topHolders } from "@/lib/holders";
import { BoundedTtlMap } from "@/lib/bounded";
import { earlyIndex } from "@/lib/earlyIndex";
import { taxSplitOf, v6Launch, type ApiLaunch } from "@/lib/v6";
import { pairSymbol } from "@/lib/pairs";
import type { QueueEntry } from "@/lib/queue";
import type { HealthResult } from "@/lib/health";
import type { Address } from "viem";
import { book, bundle, devFlows, devSoldPct, dustFor, exitMath, lastTradeAt, pusherOf, sortRaw, supplyOf, volume, walletTags, WASH_WINDOW_SEC, ZERO, DEAD, type HolderExtra, type Leg, type Quotes } from "./compute";
import { blocksIn, measuredSecPerBlock } from "./blocktime";
import { field, labels, nonceOf, secPerBlock, settle, within, windowStarts, NotVibeError, type Src } from "./engine";
import { healthOf } from "./healthMemo";
import { clonesOf } from "./clones";
import { chipsFor } from "./chips";
import { v6CurveTrades, v6GiftTxs, v6MarketOf, v6PoolSwaps, v6QuoteSell, type CurveTrades, type V6Market } from "./v6market";
import type { Analytics, ExitMath, Field, Market, V6Facts, Volume } from "./types";

const ANSWER_TTL = 30_000;
const SIDE_BUDGET_MS = 4_500;
const RACE_MS = 2_000;
const STALE_MAX = 5 * 60_000;
const STALE_SERVE_MAX = 90_000;
/** synthetic sender of gift-list deliveries (plumbing: not a person, not the dev) */
const GIFTS = "0x00000000000000000000000000000000006f1f75";
/** book(): GIFTS deliveries are gifts to people (giftedHolders, the "gifted" tag), not plumbing moves */
const GIFT_SENDERS: ReadonlySet<string> = new Set([GIFTS]);

const answers = new BoundedTtlMap<Analytics>(200);
const lastGood = new BoundedTtlMap<Analytics>(200);
const inflight = new Map<string, Promise<Analytics>>();

/* ---------------- is it a v6 launch (cached) ---------------- */

type Creation = { block: number; curve: string; creator: string };
const known = new BoundedTtlMap<Creation>(5_000);
const notV6 = new BoundedTtlMap<true>(5_000);
/** tokens vibe lists as v6 launches that none of our factories emitted (a sign of a new factory) */
const unknownFactory = new Set<string>();
export const v6UnknownFactoryCount = () => unknownFactory.size;

/** a token this instance already resolved as v6 (no I/O): the routes skip the v1 lookup for it */
export function isKnownV6(token: string): boolean {
  return known.get(token.toLowerCase()) !== undefined;
}

/** creation of a v6 launch: the chain first (factory log), the vibe launch record when the chain lookup fails */
async function creationOf(token: string, launch: ApiLaunch | null | undefined): Promise<Creation | null> {
  const hit = known.get(token);
  if (hit) return hit;
  if (notV6.get(token)) return null;
  let c: Creation | null | undefined;
  try {
    c = await v6LaunchCreation(token);
  } catch {
    c = undefined; // unknown: vibe's record decides below
  }
  // the chain lookup failed (undefined) OR found no log from the factories we list (null) while vibe itself calls
  // it a v6 launch: vibe's record wins. A factory we don't know yet (06.11: every new launch read "not vibe" for
  // five days) must not hide real launches; it is counted so /api/screener?stats=1 and the watcher can shout.
  if (!c && launch && /^\d+$/.test(launch.createdBlock ?? "") && launch.curveAddress && launch.launcherAddress) {
    if (c === null) {
      unknownFactory.add(token);
      console.warn(`v6: ${token} is a vibe launch but no listed factory emitted it: NEW FACTORY? (src/data/factories.json)`);
    }
    c = { block: Number(launch.createdBlock), curve: launch.curveAddress.toLowerCase(), creator: launch.launcherAddress.toLowerCase() };
  }
  if (c === undefined) {
    // the factory log slices can time out on this node for an address the explorer can't place: an address
    // with no code is no token at all (a definite "not v6"); a contract stays unknown
    const code = await client.getCode({ address: token as Address }).catch(() => undefined);
    if (code === undefined || (code && code !== "0x")) throw new Error("v6 lookup failed");
    c = null;
  }
  if (c) known.set(token, c, 30 * 86_400_000);
  else notV6.set(token, true, 10 * 60_000);
  return c;
}

/* ---------------- the replay input ---------------- */

type Prepared = {
  raw: RawTransfer[]; // zap collapsed, gifts from GIFTS, synthetic creator -> GIFTS per gift tx
  healthRaw: RawTransfer[]; // the same without the synthetic creator -> GIFTS
  giftRecipients: Set<string>;
  giftTokens: number;
  rewardsPaid: number;
  rewardWallets: number;
  gradBlock: number | null;
};

const whole = (v: bigint) => Number(v / 10n ** 12n) / 1e6;

function prepare(rawIn: RawTransfer[], token: string, curve: string, creator: string, giftTxs: Set<string> | null): Prepared {
  const raw = sortRaw(rawIn);
  const market = new Set([curve, POOL_MANAGER]);
  // group by tx (the log is sorted, a tx's transfers sit together)
  const out: RawTransfer[] = [];
  const healthRaw: RawTransfer[] = [];
  const giftRecipients = new Set<string>();
  const rewardTo = new Set<string>();
  let giftTokens = 0, rewardsPaid = 0;
  let gradBlock: number | null = null;
  let i = 0;
  while (i < raw.length) {
    let j = i + 1;
    const tx = raw[i].tx;
    while (j < raw.length && tx && raw[j].tx === tx) j++;
    const group = raw.slice(i, j).map((r) => ({ ...r }));
    i = j;
    if (gradBlock === null && group.some((r) => r.to === POOL_MANAGER || r.from === POOL_MANAGER)) gradBlock = group[0].block;

    // ---- the zap hops: market -> zap -> wallet becomes market -> wallet; wallet -> zap -> market the same.
    // One zap per v6 factory (factories.json "zap"): the Nov factory's pool buys go PM -> 0xe1f8… -> wallet ----
    for (const zap of V6_ZAPS) {
      if (!group.some((r) => r.from === zap || r.to === zap)) continue;
      const inFromMarket = group.filter((r) => r.to === zap && market.has(r.from));
      const outToMarket = group.filter((r) => r.from === zap && market.has(r.to));
      const toWallet = group.filter((r) => r.from === zap && !market.has(r.to));
      const fromWallet = group.filter((r) => r.to === zap && !market.has(r.from));
      const drop = new Set<RawTransfer>();
      if (inFromMarket.length && toWallet.length) {
        for (const r of toWallet) r.from = inFromMarket[0].from;
        for (const r of inFromMarket) drop.add(r);
      }
      if (outToMarket.length && fromWallet.length) {
        for (const r of fromWallet) r.to = outToMarket[0].to;
        for (const r of outToMarket) drop.add(r);
      }
      for (let k = group.length - 1; k >= 0; k--) if (drop.has(group[k])) group.splice(k, 1);
    }

    // ---- gift-list deliveries: creator -> many wallets in a tx the token marks with its gift-batch event ----
    const fromDev = creator ? group.filter((r) => r.from === creator && r.to !== curve && r.to !== POOL_MANAGER && !V6_ZAP_SET.has(r.to) && r.to !== token && r.to !== DEAD) : [];
    let gifts: RawTransfer[] = [];
    if (fromDev.length) {
      if (giftTxs) gifts = tx && giftTxs.has(tx.toLowerCase()) ? fromDev : [];
      else if (new Set(fromDev.map((r) => r.to)).size >= 10) gifts = fromDev; // batch event unread: 10+ wallets in one tx
    }
    if (gifts.length) {
      const sum = gifts.reduce((s, r) => s + r.value, 0n);
      const g0 = gifts[0];
      out.push({ from: creator, to: GIFTS, value: sum, block: g0.block, logIndex: g0.logIndex, tx: g0.tx, ts: g0.ts });
      for (const r of gifts) {
        r.from = GIFTS;
        giftRecipients.add(r.to);
        giftTokens += whole(r.value);
      }
    }
    for (const r of group) {
      if (r.from === token && r.to !== DEAD && r.to !== ZERO && r.to !== curve && r.to !== POOL_MANAGER) {
        rewardsPaid += whole(r.value);
        rewardTo.add(r.to);
      }
      out.push(r);
      healthRaw.push(r);
    }
  }
  return { raw: out, healthRaw, giftRecipients, giftTokens, rewardsPaid, rewardWallets: rewardTo.size, gradBlock };
}

/** market legs of a v6 line: curve trades sized by the curve's Buy / Sell events, pool trades by the pool's Swap events */
function v6Legs(raw: RawTransfer[], curve: string, plumbing: Set<string>, ct: CurveTrades | null, swaps: Map<string, number> | null): Leg[] {
  const legs: Leg[] = [];
  const at = new Map<string, number>();
  for (const r of raw) {
    if (r.value <= 0n || !r.tx) continue;
    let side: "buy" | "sell" | null = null;
    let venue: "curve" | "pool" = "curve";
    let wallet = "";
    if (r.from === curve && !plumbing.has(r.to)) { side = "buy"; wallet = r.to; }
    else if (r.to === curve && !plumbing.has(r.from)) { side = "sell"; wallet = r.from; }
    else if (r.from === POOL_MANAGER && !plumbing.has(r.to)) { side = "buy"; venue = "pool"; wallet = r.to; }
    else if (r.to === POOL_MANAGER && !plumbing.has(r.from)) { side = "sell"; venue = "pool"; wallet = r.from; }
    if (!side) continue;
    const key = `${r.tx}:${wallet}:${side}`;
    const tokens = whole(r.value);
    const k = at.get(key);
    if (k !== undefined) { legs[k].tokens += tokens; continue; }
    at.set(key, legs.length);
    legs.push({ wallet, side, tokens, eth: null, venue, block: r.block, logIndex: r.logIndex, ts: r.ts, tx: r.tx });
  }
  // sizes: the tx's pair amount, split by tokens when one tx carries several legs of a side
  const share = new Map<string, number>();
  for (const l of legs) share.set(`${l.tx}:${l.side}:${l.venue}`, (share.get(`${l.tx}:${l.side}:${l.venue}`) ?? 0) + l.tokens);
  for (const l of legs) {
    const tx = l.tx.toLowerCase();
    const total = share.get(`${l.tx}:${l.side}:${l.venue}`) ?? 0;
    const part = total > 0 ? l.tokens / total : 0;
    if (l.venue === "curve") {
      const row = ct?.byTx.get(tx);
      const pair = row ? (l.side === "buy" ? row.buyPair : row.sellPair) : null;
      l.eth = pair !== null && pair > 0 ? pair * part : null;
    } else {
      const v = swaps?.get(tx);
      l.eth = v !== undefined && v > 0 ? v * part : null;
    }
  }
  return legs;
}

/* ---------------- the answer ---------------- */

export function analyticsV6(token: string): Promise<Analytics> {
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

type Base = {
  token: string;
  creation: Creation;
  launch: ApiLaunch | null;
  prepared: Prepared;
  plumbing: Set<string>;
  head: number;
  rawAll: RawTransfer[];
};

const big = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

async function base(token: string, launchP?: Promise<ApiLaunch | null | undefined>): Promise<Base> {
  // the vibe record (gift list, tax split) is optional: the chain answers without it
  const launch = await (launchP ?? v6Launch(token).catch(() => undefined));
  const creation = await creationOf(token, launch);
  if (!creation) throw new NotVibeError("not a vibe token");
  const cache = await loadEvents(token, { createdBlock: BigInt(creation.block) } as LaunchMeta);
  const head = Number(cache.lastBlock);
  const giftTxs = await v6GiftTxs(token, creation.block, head).catch(() => null);
  const prepared = prepare(cache.raw, token, creation.curve, creation.creator, giftTxs);
  const plumbing = new Set<string>([ZERO, creation.curve, token, GIFTS, ...V6_PLUMBING, ...PLUMBING]);
  return { token, creation, launch: launch ?? null, prepared, plumbing, head, rawAll: cache.raw };
}

/** Line Health of a v6 line (the same replay and memo as /api/health for v1). null = not a v6 launch. */
export async function healthV6(token: string): Promise<(HealthResult & { block: number }) | null> {
  let b: Base;
  try {
    b = await base(token.toLowerCase());
  } catch (e) {
    if (e instanceof NotVibeError) return null;
    throw e;
  }
  return healthOf({
    token: b.token, creator: b.creation.creator, curve: b.creation.curve, raw: b.prepared.healthRaw,
    plumbing: b.plumbing, complete: true, headBlock: b.head, nowSec: Math.floor(Date.now() / 1000),
  });
}

const nameMemo = new BoundedTtlMap<{ symbol: string; name: string }>(2_000);
async function namesOf(token: string, launch: ApiLaunch | null): Promise<{ symbol: string; name: string }> {
  if (launch?.symbol) return { symbol: String(launch.symbol).slice(0, 16), name: String(launch.name ?? "").slice(0, 40) };
  const hit = nameMemo.get(token);
  if (hit) return hit;
  try {
    const [s, n] = await client.multicall({
      contracts: [{ address: token as Address, abi: tokenAbi, functionName: "symbol" }, { address: token as Address, abi: tokenAbi, functionName: "name" }],
      allowFailure: true,
    });
    const v = { symbol: s.status === "success" ? String(s.result).slice(0, 16) : "", name: n.status === "success" ? String(n.result).slice(0, 40) : "" };
    nameMemo.set(token, v, 86_400_000);
    return v;
  } catch {
    return { symbol: "", name: "" };
  }
}

async function build(token: string): Promise<Analytics> {
  // the slow side lookups (Blockscout funding, vibe search, curve / pool state) start before the log replay,
  // under one deadline from the start: a cold build no longer waits for the log and then 4.5 s more
  const deadline = Date.now() + SIDE_BUDGET_MS;
  const left = () => Math.max(0, deadline - Date.now());
  const launchP = v6Launch(token).catch(() => undefined);
  const holdersP = topHolders(token, { lookups: explorerBudgetShare() > 0.5 });
  const namesP = launchP.then((l) => namesOf(token, l ?? null));
  const clonesP = namesP.then((n) => clonesOf(token, n.symbol, n.name));
  const early = launchP.then((l) => (l?.curveAddress ? v6MarketOf(token, l.curveAddress) : null)).catch(() => null);
  holdersP.catch(() => {});
  clonesP.catch(() => {});
  early.catch(() => {});
  const b = await base(token, launchP);
  const { creation, launch, prepared: P, plumbing, head } = b;
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const curve = creation.curve;
  const creator = creation.creator;
  const lb = labels(nowSec);

  const names = await namesP;
  const marketP = v6MarketOf(token, curve).then((m) => ({ m, why: null as string | null }), () => ({ m: null as V6Market | null, why: "Curve / pool state unreadable right now." }));
  const sinceP = windowStarts(head);
  const spbP = secPerBlock(head);
  spbP.catch(() => {});

  const mkt = await marketP;
  const market = mkt.m;
  const dec = market?.pair.decimals ?? (launch?.pairIsNative ? 18 : null);
  const pairNative = market ? market.pair.native : launch?.pairIsNative === true;
  const unitSymbol = pairNative ? "ETH" : (market?.pair.symbol ?? pairSymbol(launch?.pairSymbol, launch?.pairCurrencyAddress) ?? "pair");

  // ---- trade sizes: curve events (whole life of the curve), pool swaps after graduation ----
  let ct: CurveTrades | null = null;
  let ctWhy: string | null = null;
  let swaps: Map<string, number> | null = null;
  let swapWhy: string | null = null;
  if (dec === null) ctWhy = "Pair decimals unknown: trade sizes unknown.";
  else {
    const curveEnd = P.gradBlock ?? head;
    const poolId = market?.poolId ?? launch?.graduation?.poolId?.toLowerCase() ?? null;
    const pairAddr = market?.pair.address ?? null;
    const pairIs0 = pairNative || (pairAddr !== null && pairAddr < token);
    const [a, s] = await Promise.all([
      v6CurveTrades(curve, creation.block, curveEnd, dec).catch(() => null),
      P.gradBlock !== null
        ? poolId && (pairNative || pairAddr) ? v6PoolSwaps(poolId, pairIs0, dec, P.gradBlock, head).catch(() => null) : Promise.resolve(null)
        : Promise.resolve(new Map<string, number>()),
    ]);
    ct = a;
    if (!a) ctWhy = "Curve trade log unreadable: curve trade sizes unknown.";
    swaps = s;
    if (P.gradBlock !== null && !s) swapWhy = poolId ? "Pool swap log unreadable: pool trade sizes unknown." : "Pool unknown: pool trade sizes unknown.";
  }

  const legs = v6Legs(P.raw, curve, plumbing, ct, swaps);
  const bk = book(P.raw, legs, curve, plumbing, GIFT_SENDERS);
  const supplyTotal = bk.minted > 0 ? bk.minted : 1_000_000_000;

  const people = [...bk.balance.entries()]
    .filter(([w, v]) => v > 0 && !plumbing.has(w) && w !== POOL_MANAGER && w !== curve)
    .sort((x, y) => y[1] - x[1]);
  const nonceP = nonceOf(people.slice(0, 10).map(([w]) => w));

  // ---- holders.ts clusters + funding blocks ----
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
  const sizeWhy = [ctWhy, swapWhy].filter(Boolean).join(" ") || null;
  const unitNote = pairNative ? null : `Sizes in ${unitSymbol}.`;

  // ---- 1. bundle ----
  // dust in the pair's own unit (0.0001 ETH on an ETH pair; a token pair: 1/1000 of its first impact size)
  const dust = dustFor(pairNative, market ? market.sizes[0] : null);
  const bundleData = legs.some((l) => l.side === "buy") ? bundle(legs, bk, creator, creation.block, supplyTotal, cluster, checked, true, dust) : null;
  const bundleF = field(bundleData, ["chain + Blockscout", "Transfer logs, first 100 buys · funding clusters from Blockscout (top holders)"],
    bundleData ? (holders ? (holders.pending ? `Funding read for ${checked.size} of ${checked.size + holders.pending} top holders so far; the rest on the next refresh.` : null) : holdersWhy) : "No buys yet.", now);

  // ---- 2. exit math ----
  let exitF: Field<ExitMath>;
  const exitSrc: Src = ["chain", market?.venue === "pool" ? "Line replay · V4 pool slot0 / liquidity" : "Line replay · curve reserveAt / quoteBuyExactIn / quoteSell eth_call"];
  if (!market) exitF = field<ExitMath>(null, exitSrc, mkt.why, now);
  else {
    const line = people.map(([w, v], i) => ({
      wallet: w,
      place: i + 1,
      balance: BigInt(Math.round(v * 1e6)) * 10n ** 12n,
      positionCostEth: bk.cost.get(w) ?? 0,
    })) as unknown as QueueEntry[];
    const m = { venue: market.venue, spotEth: market.spot, reserves: market.reserves, realEthReserve: market.realReserve, tokensLeft: market.tokensLeft, fee: market.fee };
    const pre = exitMath(line, bk, m, supplyTotal, null, market.sizes, market.sizes[0]);
    const quotes: Quotes = { buy: market.buyQuotes, dump: pre.profitTokensExact > 0 ? await v6QuoteSell(market, pre.profitTokensExact) : null };
    const { profitTokensExact: _p, ...em } = exitMath(line, bk, m, supplyTotal, quotes, market.sizes, market.sizes[0]);
    void _p;
    const reason = [
      em.estimatedCost ? `${em.estimatedCost} of ${em.inLine} cost bases are partial (a trade size unknown).` : null,
      em.noCostHolders ? `${em.noCostHolders} bag${em.noCostHolders === 1 ? "" : "s"} came by gift or transfer with no known cost: left out.` : null,
      sizeWhy,
      unitNote,
    ].filter(Boolean).join(" ") || null;
    exitF = field(em, exitSrc, reason, now);
  }

  // ---- 3. volume ----
  const since = legs.length ? await sinceP : null;
  const tsMissing = !since && legs.some((l) => !l.ts);
  let volF: Field<Volume>;
  const volSrc: Src = ["chain", P.gradBlock !== null ? "Transfer logs + curve Buy/Sell events + PoolManager Swap events" : "Transfer logs + curve Buy/Sell events"];
  if (!legs.length) volF = field<Volume>(null, volSrc, "No trades yet.", now);
  else {
    // the wash window in blocks for legs without a timestamp: the log's own measured block time
    const v = volume(legs, nowSec, lb, since, dust, { washBlocks: blocksIn(WASH_WINDOW_SEC, measuredSecPerBlock(P.raw)), creator });
    v.labelsAsOf = lb ? earlyIndex().generatedAt : null;
    if (tsMissing) {
      v.windows = v.windows.filter((w) => w.label === "all");
      v.topTradersWindow = "all";
    }
    const reasons = [
      tsMissing ? "Block times unknown: 1h / 24h hidden." : null,
      sizeWhy,
      lb ? null : "Bot labels too old: bot share unknown.",
      pairNative ? null : dust === null ? `Volume in ${unitSymbol}; dust trades not taken out (pair scale unknown).` : `Volume in ${unitSymbol}; dust = under ${dust} ${unitSymbol}.`,
    ].filter(Boolean).join(" ") || null;
    volF = field(v, volSrc, reasons, now);
  }

  // ---- 4. supply ----
  const [nonce, spbV] = await Promise.all([within(nonceP, left(), new Map<string, number>()), within(spbP, left(), null)]);
  const dev = creator ? { sells: legs.filter((l) => l.wallet === creator && l.side === "sell").length, movedTo: bk.gaveTo.get(creator)?.size ?? 0 } : null;
  const extra: HolderExtra = { cluster, fundedBlock, checked, nonce, labels: lb, secPerBlock: spbV, dev };
  const sup = supplyOf(bk, curve, plumbing, creator, extra);
  sup.devSoldPct = dev ? devSoldPct(legs, bk, creator, (launch?.gifts ? whole(big(launch.gifts.reservedUnits) ?? 0n) : 0)) : null;
  const df = dev ? devFlows(legs, creator, supplyTotal) : null;
  sup.devSoldSupplyPct = df ? df.soldSupplyPct : null;
  sup.devEthIn = df ? df.ethIn : null;
  sup.devEthOut = df ? df.ethOut : null;
  sup.pusher = pusherOf(legs, supplyTotal, creator);
  const supReasons = [
    holders ? null : holdersS.ok ? null : holdersS.timedOut ? "Funding (fresh / cluster) still loading, next refresh." : "Funding (fresh / cluster): explorer didn't answer.",
    nonce.size < Math.min(10, people.length) ? "Some nonces unknown." : null,
    P.giftRecipients.size ? `${P.giftRecipients.size} gift-list wallets count as holders.` : null,
  ].filter(Boolean).join(" ") || null;
  const supplyF = field(sup, ["chain + Blockscout", "Transfer log replay · nonces eth_getTransactionCount · first funding from Blockscout"], supReasons, now);

  // ---- 5. clones ----
  const clS = await settle(clonesP, left());
  const cl = clS.ok ? clS.v : null;
  const clonesF = field(cl, ["vibe API", "vibe/vibe search, exact ticker or name"], cl ? (cl.partial ? "Read the 200 newest matches: an older one may exist." : null) : clS.ok ? null : clS.timedOut ? "Search still loading, next refresh." : "vibe/vibe search didn't answer.", now);

  // ---- Line Health ----
  let health: Analytics["health"] = null;
  try {
    const h = healthOf({ token, creator, curve, raw: P.healthRaw, plumbing, complete: true, headBlock: head, nowSec });
    health = { grade: h.grade, score: h.score, partial: h.partial, high: h.high, snipers: h.counts.snipers, farm: h.counts.farm, firstBuyers: h.counts.firstBuyers, stillHolding: h.counts.stillHolding };
  } catch { /* "—" */ }

  const supplyKnown = bk.minted > 0 ? bk.minted : null;
  const marketF: Field<Market> = market
    ? field<Market>({
      venue: market.venue,
      spotEth: market.spot,
      virtualEth: market.reserves.e,
      virtualTokens: market.reserves.t,
      fee: market.fee,
      realEthReserve: market.realReserve,
      tokensLeft: market.tokensLeft,
      poolId: market.poolId,
      modelCheck: market.modelCheck,
      supply: supplyKnown,
      mcapEth: supplyKnown === null ? null : market.spot * supplyKnown,
      // vibe's graduation position is full range: the pool's virtual pair reserve is its real pair liquidity
      poolEth: market.venue === "pool" ? market.reserves.e : null,
      lastTradeAt: lastTradeAt(legs),
      launchMcapEth: supplyKnown === null || market.launchSpot === null ? null : market.launchSpot * supplyKnown,
    }, ["chain", market.venue === "curve" ? "curve reserveAt / sold eth_call" : "V4 PoolManager extsload"], unitNote, now)
    : field<Market>(null, ["chain", "curve / V4 pool eth_call"], mkt.why, now);

  // ---- v6 facts ----
  const pct = (v: number) => Math.round((v / supplyTotal) * 10_000) / 100;
  const g = launch?.gifts;
  const gCount = big(g?.count);
  const giftsF: V6Facts["gifts"] = gCount !== null && gCount > 0n
    ? {
      count: Number(gCount),
      delivered: Number(big(g?.deliveredCount) ?? 0n),
      reservedPct: pct(whole(big(g?.reservedUnits) ?? 0n)),
      deliveredPct: pct(P.giftTokens),
      // nothing else came in: no buy, and no gift beyond the gift list's own delivery
      onlyGiftHolders: [...P.giftRecipients].filter((w) => (bk.balance.get(w) ?? 0) > 0 && !(bk.boughtIn.get(w) ?? 0) && !((bk.giftIn.get(w) ?? 0) - (bk.listGiftIn.get(w) ?? 0) > 1e-9)).length,
    }
    : null;
  const personal = big(launch?.initialNetPersonalUnits);
  const door = market && market.venue === "curve" && market.realReserve !== null
    ? { reservePair: market.realReserve, targetPair: market.target, bps: market.target ? Math.min(10_000, Math.round((market.realReserve / market.target) * 10_000)) : null }
    : null;
  const v6: V6Facts = {
    pair: { symbol: unitSymbol, native: pairNative, address: market?.pair.address ?? (pairNative ? null : (launch?.pairCurrencyAddress ?? null)), decimals: dec },
    taxBps: market?.rateBps ?? (typeof launch?.taxBps === "number" ? launch.taxBps : null),
    taxSplit: taxSplitOf(launch?.weights),
    gifts: giftsF,
    burnedPct: pct(bk.balance.get(DEAD) ?? 0),
    rewardsHeldPct: pct(bk.balance.get(token) ?? 0),
    rewardsPaidPct: pct(P.rewardsPaid),
    rewardWallets: P.rewardWallets,
    devPersonalPct: personal !== null ? pct(whole(personal)) : null,
    curveFeesPair: ct ? Math.round(ct.feesPair * 1e6) / 1e6 : null,
    door,
    graduatedBlock: P.gradBlock,
  };

  const out: Analytics = {
    token,
    symbol: names.symbol,
    block: head,
    computedAt: now,
    graduated: P.gradBlock !== null || market?.venue === "pool",
    ageSec: spbV ? Math.max(0, Math.round((head - creation.block) * spbV)) : null,
    indexWindowDays: lb ? earlyIndex().windowDays : null,
    health,
    market: marketF,
    bundle: bundleF,
    exitMath: exitF,
    volume: volF,
    supply: supplyF,
    clones: clonesF,
    chips: [],
    tags: walletTags(legs, bk, creator, lb),
    unit: { symbol: unitSymbol, native: pairNative },
    v6,
  };
  out.chips = chipsFor(out);
  return out;
}
