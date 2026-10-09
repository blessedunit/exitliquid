// Pure queue logic: turns an ordered list of balance changes into the
// Exit Queue, Liquidity Points (LP) and the Hall of Exits.
// No network code here, so it can be tested with plain fixtures.
//
// Rules (mirrors the manifesto):
// 1. First in, first in line: order = time of entry (first buy, or re-entry).
// 2. A wallet's first entry made by ONE buy of >= 0.003 ETH gives +1 point to everyone
//    already in line; re-entries and smaller buys give nothing.
// 3. Exit (sold 95% of your peak bag): you walk through the door, your points are split between
//    everyone who stood behind you. Everyone behind moves up one place.
// 4. Come back after a full exit and you enter at the end with 0 LP.
// Partial sells keep your place; your skin follows your current bag.
// LP are points, not money.

import type { Skin } from "@/lib/skins";

export type BalanceEvent = {
  wallet: string; // lowercase address
  delta: bigint; // token base units, + buy / - sell
  block: number;
  logIndex: number;
  ts: number; // unix seconds (best effort, 0 if unknown)
  tx?: string;
  market?: boolean; // tokens came from the curve / pool (a buy), not from another wallet. undefined = yes
  priceEth?: number; // curve spot price right after this event (ETH per token); undefined = unknown (tests, mock)
  buyValueEth?: number; // actual ETH sent for this market buy, when known
  buyIn?: bigint; // set by netPerTx: tokens that came in through a buy in this tx
};

export type QueueEntry = {
  wallet: string;
  place: number; // 1-based position in the line
  balance: bigint;
  lp: number;
  enteredBlock: number;
  enteredTs: number;
  entryTokens: bigint; // the market buy that crossed the entry threshold
  entryPriceEth: number; // estimated ETH/token at that buy
  positionCostEth: number; // remaining purchased bag's historical ETH cost basis
  entries: number; // how many times this wallet got in line
  skin: Skin;
  tier: number; // 1..5 (0 for special)
  behind: number; // people behind you = your exit liquidity
  ahead: number;
  isCreator: boolean;
};

export type ExitRecord = {
  wallet: string;
  exitedAtPlace: number;
  lpReleased: number;
  exitedBlock: number;
  exitedTs: number;
  behindAtExit: number;
  enteredBlock: number; // when this stay in line began (for "how many ahead of me already left")
  quick: boolean; // walked in and out within MATURE_BLOCKS: kept out of the Hall and the feed
  tx?: string;
};

export type FeedItem =
  | { kind: "join"; wallet: string; place: number; ahead: number; block: number; ts: number; tx?: string }
  | { kind: "exit"; wallet: string; place: number; behind: number; block: number; ts: number; tx?: string; quick?: boolean }
  | { kind: "bag"; wallet: string; place: number; up: boolean; block: number; ts: number; tx?: string };

export type QueueState = {
  line: QueueEntry[];
  exits: ExitRecord[];
  feed: FeedItem[]; // newest first
  totals: { inLine: number; exited: number; everJoined: number; lpIssued: number };
};

// Ranks by what your bag is worth right now, in ETH at the current curve price.
// (By share of supply they only measured WHEN you bought: price grows ~15x along the curve.)
export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const TIERS: { tier: number; skin: Skin; name: string; minEth: number }[] = [
  { tier: 5, skin: "suit", name: "The Suit", minEth: 0.03 },
  { tier: 4, skin: "getaway", name: "Crypto Bro", minEth: 0.012 },
  { tier: 3, skin: "bag", name: "Chart Guy", minEth: 0.004 },
  { tier: 2, skin: "hood", name: "Retail", minEth: 0.0008 },
  { tier: 1, skin: "plain", name: "Broke Degen", minEth: 0 },
];

// vibe/vibe bonding curve: constant product on virtual reserves (verified against live quoteBuy).
const VT0 = 1_073_000_000; // virtual token reserve at start (tokens)
const VE0 = 1.764594628672298575; // virtual ETH reserve at start
const CURVE_TOKENS = 793_100_000;
/** Spot price in ETH per token for a given amount of tokens sold on the curve. */
export function curvePrice(tokensSold: number): number {
  const sold = Math.min(Math.max(tokensSold, 0), CURVE_TOKENS);
  const left = VT0 - sold;
  return (VT0 * VE0) / (left * left);
}

/** Historical ETH spent between two curve supply points, before protocol fees. */
export function curveBuyCost(beforeSold: number, afterSold: number): number {
  const before = Math.min(Math.max(beforeSold, 0), CURVE_TOKENS);
  const after = Math.min(Math.max(afterSold, before), CURVE_TOKENS);
  return VE0 * VT0 * (1 / (VT0 - after) - 1 / (VT0 - before));
}

const START_PRICE = curvePrice(0);

// price is passed per call: many token lines are built in one process, so no shared state
export function tierFor(balance: bigint, priceEth: number = START_PRICE): { tier: number; skin: Skin; name: string } {
  const tokens = Number(balance / 10n ** 12n) / 1e6;
  const valueEth = tokens * priceEth;
  for (const t of TIERS) if (valueEth >= t.minEth) return t;
  return TIERS[TIERS.length - 1];
}

// Wallets that are protocol plumbing, never people in line.
export function isPlumbing(w: string, plumbing: Set<string>) {
  return w === "0x0000000000000000000000000000000000000000" || plumbing.has(w);
}

// A place in line needs a real bag: 0.0003 ETH actually paid for the tokens still held (~180k tokens at launch,
// fewer later). Makes buying the front of the line with throwaway wallets ~17x dearer.
// Without a known price (tests, mock) the fallback is 10,000 tokens.
export const MIN_PLACE_ETH = 0.0003;
// A place is cheap to get, but printing points requires a meaningful first buy.
// This raises the cost of splitting one bag across throwaway wallets.
export const POINTS_BUY_ETH = 0.003;
const EPS = 1e-9; // float tolerance: a buy of exactly 0.003 ETH must count as 0.003
export const MIN_PLACE = 10_000n * 10n ** 18n;
const bagEth = (bal: bigint, price: number) => (Number(bal / 10n ** 12n) / 1e6) * price;
// You walk through the door when you've sold 95% of your biggest bag, or your bag drops under 5,000 tokens.
const EXIT_BELOW = MIN_PLACE / 2n;
// Anti-churn: a newcomer who walks out within ~1 hour (blocks are ~0.165 s) takes its +1 back.
export const MATURE_BLOCKS = 22_000; // ~1 h at 0.165 s/block (measured 24.09)
const EXIT_SHARE_OF_PEAK = 20n; // bag <= peak / 20  ->  exit

type Live = {
  wallet: string;
  balance: bigint;
  peak: bigint; // biggest bag since this entry
  joinsAtEntry: number; // global newcomer counter when this wallet entered
  extra: number; // points received from people who exited ahead of it
  enteredBlock: number;
  enteredTs: number;
  entryTokens: bigint;
  entryPriceEth: number;
  entries: number;
  joinIndex: number; // this wallet's number among funded first entries (0 = gave nobody points)
  firstBlock: number; // block of its first ever entry
  gaveTo: number; // how many stood ahead when it first joined (= points it handed out)
};

/** sorted insert */
function insertSorted(a: number[], v: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  a.splice(lo, 0, v);
}
/** how many values in the sorted array are > v */
function countAbove(a: number[], v: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= v) lo = m + 1;
    else hi = m;
  }
  return a.length - lo;
}

// Collapse several transfers of the same wallet inside one transaction into one
// net change. Routers and self-transfers (in and out in the same tx) net to zero.
function netPerTx(events: BalanceEvent[]): BalanceEvent[] {
  const sorted = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const out: BalanceEvent[] = [];
  const idx = new Map<string, number>();
  for (const e of sorted) {
    const key = e.tx ? `${e.tx}:${e.wallet}` : "";
    const inBuy = e.delta > 0n && e.market !== false ? e.delta : 0n; // only incoming buys count as bought
    if (key && idx.has(key)) {
      const o = out[idx.get(key)!];
      o.delta += e.delta;
      o.buyIn = (o.buyIn ?? 0n) + inBuy;
      if (e.buyValueEth !== undefined) o.buyValueEth = (o.buyValueEth ?? 0) + e.buyValueEth;
      if (e.priceEth !== undefined) o.priceEth = e.priceEth; // price after the last transfer of the tx
      continue;
    }
    if (key) idx.set(key, out.length);
    out.push({ ...e, buyIn: inBuy });
  }
  return out.filter((e) => e.delta !== 0n);
}

export function buildQueue(events: BalanceEvent[], opts: { creator?: string; priceEth?: number } = {}): QueueState {
  const creator = opts.creator?.toLowerCase();
  const price = opts.priceEth && Number.isFinite(opts.priceEth) && opts.priceEth > 0 ? opts.priceEth : START_PRICE;
  const evs = netPerTx(events);

  const balances = new Map<string, bigint>();
  const line: Live[] = []; // entry order
  const byWallet = new Map<string, Live>();
  const entriesCount = new Map<string, number>();
  const exits: ExitRecord[] = [];
  const feed: FeedItem[] = [];
  const everJoined = new Set<string>();
  // Only a wallet's FIRST ever entry gives +1 to everyone ahead. Re-entries go to the
  // back of the line but mint nothing, so sell/re-buy loops can't print points.
  let joins = 0;
  let lpIssued = 0;
  // join numbers whose +1 was taken back (the newcomer left within MATURE_BLOCKS), sorted
  const revoked: number[] = [];

  // +1 for every first entry after mine, minus the ones taken back, plus shares from exits ahead
  const lpOf = (l: Live) => joins - l.joinsAtEntry - countAbove(revoked, l.joinsAtEntry) + l.extra;
  // the bought part of each bag (gifts don't count toward a place): grows with buys, never above the bag
  const bought = new Map<string, bigint>();
  // Purchase-cost basis for the bought part of each bag. The historical curve
  // estimate is used only when a transaction's actual ETH amount is unavailable.
  const boughtValueEth = new Map<string, number>();

  for (const ev of evs) {
    let bal = (balances.get(ev.wallet) ?? 0n) + ev.delta;
    if (bal < 0n) bal = 0n; // missing history should never create negative bags
    balances.set(ev.wallet, bal);
    const uncappedBought = (bought.get(ev.wallet) ?? 0n) + (ev.buyIn ?? 0n);
    let b = uncappedBought;
    if (b > bal) b = bal;
    bought.set(ev.wallet, b);
    const estimatedBuy = ev.buyIn && ev.buyIn > 0n ? bagEth(ev.buyIn, ev.priceEth ?? price) : 0;
    const uncappedCost = (boughtValueEth.get(ev.wallet) ?? 0) + (ev.buyValueEth ?? estimatedBuy);
    const boughtCost = uncappedBought > 0n ? uncappedCost * (Number(b) / Number(uncappedBought)) : 0;
    boughtValueEth.set(ev.wallet, boughtCost);
    const cur = byWallet.get(ev.wallet);

    if (!cur) {
      // not enough for a place (yet); the creator's launch buy always counts, so The Dev is #1
      // only the BOUGHT part of the bag counts: tokens handed over by another wallet never buy a place
      // only a buy can put a wallet (back) in line: a sell after an exit must never re-enter it
      if (!(ev.buyIn && ev.buyIn > 0n)) continue;
      const enough = ev.priceEth !== undefined || ev.buyValueEth !== undefined
        ? boughtCost + EPS >= MIN_PLACE_ETH
        : b >= MIN_PLACE;
      // the creator exemption is for the launch buy only: a Dev who left and came back needs a real bag
      if (!enough && !(creator && ev.wallet === creator && bal > 0n && !entriesCount.has(ev.wallet))) continue;
      const n = (entriesCount.get(ev.wallet) ?? 0) + 1;
      entriesCount.set(ev.wallet, n);
      // points need ONE buy of >= 0.003 ETH (the buy that puts you in line), not several small ones added up
      const thisBuyEth = ev.buyValueEth ?? estimatedBuy;
      const qualified = n === 1 && thisBuyEth + EPS >= POINTS_BUY_ETH;
      const gaveTo = qualified ? line.length : 0;
      if (qualified) {
        lpIssued += gaveTo;
        joins += 1;
      }
      const live: Live = {
        wallet: ev.wallet,
        balance: bal,
        peak: bal,
        joinsAtEntry: joins,
        extra: 0,
        enteredBlock: ev.block,
        enteredTs: ev.ts,
        entryTokens: ev.buyIn && ev.buyIn > 0n ? ev.buyIn : ev.delta > 0n ? ev.delta : 0n,
        entryPriceEth: ev.buyValueEth && ev.buyIn && ev.buyIn > 0n
          ? ev.buyValueEth / (Number(ev.buyIn) / 1e18)
          : ev.priceEth && ev.priceEth > 0 ? ev.priceEth : price,
        entries: n,
        joinIndex: qualified ? joins : 0,
        firstBlock: qualified ? ev.block : 0,
        gaveTo,
      };
      line.push(live);
      byWallet.set(ev.wallet, live);
      everJoined.add(ev.wallet);
      feed.push({ kind: "join", wallet: ev.wallet, place: line.length, ahead: line.length - 1, block: ev.block, ts: ev.ts, tx: ev.tx });
      continue;
    }

    const before = tierFor(cur.balance, price).tier;
    cur.balance = bal;
    if (bal > cur.peak) cur.peak = bal;
    // in the first hour a place is kept only while the bag is worth half the entry price (no buy-then-dump-94%)
    const young = ev.block - cur.enteredBlock < MATURE_BLOCKS && !(creator && cur.wallet === creator);
    const tooSmallYoung = young && (ev.priceEth !== undefined || ev.buyValueEth !== undefined) && boughtCost + EPS < MIN_PLACE_ETH / 2;
    if (bal < EXIT_BELOW || bal * EXIT_SHARE_OF_PEAK <= cur.peak || tooSmallYoung) {
      const i = line.indexOf(cur);
      const behind = line.length - i - 1;
      const quick = ev.block - cur.enteredBlock < MATURE_BLOCKS;
      // walked in and out within the hour: the +1 it gave everyone ahead is taken back
      if (cur.joinIndex > 0 && ev.block - cur.firstBlock < MATURE_BLOCKS) {
        insertSorted(revoked, cur.joinIndex);
        lpIssued -= cur.gaveTo;
      }
      const released = lpOf(cur);
      if (behind > 0 && released > 0) {
        const share = released / behind;
        for (let k = i + 1; k < line.length; k++) line[k].extra += share;
      }
      exits.push({ wallet: cur.wallet, exitedAtPlace: i + 1, lpReleased: released, exitedBlock: ev.block, exitedTs: ev.ts, behindAtExit: behind, enteredBlock: cur.enteredBlock, quick, tx: ev.tx });
      feed.push({ kind: "exit", wallet: cur.wallet, place: i + 1, behind, block: ev.block, ts: ev.ts, tx: ev.tx, quick });
      line.splice(i, 1);
      byWallet.delete(cur.wallet);
      continue;
    }
    const after = tierFor(bal, price).tier;
    if (after !== before) {
      feed.push({ kind: "bag", wallet: cur.wallet, place: line.indexOf(cur) + 1, up: after > before, block: ev.block, ts: ev.ts, tx: ev.tx });
    }
  }

  const quickStays = new Set(exits.filter((x) => x.quick).map((x) => `${x.wallet}:${x.enteredBlock}`));
  const total = line.length;
  const out: QueueEntry[] = line.map((l, i) => {
    const t = tierFor(l.balance, price);
    const isCreator = !!creator && l.wallet === creator;
    return {
      wallet: l.wallet,
      place: i + 1,
      balance: l.balance,
      lp: Math.round(lpOf(l) * 100) / 100,
      enteredBlock: l.enteredBlock,
      enteredTs: l.enteredTs,
      entryTokens: l.entryTokens,
      entryPriceEth: l.entryPriceEth,
      positionCostEth: boughtValueEth.get(l.wallet) ?? 0,
      entries: l.entries,
      // the joke: the dev is drawn as the ghost by the door, but never walks out (never sells)
      skin: isCreator && i === 0 ? "doorghost" : t.skin,
      tier: t.tier,
      behind: total - i - 1,
      ahead: i,
      isCreator,
    };
  });

  return {
    line: out,
    exits: exits.reverse(),
    // walk-ins (in and out within the hour) are left out of the feed: both their join and their exit
    feed: feed
      .filter((f) => !(f.kind === "exit" && f.quick) && !(f.kind === "join" && quickStays.has(`${f.wallet}:${f.block}`)))
      .reverse()
      .slice(0, 60),
    totals: { inLine: total, exited: exits.length, everJoined: everJoined.size, lpIssued },
  };
}

// Named groups by place, like the badge flairs of Reddit's "The Button".
export function groupFor(place: number, isCreator = false): string {
  if (place === 1 && isCreator) return "The Dev";
  if (place <= 10) return "Front Door";
  if (place <= 50) return "Hallway";
  if (place <= 200) return "Stairwell";
  if (place <= 1000) return "Parking Lot";
  return "Down the Block";
}

export function short(w: string) {
  return `${w.slice(0, 6)}…${w.slice(-4)}`; // one ellipsis glyph site-wide, as shortAddr() (every bundled font has U+2026)
}

export function formatTokens(v: bigint) {
  const whole = Number(v / 10n ** 15n) / 1000; // 3 decimals
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M`;
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(1)}K`;
  return whole.toFixed(0);
}
