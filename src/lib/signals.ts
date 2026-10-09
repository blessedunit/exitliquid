// Board signals: a cheap Line Health for up to 30 tokens at once (the Departures board's Signals column).
//
// The full Line Health (/api/health/<token>) replays a token's WHOLE Transfer history. Here the same scorer
// (lib/health computeHealth, unchanged) is fed a light history instead, built from three cheap reads:
//   1. the launch event (factory log: block, creator, curve) - cached for good, found in one OR-listed
//      getLogs per cluster of tokens when the board passes a createdAt hint, else one getLogs per token;
//   2. the start of the token's own Transfer log, scanned forward only until the first 20 buyers are in
//      and one more hour has passed after the 20th (enough for "snipers", "farm" and "first-hour exits"
//      exactly as the full check reads them) - immutable once done, cached;
//   3. every transfer OUT of the creator, whole history, scanned incrementally: one getLogs for the whole batch
//      (address list x creator list, filtered here) or one per token, whichever needs fewer requests under the
//      node's span caps (lib/logs).
// The first buyers' "still holding" comes from one multicall of balanceOf at the same head block: the
// difference to the replayed balance is added as a synthetic transfer, so the scorer sees today's bags.
// Signals, not verdicts. Unknown is never zero: a token we couldn't read is "unknown", never "clean".
import "server-only";
import { parseAbi, type Address, type Hex } from "viem";
import { client, launchLog, ZERO, type RawTransfer } from "./chain";
import { PLUMBING } from "./service";
import { computeHealth, type Grade } from "./health";
import { BoundedTtlMap } from "./bounded";
import { getLogsChunked, SPAN_LIST, SPAN_SINGLE } from "./logs";
import { earlyIndex } from "@/lib/earlyIndex";


export const SIGNALS_MAX = 30;

export type SignalStatus = "ok" | "early" | "not_v1" | "unknown";
export type TokenSignal = {
  token: string;
  /** ok = graded; early = fewer than 5 buyers yet; not_v1 = no v1 launch (taxed v6 or foreign); unknown = couldn't read */
  status: SignalStatus;
  grade: Grade | null;
  score: number | null;
  /** some inputs were unknown (stale wallet index): the grade covers only what could be read */
  partial: boolean;
  firstBuyers: number | null;
  snipers: number | null; // null = unknown (index too old)
  farm: number | null;
  exitedFirstHour: number | null;
  stillHolding: number | null;
  /** creator's own record; null = unknown */
  dev: { sells: number; movedTo: number; holdsBps: number | null } | null;
  /** worst reasons first (labels from the full check), at most 3 */
  reasons: { label: string; severity: string }[];
  block: number | null;
};

// main, legacy and the first curve factory (same LaunchCreated layout; see lib/chain)
const FACTORIES: Address[] = ["0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59", "0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9", "0x4febc267e0c24440bcdef72b5dbc5fe7bed091df"];
const LAUNCH_CREATED = "0x56eef5c350583250e71791d6d659f4d181796c9deb08b977252efc3995aa9279";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const FIRST = 20; // same as lib/health
const BONUS_SCAN = 50; // same as lib/health: verified-early wallets count anywhere in the first 50
const HOUR_BLOCKS = 22_000; // same as lib/health
const MIN_BUYERS = 5; // same as lib/health
const EARLY_STEP = 30_000; // the dense first window (~1.4 h)
const RESULT_TTL = 5 * 60_000;
const FAIL_TTL = 30_000;
const DEADLINE_MS = 9_000; // the route answers by then; slower tokens say "unknown" and keep filling the cache
const RPC_PARALLEL = 5;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);

/* ---------------- small plumbing ---------------- */

// one gate for every RPC call made here: at most 5 in flight per server instance
let active = 0;
const waiting: (() => void)[] = [];
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= RPC_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const unpad = (t: string) => `0x${t.slice(26)}`.toLowerCase();

type Log = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex | null };

/**
 * eth_getLogs over [from, to] in node-sized ranges picked from the filter (lib/logs: 10M blocks for one
 * address and one value per position, 100k with a list, OR-lists sent value by value when that is cheaper),
 * every request through the gate. Backs off on 429, splits a range on "too many logs".
 */
async function getLogs(filter: { address: string | string[]; topics: (string | string[] | null)[] }, from: number, to: number): Promise<Log[]> {
  return getLogsChunked<Log>(filter, from, to, (q) => gated(() => client.request({ method: "eth_getLogs", params: [q] } as never)) as Promise<Log[]>);
}

const toTransfer = (l: Log): RawTransfer => ({
  from: unpad(l.topics[1]),
  to: unpad(l.topics[2]),
  value: l.data && l.data !== "0x" ? BigInt(l.data) : 0n,
  block: Number(BigInt(l.blockNumber)),
  logIndex: Number(BigInt(l.logIndex)),
  tx: l.transactionHash ?? undefined,
  ts: 0, // the scorer never reads times
});

// head = 64 blocks behind the tip (the public RPC's nodes can lag each other: same rule as lib/chain)
let headMemo: { at: number; v: Promise<number> } | null = null;
function headBlock(): Promise<number> {
  if (headMemo && Date.now() - headMemo.at < 4_000) return headMemo.v;
  const v = gated(() => client.getBlockNumber()).then((b) => Number(b) - 64);
  v.catch(() => (headMemo = null));
  headMemo = { at: Date.now(), v };
  return v;
}

// block <-> time, for turning a createdAt hint into a narrow search range. The block time drifts over
// weeks (a flat rate missed 25-day-old launches by ~1M blocks), so the clock is a ladder of anchors every
// 2M blocks (immutable, cached for good; ~1 getBlock per 4 days of age, once per instance) plus the tip.
const STRIDE = 2_000_000;
const rungs = new Map<number, Promise<number>>(); // block -> timestamp
function rung(b: number): Promise<number> {
  let p = rungs.get(b);
  if (!p) {
    p = gated(() => client.getBlock({ blockNumber: BigInt(b) })).then((x) => Number(x.timestamp));
    p.catch(() => rungs.delete(b));
    rungs.set(b, p);
  }
  return p;
}
let tipMemo: { at: number; v: Promise<{ block: number; ts: number }> } | null = null;
function chainTip() {
  if (tipMemo && Date.now() - tipMemo.at < 10 * 60_000) return tipMemo.v;
  const v = gated(() => client.getBlock()).then((x) => ({ block: Number(x.number), ts: Number(x.timestamp) }));
  v.catch(() => (tipMemo = null));
  tipMemo = { at: Date.now(), v };
  return v;
}
/** the block that was the head at unix time `ts` (linear between the two anchors around it) */
async function blockAt(ts: number): Promise<number> {
  const tip = await chainTip();
  if (ts >= tip.ts) return tip.block;
  let hi = { b: tip.block, t: tip.ts };
  const top = Math.floor((tip.block - 1) / STRIDE);
  for (let k = top; k >= 0 && k >= top - 40; k--) {
    const b = k * STRIDE;
    const t = await rung(b);
    if (t <= ts) return Math.round(b + ((hi.b - b) * (ts - t)) / Math.max(1, hi.t - t));
    hi = { b, t };
  }
  return 0; // older than ~80 days (or a bogus hint): the caller's narrow search misses and falls back
}

/* ---------------- 1. launch events ---------------- */

type Created = { block: number; creator: string; curve: string };
const created = new Map<string, Created>(); // a launch event never changes
const notV1 = new BoundedTtlMap<true>(2_000); // no launch log in either factory (checked without a failure)

function rememberLaunch(l: Log) {
  const token = unpad(l.topics[2]);
  const c: Created = { block: Number(BigInt(l.blockNumber)), curve: unpad(l.topics[3]), creator: `0x${l.data.slice(2 + 24, 2 + 64)}`.toLowerCase() };
  if (created.size > 20_000) created.clear();
  created.set(token, c);
}

async function findLaunches(tokens: string[], hints: Map<string, number>): Promise<{ failed: Set<string> }> {
  const failed = new Set<string>();
  const todo = tokens.filter((t) => !created.has(t) && !notV1.has(t));
  if (!todo.length) return { failed };
  // with a createdAt hint: clusters of nearby launches, one OR-listed getLogs each over a narrow range
  // (the API's createdAt is the indexer's time, not the block's: ±120k blocks, ~6 h, on both sides)
  const hinted = todo.filter((t) => hints.has(t));
  if (hinted.length) {
    try {
      const tip = await chainTip();
      // warm the anchor rungs down to the oldest hint in parallel (a block is never slower than 0.15 s here,
      // so this over-reaches a little rather than falling short); the walk below then reads them from memory
      const oldest = Math.min(...hinted.map((t) => hints.get(t)!));
      const depth = Math.ceil((tip.ts - oldest) / 0.15);
      const top = Math.floor((tip.block - 1) / STRIDE);
      const bottom = Math.max(0, Math.floor((tip.block - depth) / STRIDE), top - 40);
      await Promise.allSettled(Array.from({ length: top - bottom + 1 }, (_, i) => rung((top - i) * STRIDE)));
      const est: { t: string; b: number }[] = [];
      for (const t of hinted) est.push({ t, b: await blockAt(hints.get(t)!) }); // sequential: the rungs are shared
      est.sort((a, b) => a.b - b.b);
      const MARGIN = 120_000;
      const clusters: { lo: number; hi: number; ts: string[] }[] = [];
      for (const e of est) {
        const last = clusters[clusters.length - 1];
        if (last && e.b - MARGIN <= last.hi + 1 && e.b + MARGIN - last.lo <= 600_000 && last.ts.length < SIGNALS_MAX) {
          last.hi = e.b + MARGIN;
          last.ts.push(e.t);
        } else clusters.push({ lo: e.b - MARGIN, hi: e.b + MARGIN, ts: [e.t] });
      }
      await Promise.all(
        clusters.map(async (c) => {
          try {
            const logs = await getLogs({ address: FACTORIES, topics: [LAUNCH_CREATED, null, c.ts.map(pad)] }, Math.max(0, c.lo), Math.min(tip.block, c.hi));
            for (const l of logs) rememberLaunch(l);
          } catch {
            // the per-token pass below picks these up
          }
        }),
      );
    } catch {
      // no clock: per token below
    }
  }
  // anything still unknown: one full-history getLogs per factory (~0.2 s each), 5 at a time
  const rest = todo.filter((t) => !created.has(t));
  await Promise.all(
    rest.map(async (t) => {
      try {
        // whole history in node-sized slices, newest first (the node caps a getLogs at 10M blocks)
        const l = (await gated(() => launchLog(t))) as Log | null;
        if (l) {
          rememberLaunch(l);
          return;
        }
        notV1.set(t, true, 60 * 60_000);
      } catch {
        failed.add(t);
      }
    }),
  );
  return { failed };
}

/* ---------------- 2. the start of the line ---------------- */

type Early = {
  raw: RawTransfer[]; // the dense window, then (sparse mode) buys + the first buyers' own transfers
  to: number; // buys are known up to this block
  sparse: boolean;
  buyers: string[];
  firstBuy: Map<string, number>;
  done: boolean;
};
const early = new BoundedTtlMap<Early>(800);

const isPlumbing = (a: string, curve: string) => a === curve || PLUMBING_SET.has(a);
const PLUMBING_SET = new Set<string>([ZERO, ...PLUMBING]);
const SPARSE_CHUNK = 2_000_000; // buys-only ranges (~4 days each), scanned in order until enough buyers are in

/**
 * The start of the line, two ways:
 * - dense: every transfer of the first ~1.4 h after the launch (one getLogs). Most launches have their first
 *   20 buyers and the hour after the 20th inside it: done in one call.
 * - sparse (a slow start): buys only (transfers out of the curve or the V4 pool) in 2M-block ranges until 50
 *   buyers are in or the head is reached, then the first 20 buyers' own transfers (in and out) up to an hour
 *   after the 20th buy: their bags, peaks and exits replay exactly as in the full history.
 */
async function earlyWindow(token: string, c: Created, head: number): Promise<Early> {
  let e = early.get(token);
  if (!e) e = { raw: [], to: c.block - 1, sparse: false, buyers: [], firstBuy: new Map(), done: false };
  if (e.done) return e;
  const take = (list: RawTransfer[]) => {
    for (const r of list) {
      if (r.value <= 0n || (r.from !== c.curve && r.from !== POOL_MANAGER)) continue;
      if (r.to === c.creator || isPlumbing(r.to, c.curve) || e!.firstBuy.has(r.to)) continue;
      e!.firstBuy.set(r.to, r.block);
      e!.buyers.push(r.to);
    }
  };
  const sorted = (logs: Log[]) => logs.map(toTransfer).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const coverTo = () => (e!.buyers.length >= FIRST ? e!.firstBuy.get(e!.buyers[FIRST - 1])! + HOUR_BLOCKS : null);

  if (!e.sparse) {
    // dense: everything from the launch on, while the line is still within its first window (or young)
    const to = Math.min(head, Math.max(e.to, coverTo() ?? c.block + EARLY_STEP - 1));
    if (to > e.to) {
      const fresh = sorted(await getLogs({ address: token, topics: [TRANSFER] }, e.to + 1, to));
      take(fresh);
      e.raw.push(...fresh);
      e.to = to;
    }
    const cover = coverTo();
    if (cover !== null && e.to >= cover) e.done = true;
    else if (e.to - c.block + 1 >= EARLY_STEP && e.to < head) e.sparse = true; // a slow start: switch
  }
  if (e.sparse && !e.done) {
    // buys only, in order, until 50 buyers (the verified-early bonus reach) or the head
    while (e.to < head && e.buyers.length < BONUS_SCAN) {
      const to = Math.min(head, e.to + SPARSE_CHUNK);
      const buys = sorted(await getLogs({ address: token, topics: [TRANSFER, [pad(c.curve), pad(POOL_MANAGER)]] }, e.to + 1, to));
      take(buys);
      e.raw.push(...buys);
      e.to = to;
    }
    // the first 20 buyers' own transfers (in and out) from the launch to an hour after the 20th buy
    const first = e.buyers.slice(0, FIRST);
    const until = Math.min(head, coverTo() ?? head);
    if (first.length) {
      const [outs, ins] = await Promise.all([
        getLogs({ address: token, topics: [TRANSFER, first.map(pad)] }, c.block, until),
        getLogs({ address: token, topics: [TRANSFER, null, first.map(pad)] }, c.block, until),
      ]);
      e.raw = dedupe([...e.raw, ...outs.map(toTransfer), ...ins.map(toTransfer)]);
    }
    const cover = coverTo();
    if (cover !== null && until >= cover && (e.buyers.length >= BONUS_SCAN || e.to >= head)) e.done = true;
  }
  if (e.done) compact(e, c);
  early.set(token, e, e.done ? 24 * 3600_000 : 10 * 60_000);
  return e;
}

/**
 * A finished start keeps only what the scorer reads: every transfer of the first 20 buyers (bags, peaks,
 * exits) and the first buy of each of the first 50 (entry order, the verified-early bonus). A hot launch's
 * first hour can hold thousands of transfers; this keeps a cached line to a few hundred.
 */
function compact(e: Early, c: Created) {
  const keep = new Set(e.buyers.slice(0, FIRST));
  const firstAt = new Map(e.buyers.slice(0, BONUS_SCAN).map((w) => [w, e.firstBuy.get(w)!]));
  e.raw = e.raw.filter((r) => keep.has(r.from) || keep.has(r.to) || ((r.from === c.curve || r.from === POOL_MANAGER) && firstAt.get(r.to) === r.block));
}

function dedupe(list: RawTransfer[]): RawTransfer[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = `${r.tx ?? ""}:${r.block}:${r.logIndex}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/* ---------------- 3. the creator's transfers out (whole history, one call per batch) ---------------- */

type DevLog = { raw: RawTransfer[]; to: number };
const devLogs = new BoundedTtlMap<DevLog>(1_500);

async function devTransfers(items: { token: string; c: Created }[], head: number): Promise<Map<string, DevLog>> {
  const out = new Map<string, DevLog>();
  const need: { token: string; c: Created; d: DevLog }[] = [];
  for (const it of items) {
    const d = devLogs.get(it.token) ?? { raw: [], to: it.c.block - 1 };
    if (d.to >= head) out.set(it.token, d);
    else need.push({ ...it, d });
  }
  if (!need.length) return out;
  const from = Math.min(...need.map((n) => n.d.to + 1));
  const creators = [...new Set(need.map((n) => n.c.creator).filter(Boolean))];
  // an address list is capped at 100k blocks per request; one single-valued request per token (its own creator)
  // covers 9.5M: take whichever needs fewer requests
  const listCost = Math.ceil((head - from + 1) / SPAN_LIST);
  const perToken = need.filter((n) => n.c.creator);
  const pairCost = perToken.reduce((s, n) => s + Math.ceil((head - n.d.to) / SPAN_SINGLE), 0);
  const logs =
    pairCost < listCost
      ? (await Promise.all(perToken.map((n) => getLogs({ address: n.token, topics: [TRANSFER, pad(n.c.creator)] }, n.d.to + 1, head)))).flat()
      : await getLogs({ address: need.map((n) => n.token), topics: [TRANSFER, creators.map(pad)] }, from, head);
  const by = new Map(need.map((n) => [n.token, n]));
  for (const l of logs) {
    const n = by.get(l.address.toLowerCase());
    if (!n) continue;
    const r = toTransfer(l);
    if (r.from !== n.c.creator || r.block <= n.d.to) continue; // another creator's token in the cross product, or already had it
    n.d.raw.push(r);
  }
  for (const n of need) {
    n.d.to = head;
    devLogs.set(n.token, n.d, 24 * 3600_000);
    out.set(n.token, n.d);
  }
  return out;
}

/* ---------------- 4. today's bags (multicall, batched across tokens) ---------------- */

const supplyOf = new Map<string, bigint>(); // fixed supply

// Tokens finish their own reads at different times: their balance asks are pooled for 40 ms and sent as
// one multicall (~150 calls per eth_call), so a board of 30 costs a handful of calls, not 30.
type BagAsk = { token: string; wallets: string[]; head: number; done: (m: Map<string, bigint | null> | null) => void };
let bagQueue: BagAsk[] = [];
let bagTimer: ReturnType<typeof setTimeout> | null = null;

function bagsOf(token: string, wallets: string[], head: number): Promise<Map<string, bigint | null> | null> {
  return new Promise((done) => {
    bagQueue.push({ token, wallets, head, done });
    if (!bagTimer) bagTimer = setTimeout(flushBags, 40);
  });
}

function flushBags() {
  const asks = bagQueue;
  bagQueue = [];
  bagTimer = null;
  const byHead = new Map<number, BagAsk[]>();
  for (const a of asks) byHead.set(a.head, [...(byHead.get(a.head) ?? []), a]);
  for (const [head, group] of byHead) void multicallBags(group, head);
}

async function multicallBags(asks: BagAsk[], head: number) {
  type Call = { token: string; wallet: string | null };
  const calls: Call[] = [];
  const contracts: { address: Address; abi: typeof erc20; functionName: "balanceOf" | "totalSupply"; args?: [Address] }[] = [];
  for (const it of asks) {
    for (const w of it.wallets) {
      calls.push({ token: it.token, wallet: w });
      contracts.push({ address: it.token as Address, abi: erc20, functionName: "balanceOf", args: [w as Address] });
    }
    if (!supplyOf.has(it.token)) {
      calls.push({ token: it.token, wallet: null });
      contracts.push({ address: it.token as Address, abi: erc20, functionName: "totalSupply" });
    }
  }
  try {
    const res = (await gated(() =>
      client.multicall({ contracts: contracts as never, allowFailure: true, blockNumber: BigInt(head), batchSize: 16_384 }),
    )) as { status: "success" | "failure"; result?: unknown }[];
    const out = new Map<string, Map<string, bigint | null>>();
    res.forEach((r, i) => {
      const c = calls[i];
      const v = r.status === "success" ? (r.result as bigint) : null;
      if (c.wallet === null) {
        if (v !== null && v > 0n) supplyOf.set(c.token, v);
        return;
      }
      let m = out.get(c.token);
      if (!m) out.set(c.token, (m = new Map()));
      m.set(c.wallet, v);
    });
    if (supplyOf.size > 20_000) supplyOf.clear();
    for (const a of asks) a.done(out.get(a.token) ?? new Map());
  } catch {
    for (const a of asks) a.done(null); // today's bags unknown: retention and the dev's bag say so
  }
}

/* ---------------- scoring ---------------- */

function score(token: string, c: Created, e: Early, d: DevLog, bags: Map<string, bigint | null> | undefined, head: number): TokenSignal {
  const plumbing = new Set<string>([...PLUMBING_SET, c.curve]);
  // the start of the line + every creator transfer after it (deduped on tx+log index)
  const seen = new Set<string>();
  const raw: RawTransfer[] = [];
  for (const r of [...e.raw, ...d.raw]) {
    const k = `${r.tx ?? ""}:${r.block}:${r.logIndex}`;
    if (seen.has(k)) continue;
    seen.add(k);
    raw.push(r);
  }
  raw.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  // replayed bags of the first buyers (the scorer's own rule: people only, never below zero)
  const first = e.buyers.slice(0, FIRST);
  const want = new Set(first);
  const bal = new Map<string, bigint>();
  for (const r of raw) {
    if (r.value <= 0n) continue;
    if (want.has(r.to) && !plumbing.has(r.to)) bal.set(r.to, (bal.get(r.to) ?? 0n) + r.value);
    if (want.has(r.from) && !plumbing.has(r.from)) {
      const nb = (bal.get(r.from) ?? 0n) - r.value;
      bal.set(r.from, nb < 0n ? 0n : nb);
    }
  }
  // today's bags at the same head block: the gap becomes one synthetic transfer from/to the zero address
  // (zero is plumbing, so it never counts as a buy, a sell to the market or a dev move)
  let bagsKnown = !!bags;
  let k = 0;
  for (const w of first) {
    const now = bags?.get(w);
    if (now === undefined || now === null) {
      bagsKnown = false;
      continue;
    }
    const was = bal.get(w) ?? 0n;
    if (now === was) continue;
    raw.push(
      now > was
        ? { from: ZERO, to: w, value: now - was, block: head, logIndex: 1_000_000 + k++, ts: 0 }
        : { from: w, to: ZERO, value: was - now, block: head, logIndex: 1_000_000 + k++, ts: 0 },
    );
  }
  const h = computeHealth(
    { token, creator: c.creator, curve: c.curve, raw, plumbing, complete: true, headBlock: head, nowSec: Math.floor(Date.now() / 1000) },
    earlyIndex(),
  );
  const devReason = h.reasons.find((r) => r.id === "dev");
  // the scorer's dev numbers, recounted from the same light log (it only exposes them in prose)
  let sells = 0;
  const movedTo = new Set<string>();
  const sellTx = new Set<string>();
  for (const r of d.raw) if ((r.to === c.curve || plumbing.has(r.to)) && r.tx) sellTx.add(r.tx);
  for (const r of d.raw) {
    if (r.value <= 0n || r.from !== c.creator) continue;
    if (r.to === c.curve || plumbing.has(r.to)) sells++;
    else if (!(r.tx && sellTx.has(r.tx))) movedTo.add(r.to);
  }
  const devBag = bags?.get(c.creator);
  const supply = supplyOf.get(token);
  const holdsBps = devBag !== undefined && devBag !== null && supply ? Number((devBag * 10_000n) / supply) : null;
  const formed = first.length >= MIN_BUYERS;
  const stillHolding = bagsKnown ? h.counts.stillHolding : null;
  return {
    token,
    status: formed ? "ok" : "early",
    grade: formed ? h.grade : null,
    score: formed ? h.score : null,
    partial: h.partial || !bagsKnown,
    firstBuyers: first.length,
    snipers: formed ? h.counts.snipers : null,
    farm: formed ? h.counts.farm : null,
    exitedFirstHour: formed ? h.counts.exitedFirstHour : null,
    stillHolding: formed ? stillHolding : null,
    dev: devReason && devReason.severity !== "unknown" ? { sells, movedTo: movedTo.size, holdsBps } : null,
    reasons: h.reasons
      .filter((r) => r.severity !== "unknown" && r.severity !== "good" && r.severity !== "info")
      .slice(0, 3)
      .map((r) => ({ label: r.label, severity: r.severity })),
    block: head,
  };
}

/* ---------------- the batch ---------------- */

const results = new BoundedTtlMap<TokenSignal>(3_000);
const running = new Map<string, Promise<TokenSignal>>();

const unknown = (token: string): TokenSignal => ({
  token, status: "unknown", grade: null, score: null, partial: true, firstBuyers: null, snipers: null, farm: null,
  exitedFirstHour: null, stillHolding: null, dev: null, reasons: [], block: null,
});

/** one shared pass per batch (head, launch events, the creators' log), then every token finishes on its own */
function computeBatch(tokens: string[], hints: Map<string, number>): Map<string, Promise<TokenSignal>> {
  const base = (async () => {
    const head = await headBlock();
    const { failed } = await findLaunches(tokens, hints);
    const live = tokens.flatMap((t) => (created.has(t) ? [{ token: t, c: created.get(t)! }] : []));
    const devs = devTransfers(live, head).catch(() => null);
    return { head, failed, devs };
  })();
  base.catch(() => {});
  return new Map(
    tokens.map((t) => [
      t,
      (async (): Promise<TokenSignal> => {
        const { head, failed, devs } = await base;
        const c = created.get(t);
        if (!c) return failed.has(t) ? unknown(t) : { ...unknown(t), status: "not_v1" };
        const e = await earlyWindow(t, c, head);
        const d = (await devs)?.get(t);
        if (!d) return unknown(t);
        const bags = await bagsOf(t, [...e.buyers.slice(0, FIRST), ...(c.creator ? [c.creator] : [])], head);
        return score(t, c, e, d, bags ?? undefined, head);
      })(),
    ]),
  );
}

/**
 * Signals for up to 30 tokens. Cached 5 min per token (a failure: 30 s). Answers within ~9 s: tokens not
 * done by then come back "unknown" and finish behind the answer (`rest`) for the next ask.
 */
export async function boardSignals(rawTokens: string[], hints: Map<string, number> = new Map()): Promise<{ items: TokenSignal[]; rest: Promise<unknown> }> {
  const tokens = [...new Set(rawTokens.map((t) => t.toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)))].slice(0, SIGNALS_MAX);
  const have = new Map<string, TokenSignal>();
  const todo: string[] = [];
  const waits: Promise<void>[] = [];
  for (const t of tokens) {
    const hit = results.get(t);
    if (hit) have.set(t, hit);
    else if (running.has(t)) waits.push(running.get(t)!.then((v) => void have.set(t, v), () => void have.set(t, unknown(t))));
    else todo.push(t);
  }
  if (todo.length) {
    const jobs = computeBatch(todo, hints);
    for (const t of todo) {
      const p = jobs.get(t)!;
      running.set(t, p);
      p.then(
        (v) => results.set(t, v, v.status === "unknown" ? FAIL_TTL : v.status === "not_v1" ? 60 * 60_000 : RESULT_TTL),
        () => results.set(t, unknown(t), FAIL_TTL),
      ).finally(() => running.delete(t));
      waits.push(p.then((v) => void have.set(t, v), () => void have.set(t, unknown(t))));
    }
  }
  const all = Promise.all(waits);
  await Promise.race([all, sleep(DEADLINE_MS)]);
  // `rest`: the caller keeps the function alive until the slow ones land in the cache (next.js after())
  return { items: tokens.map((t) => have.get(t) ?? unknown(t)), rest: all };
}

export function indexInfo(): { ageSec: number; windowDays: number } {
  const ix = earlyIndex();
  return { ageSec: Math.max(0, Math.floor(Date.now() / 1000) - ix.generatedAt), windowDays: ix.windowDays };
}
