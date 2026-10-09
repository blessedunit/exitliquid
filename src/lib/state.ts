// State of vibe: independent launchpad statistics for /state.
//
// Chain first. Launch counts, graduations, time to the door, top devs and the sniper sample come from
// factory and curve logs on the Robinhood Chain testnet (eth_getLogs). The vibe API adds what the chain
// can't give cheaply: progress buckets (its own counts), 24 h volumes and post-graduation candles.
//
// Measured 01.10.2026 (scratch probes, see the /state "Method" panel):
// - four live launch factories. Three curve factories emit LaunchCreated(id, token, curve; creator in data),
//   the taxed v6 factory its own LaunchCreated(id, launcher, token; curve in data).
// - a curve's graduation is one log from the curve itself (v1 topic G1, v6 topic G6). Anyone can emit those
//   topics from any contract, so a graduation only counts when its emitter is a curve a factory created.
//   Since 05.10.2026 those logs can only be read topic-only (30,000 blocks a call): graduations are read from the
//   V4 PoolManager's Initialize log of the same tx instead (one address, see POOL_INIT below).
// - the vibe API lists only some factories (legacy and first-factory launches are missing from /launches
//   and /launches/cards, /launches/<token> still answers): API-only numbers say "vibe-listed".
// - full factory history = ~205k logs, ~130 getLogs calls on the public node (10k logs per answer cap,
//   "query timed out" on dense ranges -> split). It is pulled once per server instance and then only the
//   new blocks; the finished snapshot also goes to Redis so a cold instance answers at once.
// Unknown is never zero: every block is null with a reason when its source did not answer.
import "server-only";
import { parseAbi, type Address, type Hex } from "viem";
import { client, cleanText } from "./chain";
import { CHAIN_ID } from "./config";
import { PLUMBING } from "./service";
import { redis, storeKind } from "./store";
import { earlyIndex, perIndex } from "@/lib/earlyIndex";

/* ------------------------------------------------------------------ wire types (the page imports these) */

export type Src = { src: string; asOf: number | null; note?: string };

export type DayRow = {
  day: number; // UTC midnight, unix seconds
  partial: boolean; // today: counted so far
  launches: { curve: number; taxed: number } | null; // null = a factory's log could not be read
  grads: { curve: number; taxed: number } | null;
};

export type FactoryRow = {
  id: string;
  label: string;
  kind: "curve" | "taxed";
  address: string;
  launches: number;
  launches7d: number;
  grads: number;
  grads7d: number;
};

export type DevRow = {
  creator: string;
  grads: number; // all time (factory history)
  grads7d: number;
  launches: number; // all time
  lastToken: string | null; // the dev's latest graduated token
  lastSymbol: string | null;
  unlisted?: number; // launches on factories vibe's lists leave out (first, legacy): /dev reads those from the chain
};

export type VolRow = {
  token: string;
  symbol: string;
  name: string;
  volume24hEth: number;
  graduated: boolean;
  progressBps: number | null;
  taxed: boolean;
};

export type DoorRow = {
  token: string;
  symbol: string | null;
  gradTs: number;
  ret1h: number | null; // price change vs the pool's opening price; null = not an hour old yet / unknown
  ret24h: number | null;
  trades24h: number | null;
  traded1h?: boolean | null; // false = no swap in the first hour (ret1h is then 0 by construction)
};

export type StateSnapshot = {
  v: 1;
  builtAt: number; // unix seconds
  buildMs: number;
  headBlock: number;
  headTs: number;
  windowStart: number; // UTC midnight 6 days ago (7 days incl. today)
  days: DayRow[] | null;
  daysSrc: Src;
  totals: {
    launches7d: number | null;
    grads7d: number | null;
    cohort: { launched: number; graduated: number } | null; // tokens launched in the window that already graduated
    allTime: { launches: number; grads: number } | null;
    factories: FactoryRow[] | null;
  };
  ttg: {
    n: number;
    medianS: number;
    p25S: number;
    p75S: number;
    fastestS: number;
    buckets: { label: string; n: number }[];
  } | null;
  ttgSrc: Src;
  progress: { buckets: { label: string; count: number | null }[]; total: number | null } | null;
  progressSrc: Src;
  snipers: {
    sampled: number;
    formed: number; // >= 5 distinct buyers in the first hour
    withFive: number; // formed lines with >= 5 known snipers in the first 20 buyers
    withFarm: number; // formed lines with >= 3 wallets of one farm group in the first 20
    medianSnipers: number | null; // known snipers in the first 20, median over formed lines
    dist: { label: string; n: number }[];
    indexBuiltAt: number;
    indexStale: boolean;
    indexSnipers: number;
    indexFarms: number;
  } | null;
  snipersSrc: Src;
  devs: { all: DevRow[]; week: DevRow[] } | null;
  devsSrc: Src;
  volumes: { rows: VolRow[]; scanned: number; total: number } | null;
  volumesSrc: Src;
  door: {
    n1h: number; // tokens with a +1h reading (one per dev)
    n24h: number; // tokens with a +24h reading (one per dev)
    median1h: number | null; // over pools that traded in the first hour (an untraded pool sits at the open by construction)
    traded1h?: number; // of n1h, pools with a swap in the first hour
    noTrade1h?: number | null; // share of n1h with no swap in the first hour
    raw1h?: number; // graduations read before the one-per-dev cut
    raw24h?: number;
    median24h: number | null;
    up24h: number | null; // share of tokens above the opening price after 24 h
    dead24h: number | null; // share with no trade at all in the first 24 h
    rows: DoorRow[];
  } | null;
  doorSrc: Src;
  notes: string[];
};

/* ------------------------------------------------------------------ constants */

const DAY = 86_400;
const BLOCK_S = 0.165; // measured 24.09 and 01.10
const HOUR_BLOCKS = Math.round(3600 / BLOCK_S);
const SAFE_LAG = 64n; // stay behind the head: the public RPC's load-balanced nodes can lag each other

const LC_V1 = "0x56eef5c350583250e71791d6d659f4d181796c9deb08b977252efc3995aa9279" as Hex;
const LC_V6 = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8" as Hex;
// A graduation opens the token's Uniswap V4 pool: PoolManager.Initialize(id, currency0, currency1; fee, tickSpacing,
// hooks, sqrtPriceX96, tick) in the same tx as the curve's own graduation log (checked 05.10.2026: 555 of 556 curve
// graduation logs over 1.8M blocks; the one without was emitted by a contract no factory created). The curve logs
// can only be read topic-only now (node cap 30,000 blocks: ~1,100 calls for the history), the PoolManager one
// address-filtered (10M blocks a call). A pool counts as a graduation when its token is a factory launch and its
// hook is one of vibe's: anyone can open another pool for a vibe token, only the adapter opens it with these.
// vibe has used several hooks (a taxed v6 one appeared mid-run): a hook not known yet is checked once on its first
// pool of a vibe token (did that block carry the curve's own graduation log?) and remembered either way.
const POOL_INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as Hex;
const G_V1 = "0xc1eaf6441a62895ddec3612cee606bd971cf6b1b38dd700f103e7b6b94167d0c" as Hex; // curve: graduated (poolId; eth, tokens)
const G_V6 = "0xab164bba6f9a29b6722f18be5ea821368fedba444c4f8733118f3557d77ab2ae" as Hex; // v6 curve: graduated
const GRAD_HOOKS = new Set([
  "0x30534b7601878e2043335c4bf99b4c50a75b90cc", // first factory era (Aug-Sep 2026)
  "0xc5b22f31f247a6ee33592792d44bde31c0ef10cc", // legacy fee hook
  "0x2779651fee12f6fb5a187578de6b63709f85d0cc", // fee hook (main factory)
  "0xa5e27e3e54739162fe52c2c48e55b6dd6572e8ec", // taxed v6
]);
const INIT_WINDOW = 4_000_000; // ~9.5k pool inits per 9.5M blocks at the densest: stay well under the 10k-log answer cap
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";

type Factory = { id: string; label: string; kind: "curve" | "taxed"; address: string; from: number };
// `from` = a little before the factory's first LaunchCreated (measured 01.10)
const FACTORIES: Factory[] = [
  { id: "first", label: "Curve · first factory", kind: "curve", address: "0x4febc267e0c24440bcdef72b5dbc5fe7bed091df", from: 95_900_000 },
  { id: "legacy", label: "Curve · legacy factory", kind: "curve", address: "0xb5b7a2f6c4eafa2d73918fca32d50e2126339eb9", from: 108_900_000 },
  { id: "main", label: "Curve · main factory", kind: "curve", address: "0x40f1be6faf8dab9c143cce1a0a04c2075fb2df59", from: 115_400_000 },
  { id: "v6", label: "Taxed v6 factory", kind: "taxed", address: "0xe794217880011f9ca6961340ed5c16ec9559fea0", from: 126_000_000 },
];
const GRAD_FROM = 95_900_000;

const API = (process.env.STATE_VIBE_API || `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`).replace(/\/$/, "");
const API_HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "Mozilla/5.0" };

const FRESH_MS = 15 * 60_000; // a snapshot younger than this is served as is
const REDIS_KEY = "exit:state:v1";
const SAMPLE_PER_DAY = 24; // sniper sample: launches per UTC day, spread evenly through the day
const SAMPLE_NEW_MAX = 200; // new first-hour reads per build (later builds add the rest)
const DOOR_MAX_1H = 40; // after-the-door sample: the newest curve graduations at least an hour old ...
const DOOR_MAX_24H = 80; // ... and the newest at least a day old (one pool-swap read each, kept once a day old)
const DOOR_NEW_MAX = 120;
const BATCH_BLOCKS = Math.round(120 / BLOCK_S); // graduations within 2 min of each other count once in the door stats
const VOL_DETAIL = 12; // per-token reads for the newest graduations (not on vibe's lists)

const INDEX_MAX_AGE = 14 * DAY;

/* ------------------------------------------------------------------ module state (incremental) */

type Launch = { b: number; token: string; curve: string; creator: string; f: number };
type Grad = { b: number; curve: string; p0: number; v6: boolean; pool: string }; // pool = V4 poolId; p0 = ETH per token at the pool's open

const launches: Launch[][] = FACTORIES.map(() => []);
// factories whose launches vibe's /launches lists leave out (incl. ?creatorAddress=, checked 01.10 on
// 0x4b78…9009: 709 first-factory launches, vibe totalCount 0); /launches/<token> still answers for them
const UNLISTED = new Set(["first", "legacy"]);
const byCurve = new Map<string, Launch>();
const byToken = new Map<string, Launch>();
const nextBlock = FACTORIES.map((f) => f.from);
const grads: Grad[] = [];
const gradSeen = new Set<string>(); // curve: a curve graduates once (dedupe re-reads)
const hookIsVibe = new Map<string, boolean>([...GRAD_HOOKS].map((h) => [h, true])); // learned per instance
let gradNext = GRAD_FROM;
const anchors: [number, number][] = []; // [block, ts] sorted
const boundaryCache = new Map<number, number>(); // utc midnight -> first block at/after it
const symbols = new Map<string, string>();
type Front = { buyers: number; snipers: number; farmMax: number };
const fronts = new Map<string, Front>(); // token -> first-hour front of the line (immutable once read)
type DoorRead = { ret1h: number | null; ret24h: number | null; trades24h: number | null; traded1h: boolean | null; ripe: boolean; at: number };
const doors = new Map<string, DoorRead>();

// creator -> "launches,grads,unlisted" over the whole factory history (built with the devs table)
let devIndex: Map<string, string> | null = null;
let devIndexAsOf = 0;
let devIndexSavedAt = 0;
// route handlers and pages can get separate copies of this module in one process: share the index through
// globalThis so /dev sees what /api/state built even without Redis
const SHARED = globalThis as { __exitDevIndex?: { map: Map<string, string>; asOf: number } };
const DEV_INDEX_KEY = "exit:state:devidx:v1";
const DEV_INDEX_SAVE_MS = 60 * 60_000; // the hash is ~10k fields: rewrite it at most hourly

let snapshot: StateSnapshot | null = null;
let building: Promise<StateSnapshot> | null = null;
let stage = "idle";

/* ------------------------------------------------------------------ small helpers */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16)}` as Hex;
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const addrOf = (word: string) => `0x${word.slice(-40)}`.toLowerCase();
// viem errors can carry an empty `details`: read every field, or a 429 / size error looks like "nothing" and is never retried
const errMsg = (e: unknown) => {
  const x = e as { details?: string; shortMessage?: string; message?: string };
  return [x?.details, x?.shortMessage, x?.message].filter(Boolean).join(" | ") || String(e);
};
const isRate = (m: string) => /429|rate limit|too many requests/i.test(m);
// node: "exceeds limit of 10000", "log query timed out"; viem: "response body exceeded the size limit" (10 MB cap,
// ~10k launch logs pass it), "took too long to respond" (20 s client timeout)
const isBig = (m: string) => /exceeds limit|timed out|timeout|took too long|too many (logs|results)|range|size limit/i.test(m);

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const median = (xs: number[]) => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null);

/* ------------------------------------------------------------------ RPC */

type RawLog = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex };
type Filter = { address?: string; topics: (Hex | Hex[] | null)[] };

/** One range; 429 -> back off, "too big / timed out" -> split in half. Throws when a single block still fails. */
async function getLogs(f: Filter, a: number, b: number, out: RawLog[], attempt = 0, depth = 0): Promise<void> {
  try {
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [{ ...(f.address ? { address: f.address } : {}), topics: f.topics, fromBlock: hex(a), toBlock: hex(b) }],
    } as never)) as RawLog[];
    for (const l of logs) out.push(l); // no spread: a window can hold ~100k logs (call stack limit)
  } catch (e) {
    const m = errMsg(e);
    if (isRate(m) && attempt < 6) {
      await sleep(500 * 2 ** attempt + Math.random() * 300);
      return getLogs(f, a, b, out, attempt + 1, depth);
    }
    if (isBig(m) && b > a && depth < 24) {
      const mid = Math.floor((a + b) / 2);
      await getLogs(f, a, mid, out, 0, depth + 1);
      await getLogs(f, mid + 1, b, out, 0, depth + 1);
      return;
    }
    throw e;
  }
}

/**
 * [from, to] in fixed windows, 3 in flight. Returns the logs of the longest run of windows that all
 * succeeded from `from` on, and the next block to read: a failed window is read again next build,
 * never skipped (a skipped window would undercount for good).
 */
let lastRpcError = "";
async function pullWindows(f: Filter, from: number, to: number, window = 2_000_000): Promise<{ logs: RawLog[]; next: number }> {
  if (from > to) return { logs: [], next: from };
  const wins: [number, number][] = [];
  for (let s = from; s <= to; s += window) wins.push([s, Math.min(to, s + window - 1)]);
  const parts: (RawLog[] | null)[] = await pool(wins, 3, async ([a, b]) => {
    const out: RawLog[] = [];
    try {
      await getLogs(f, a, b, out);
      return out;
    } catch (e) {
      lastRpcError = errMsg(e).split(/\r?\n/)[0].slice(0, 120);
      return null;
    }
  });
  const logs: RawLog[] = [];
  let next = from;
  for (let i = 0; i < wins.length; i++) {
    const p = parts[i];
    if (!p) break;
    for (const l of p) logs.push(l);
    next = wins[i][1] + 1;
  }
  return { logs, next };
}

async function blockTs(b: number, attempt = 0): Promise<number> {
  try {
    const blk = await client.getBlock({ blockNumber: BigInt(b) });
    return Number(blk.timestamp);
  } catch (e) {
    if (attempt < 4) {
      await sleep(400 * 2 ** attempt);
      return blockTs(b, attempt + 1);
    }
    throw e;
  }
}

function addAnchor(b: number, ts: number) {
  const i = anchors.findIndex((a) => a[0] >= b);
  if (i >= 0 && anchors[i][0] === b) return;
  if (i < 0) anchors.push([b, ts]);
  else anchors.splice(i, 0, [b, ts]);
}

/** Timestamp of a block, interpolated between measured anchors (blocks are ~0.165 s, but not exactly). */
function tsOf(b: number): number {
  if (!anchors.length) return 0;
  let lo = 0;
  let hi = anchors.length - 1;
  if (b <= anchors[0][0]) return Math.round(anchors[0][1] - (anchors[0][0] - b) * BLOCK_S);
  if (b >= anchors[hi][0]) return Math.round(anchors[hi][1] + (b - anchors[hi][0]) * BLOCK_S);
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (anchors[m][0] <= b) lo = m;
    else hi = m;
  }
  const [b0, t0] = anchors[lo];
  const [b1, t1] = anchors[hi];
  return Math.round(t0 + ((t1 - t0) * (b - b0)) / Math.max(1, b1 - b0));
}

/** Anchors every 1M blocks over the whole history (immutable: read once per instance). */
async function ensureAnchors(head: number) {
  const want: number[] = [];
  for (let b = 95_000_000; b < head; b += 1_000_000) want.push(b);
  const have = new Set(anchors.map((a) => a[0]));
  const missing = want.filter((b) => !have.has(b));
  await pool(missing, 4, async (b) => addAnchor(b, await blockTs(b)));
}

/** First block whose timestamp is >= ts (secant steps on measured blocks; exact to a few blocks). */
async function blockAt(ts: number, head: number, headTs: number): Promise<number> {
  const hit = boundaryCache.get(ts);
  if (hit !== undefined) return hit;
  let b = Math.min(head, Math.max(1, Math.round(head - (headTs - ts) / BLOCK_S)));
  // start from the anchors' guess, then correct with the real timestamp of the guessed block
  const guess = anchors.length ? tsOf(b) : headTs;
  b = Math.min(head, Math.max(1, Math.round(b - (guess - ts) / BLOCK_S)));
  for (let i = 0; i < 4; i++) {
    const t = await blockTs(b);
    addAnchor(b, t);
    const d = t - ts;
    if (Math.abs(d) <= 1) break;
    b = Math.min(head, Math.max(1, Math.round(b - d / BLOCK_S)));
  }
  if (ts < headTs - 3600) boundaryCache.set(ts, b); // a past midnight never moves
  return b;
}

/* ------------------------------------------------------------------ chain sync */

async function syncFactories(to: number): Promise<boolean[]> {
  const ok: boolean[] = [];
  for (let i = 0; i < FACTORIES.length; i++) {
    const f = FACTORIES[i];
    try {
      const v6 = f.kind === "taxed";
      // a window that failed (429 storm, node timeout) is read again right away, up to 3 more passes,
      // as long as each pass gets further: a cold history read should finish in one build
      const logs: RawLog[] = [];
      let next = nextBlock[i];
      for (let pass = 0; pass < 4 && next <= to; pass++) {
        const r = await pullWindows({ address: f.address, topics: [v6 ? LC_V6 : LC_V1] }, next, to);
        for (const l of r.logs) logs.push(l);
        if (r.next === next) await sleep(1_500);
        next = r.next;
      }
      for (const l of logs) {
        if (l.topics.length < 4) continue;
        const b = Number(BigInt(l.blockNumber));
        const L: Launch = v6
          ? { b, token: addrOf(l.topics[3]), curve: addrOf(l.data.slice(2, 66)), creator: addrOf(l.topics[2]), f: i }
          : { b, token: addrOf(l.topics[2]), curve: addrOf(l.topics[3]), creator: addrOf(l.data.slice(2, 66)), f: i };
        if (byCurve.has(L.curve)) continue;
        byCurve.set(L.curve, L);
        byToken.set(L.token, L);
        launches[i].push(L);
      }
      launches[i].sort((x, y) => x.b - y.b);
      nextBlock[i] = next;
      ok.push(next > to);
      if (next <= to && !lastRpcError) lastRpcError = `${f.id}: stopped at block ${next} of ${to}`;
    } catch (e) {
      lastRpcError = `${f.id}: ${errMsg(e).slice(0, 100)}`;
      ok.push(false);
    }
  }
  return ok;
}

async function syncGrads(to: number): Promise<{ v1: boolean; v6: boolean }> {
  // a pool init only counts once its token's launch is known: read no further than every factory has
  const upTo = Math.min(to, ...nextBlock.map((n) => n - 1));
  /** Takes the logs in block order; returns the block to read again from when a hook check failed (else null). */
  const take = async (logs: RawLog[]): Promise<number | null> => {
    const sorted = [...logs].sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
    for (const l of sorted) {
      if (l.topics.length < 4) continue;
      const d = l.data.slice(2);
      if (d.length < 64 * 4) continue;
      const c0 = addrOf(l.topics[2]);
      const c1 = addrOf(l.topics[3]);
      // curve pools pair the token with native ETH (currency0 = 0); taxed v6 pools may pair it with another token,
      // on either side, and that pair token can be a vibe launch itself (checked 05.10: 22 of 200 v6 graduations; with
      // this rule the count matches the curves' own graduation logs: 200, and the old snapshot day by day).
      // The graduating side is the launch that hasn't graduated yet; with two, the younger one (the pair token
      // existed before the launch that trades against it).
      const L = [byToken.get(c1), c0 !== ZERO ? byToken.get(c0) : undefined]
        .filter((x): x is Launch => !!x && !gradSeen.has(x.curve))
        .sort((x, y) => y.b - x.b)[0];
      if (!L) continue;
      const b = Number(BigInt(l.blockNumber));
      const hook = `0x${d.slice(64 * 2 + 24, 64 * 3)}`.toLowerCase();
      let vibe = hookIsVibe.get(hook);
      if (vibe === undefined) {
        try {
          const out: RawLog[] = [];
          await getLogs({ address: L.curve, topics: [[G_V1, G_V6]] }, b, b, out);
          vibe = out.length > 0;
          hookIsVibe.set(hook, vibe);
        } catch {
          return b; // unknown hook, unknown answer: read from here again next pass
        }
      }
      if (!vibe) continue;
      const sqrt = Number(BigInt(`0x${d.slice(64 * 3, 64 * 4)}`));
      gradSeen.add(L.curve);
      // p0 (ETH per token) only for ETH pools: the door stats read curve graduations only
      grads.push({ b, curve: L.curve, p0: c0 === ZERO && sqrt > 0 ? Q192 / (sqrt * sqrt) : 0, v6: FACTORIES[L.f].kind === "taxed", pool: (l.topics[1] ?? "").toLowerCase() });
    }
    return null;
  };
  for (let pass = 0; pass < 3 && gradNext <= upTo; pass++) {
    const r = await pullWindows({ address: POOL_MANAGER, topics: [POOL_INIT] }, gradNext, upTo, INIT_WINDOW);
    const again = await take(r.logs);
    const next = again ?? r.next;
    if (next === gradNext) await sleep(1_500);
    gradNext = next;
  }
  grads.sort((a, b) => a.b - b.b);
  const ok = gradNext > to;
  return { v1: ok, v6: ok };
}

const symbolAbi = parseAbi(["function symbol() view returns (string)"]);

async function loadSymbols(tokens: string[]) {
  const todo = [...new Set(tokens)].filter((t) => !symbols.has(t));
  for (let i = 0; i < todo.length; i += 150) {
    const part = todo.slice(i, i + 150);
    try {
      const res = await client.multicall({
        contracts: part.map((t) => ({ address: t as Address, abi: symbolAbi, functionName: "symbol" as const })),
        allowFailure: true,
        batchSize: 64_000,
      });
      res.forEach((r, k) => {
        if (r.status === "success") symbols.set(part[k], cleanText(r.result, 16));
      });
    } catch {
      /* symbols are decoration: the address stands in */
    }
  }
  if (symbols.size > 20_000) symbols.clear();
}

/* ------------------------------------------------------------------ the front of the line (sniper sample) */

const PLUMB = new Set<string>([ZERO, ...PLUMBING, ...FACTORIES.map((f) => f.address)]);

type Labels = { sniper: Set<string>; farm: Map<string, number> };
// rebuilt only when a new index lands on disk (lib/earlyIndex)
function labelsOf(): Labels {
  return perIndex("state.labels", (ix): Labels => {
    const farm = new Map<string, number>();
    for (const f of ix.farms ?? []) for (const w of f.wallets) farm.set(w.toLowerCase(), f.id);
    return { sniper: new Set((ix.snipers ?? []).map((w) => w.toLowerCase())), farm };
  });
}

/** First 20 distinct buyers in the token's first hour: Transfers out of its curve, creator and protocol left out. */
async function readFront(L: Launch): Promise<Front> {
  const lab = labelsOf();
  const seen = new Set<string>();
  const order: string[] = [];
  const skip = (w: string) => PLUMB.has(w) || w === L.creator || w === L.curve || w === L.token;
  const scan = async (a: number, b: number) => {
    const out: RawLog[] = [];
    await getLogs({ address: L.token, topics: [TRANSFER, pad(L.curve)] }, a, b, out);
    out.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
    for (const l of out) {
      const to = addrOf(l.topics[2] ?? "");
      if (skip(to) || seen.has(to)) continue;
      seen.add(to);
      order.push(to);
    }
  };
  // the first ~8 minutes hold the front of almost every line; read the rest of the hour only when needed
  await scan(L.b, L.b + 3_000);
  if (order.length < 20) await scan(L.b + 3_001, L.b + HOUR_BLOCKS);
  const first = order.slice(0, 20);
  const farms = new Map<number, number>();
  let snipers = 0;
  for (const w of first) {
    if (lab.sniper.has(w)) snipers++;
    const f = lab.farm.get(w);
    if (f !== undefined) farms.set(f, (farms.get(f) ?? 0) + 1);
  }
  return { buyers: seen.size, snipers, farmMax: Math.max(0, ...farms.values()) };
}

/* ------------------------------------------------------------------ vibe API */

let apiChain: Promise<void> = Promise.resolve();
/** Paced: requests start at least 220 ms apart (<= ~5 per second across the whole build). */
function paced<T>(run: () => Promise<T>): Promise<T> {
  const p = apiChain.then(() => sleep(220)).then(run);
  apiChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

async function vibe<T>(path: string, timeout = 12_000, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await paced(() => fetch(`${API}${path}`, { headers: API_HEADERS, cache: "no-store", signal: AbortSignal.timeout(timeout) }));
      if (r.ok) return (await r.json()) as T;
      last = new Error(`vibe api ${r.status}`);
      if (r.status === 404 || r.status === 400) break;
      // 429 / 503 LISTING_BUSY / 5xx: back off, then try again
      await sleep(1_500 * 2 ** i);
    } catch (e) {
      last = e;
      await sleep(800 * 2 ** i);
    }
  }
  throw last instanceof Error ? last : new Error("vibe api");
}

type ApiItem = {
  tokenAddress?: string; name?: string; symbol?: string; createdAt?: string;
  moderation?: { visibility?: string };
  curve?: { lifecycle?: string; progressBps?: number; graduatedAt?: string | null };
  analytics?: { volume24hWei?: string };
};
type ApiPage = { data?: { items?: ApiItem[]; page?: { totalCount?: number } } };
type V6Item = {
  tokenAddress?: string; name?: string; symbol?: string; pairIsNative?: boolean; graduated?: boolean; lifecycle?: string;
  targetPairUnits?: string; curve?: { pairReserveUnits?: string }; market?: { volume24hPairUnits?: string };
  moderation?: { visibility?: string };
};

const weiEth = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? Number(BigInt(v) / 10n ** 9n) / 1e9 : null);

async function progressBuckets(): Promise<{ buckets: { label: string; count: number | null }[]; total: number | null }> {
  const count = async (q: string) => {
    try {
      const j = await vibe<ApiPage>(`/launches?limit=1&offset=0&${q}`, 15_000);
      const n = Number(j.data?.page?.totalCount);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };
  const total = await count("sort=CREATED_DESC");
  const defs: [string, string][] = [
    ["0–10%", "minimumProgressBps=0&maximumProgressBps=999"],
    ["10–50%", "minimumProgressBps=1000&maximumProgressBps=4999"],
    ["50–90%", "minimumProgressBps=5000&maximumProgressBps=8999"],
    ["90%+", "minimumProgressBps=9000&maximumProgressBps=10000&lifecycle=CURVE_TRADING,CURVE_COMPLETE,GRADUATING"],
    ["Graduated", "lifecycle=GRADUATED"],
  ];
  const buckets: { label: string; count: number | null }[] = [];
  for (const [label, q] of defs) buckets.push({ label, count: await count(q) }); // one at a time: the listing answers 503 when pushed
  return { buckets, total };
}

async function volumeLeaders(recentGradTokens: string[]): Promise<{ rows: VolRow[]; scanned: number; total: number }> {
  const seen = new Map<string, VolRow>();
  let answered = 0;
  const addV1 = (x: ApiItem) => {
    const t = x.tokenAddress?.toLowerCase();
    if (!t || !/^0x[0-9a-f]{40}$/.test(t) || x.moderation?.visibility === "HIDDEN") return;
    const v = weiEth(x.analytics?.volume24hWei);
    if (v === null) return;
    seen.set(t, {
      token: t,
      symbol: cleanText(x.symbol, 16),
      name: cleanText(x.name, 40),
      volume24hEth: v,
      graduated: x.curve?.lifecycle === "GRADUATED",
      progressBps: Number.isFinite(Number(x.curve?.progressBps)) ? Number(x.curve?.progressBps) : null,
      taxed: false,
    });
  };
  for (const q of ["sort=TRENDING&limit=100", "lifecycle=GRADUATED&limit=100", "sort=PROGRESS_DESC&lifecycle=CURVE_TRADING&limit=50"]) {
    try {
      const j = await vibe<ApiPage>(`/launches?${q}`, 15_000, 2);
      (j.data?.items ?? []).forEach(addV1);
      answered++;
    } catch {
      /* one list missing: the rest still ranks, `scanned` says how many */
    }
  }
  try {
    const j = await vibe<{ data?: { items?: V6Item[] } }>(`/v6/launches?limit=50`, 15_000, 2);
    for (const x of j.data?.items ?? []) {
      const t = x.tokenAddress?.toLowerCase();
      if (!t || !/^0x[0-9a-f]{40}$/.test(t) || x.moderation?.visibility === "HIDDEN" || x.pairIsNative !== true) continue; // only ETH pairs compare
      const v = weiEth(x.market?.volume24hPairUnits);
      if (v === null) continue;
      const target = weiEth(x.targetPairUnits);
      const reserve = weiEth(x.curve?.pairReserveUnits);
      const graduated = x.graduated === true || x.lifecycle === "GRADUATED";
      seen.set(t, {
        token: t,
        symbol: cleanText(x.symbol, 16),
        name: cleanText(x.name, 40),
        volume24hEth: v,
        graduated,
        progressBps: graduated ? 10_000 : target && reserve !== null ? Math.min(10_000, Math.round((reserve / target) * 10_000)) : null,
        taxed: true,
      });
    }
    answered++;
  } catch {
    /* as above */
  }
  // the newest graduations: many come from factories vibe doesn't list, read them one by one
  for (const t of recentGradTokens.slice(0, VOL_DETAIL)) {
    if (seen.has(t)) continue;
    try {
      const j = await vibe<{ data?: ApiItem }>(`/launches/${t}`, 10_000, 2);
      if (j.data) addV1(j.data);
    } catch {
      /* skip */
    }
  }
  if (!answered) throw new Error("vibe lists down");
  const all = [...seen.values()];
  const rows = all.filter((r) => r.volume24hEth > 0).sort((a, b) => b.volume24hEth - a.volume24hEth).slice(0, 10);
  return { rows, scanned: all.length, total: all.reduce((s, r) => s + r.volume24hEth, 0) };
}

/* ------------------------------------------------------------------ after the door (V4 pool swaps) */

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
// PoolManager Swap(id indexed, sender indexed, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)
const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f" as Hex;
const Q192 = 2 ** 192;

/** First block at/after a timestamp, interpolated from the anchors (good to a few seconds). */
function blockOf(ts: number): number {
  if (!anchors.length) return 0;
  const last = anchors[anchors.length - 1];
  if (ts >= last[1]) return Math.round(last[0] + (ts - last[1]) / BLOCK_S);
  if (ts <= anchors[0][1]) return Math.round(anchors[0][0] - (anchors[0][1] - ts) / BLOCK_S);
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (anchors[m][1] <= ts) lo = m;
    else hi = m;
  }
  const [b0, t0] = anchors[lo];
  const [b1, t1] = anchors[hi];
  return Math.round(b0 + ((b1 - b0) * (ts - t0)) / Math.max(1, t1 - t0));
}

/**
 * Price path after graduation, straight from the token's Uniswap V4 pool: every Swap log carries the pool's
 * sqrtPriceX96 after the swap. ETH is currency0 (address 0 sorts first), so ETH per token = 2^192 / sqrtP^2.
 * Reference p0 = the pool's Initialize price (the curve's closing ETH / tokens, measured equal to 1e-4). No swap before t = the pool
 * still sits at p0 (read from the chain, not assumed).
 */
async function readDoor(g: Grad, gradTs: number, p0: number, head: number, nowTs: number): Promise<DoorRead> {
  const b1h = blockOf(gradTs + 3600);
  const b24 = blockOf(gradTs + DAY);
  const out: RawLog[] = [];
  await getLogs({ address: POOL_MANAGER, topics: [SWAP, g.pool as Hex] }, g.b, Math.min(head, b24), out);
  const swaps = out
    .map((l) => {
      const d = l.data.slice(2);
      const sqrt = Number(BigInt(`0x${d.slice(128, 192)}`));
      return { b: Number(BigInt(l.blockNumber)), price: sqrt > 0 ? Q192 / (sqrt * sqrt) : NaN };
    })
    .filter((x) => Number.isFinite(x.price) && x.price > 0)
    .sort((a, b) => a.b - b.b);
  const priceAt = (b: number) => {
    let p = p0;
    for (const x of swaps) if (x.b <= b) p = x.price;
    return p;
  };
  const ripe1 = nowTs >= gradTs + 3600;
  const ripe24 = nowTs >= gradTs + DAY;
  return {
    ret1h: ripe1 ? priceAt(b1h) / p0 - 1 : null,
    traded1h: ripe1 ? swaps.some((x) => x.b <= b1h) : null,
    ret24h: ripe24 ? priceAt(b24) / p0 - 1 : null,
    trades24h: ripe24 ? swaps.filter((x) => x.b <= b24).length : null,
    ripe: ripe24,
    at: Date.now(),
  };
}

/* ------------------------------------------------------------------ build */

async function build(): Promise<StateSnapshot> {
  const t0 = Date.now();
  const notes: string[] = [];
  stage = "head";
  const head = Number((await client.getBlockNumber()) - SAFE_LAG);
  const headTs = await blockTs(head);
  addAnchor(head, headTs);
  const nowTs = headTs;

  stage = "anchors";
  try {
    await ensureAnchors(head);
  } catch {
    notes.push("Some block times could not be read: times are estimated from ~0.165 s blocks.");
  }

  stage = "factories";
  const fOk = await syncFactories(head);
  stage = "graduations";
  const gOk = await syncGrads(head);
  const chainOk = fOk.every(Boolean);
  if (!chainOk) {
    notes.push(`Launch logs incomplete for: ${FACTORIES.filter((_, i) => !fOk[i]).map((f) => f.label).join(", ")}. Counts that need them show —.`);
    if (process.env.NODE_ENV !== "production" && lastRpcError) notes.push(`RPC: ${lastRpcError}`);
  }
  if (!gOk.v1 || !gOk.v6) notes.push("Graduation logs incomplete this round: graduation counts show —.");
  const gradsOk = gOk.v1 && gOk.v6 && chainOk; // a graduation only counts once its curve is known

  stage = "days";
  const today0 = Math.floor(nowTs / DAY) * DAY;
  const windowStart = today0 - 6 * DAY;
  const dayStarts = Array.from({ length: 7 }, (_, i) => windowStart + i * DAY);
  let bounds: number[] | null = null;
  try {
    bounds = [];
    for (const d of dayStarts) bounds.push(await blockAt(d, head, headTs));
  } catch {
    bounds = null;
    notes.push("Day boundaries could not be read from the chain.");
  }
  const dayOf = (b: number) => {
    if (!bounds || b < bounds[0] || b > head) return -1;
    let i = 0;
    while (i + 1 < bounds.length && b >= bounds[i + 1]) i++;
    return i;
  };

  // launches per day
  const lDay = dayStarts.map(() => ({ curve: 0, taxed: 0 }));
  const winStartBlock = bounds ? bounds[0] : Infinity;
  for (let i = 0; i < FACTORIES.length; i++) {
    const kind = FACTORIES[i].kind;
    const arr = launches[i];
    for (let k = arr.length - 1; k >= 0 && arr[k].b >= winStartBlock; k--) {
      const d = dayOf(arr[k].b);
      if (d >= 0) lDay[d][kind]++;
    }
  }
  // graduations per day (only curves a factory created)
  const gDay = dayStarts.map(() => ({ curve: 0, taxed: 0 }));
  const verified = grads.map((g) => ({ g, L: byCurve.get(g.curve) })).filter((x): x is { g: Grad; L: Launch } => !!x.L);
  const week = verified.filter((x) => x.g.b >= winStartBlock);
  for (const x of week) {
    const d = dayOf(x.g.b);
    if (d >= 0) gDay[d][FACTORIES[x.L.f].kind]++;
  }

  const days: DayRow[] | null = bounds
    ? dayStarts.map((day, i) => ({ day, partial: i === 6, launches: chainOk ? lDay[i] : null, grads: gradsOk ? gDay[i] : null }))
    : null;
  const launches7d = bounds && chainOk ? lDay.reduce((s, d) => s + d.curve + d.taxed, 0) : null;
  const grads7d = bounds && gradsOk ? week.length : null;
  const cohortGrads = week.filter((x) => x.L.b >= winStartBlock).length;

  const factories: FactoryRow[] | null = chainOk
    ? FACTORIES.map((f, i) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        address: f.address,
        launches: launches[i].length,
        launches7d: launches[i].filter((L) => L.b >= winStartBlock).length,
        grads: verified.filter((x) => x.L.f === i).length,
        grads7d: week.filter((x) => x.L.f === i).length,
      }))
    : null;
  const allLaunches = launches.reduce((s, a) => s + a.length, 0);

  // time from launch to the door (graduations of the last 7 days)
  stage = "time to door";
  const ages = week.map((x) => Math.max(0, tsOf(x.g.b) - tsOf(x.L.b))).sort((a, b) => a - b);
  const bucket = (lo: number, hi: number) => ages.filter((a) => a >= lo && a < hi).length;
  const ttg =
    gradsOk && ages.length
      ? {
          n: ages.length,
          medianS: quantile(ages, 0.5),
          p25S: quantile(ages, 0.25),
          p75S: quantile(ages, 0.75),
          fastestS: ages[0],
          buckets: [
            { label: "< 1h", n: bucket(0, 3600) },
            { label: "1–24h", n: bucket(3600, DAY) },
            { label: "1–7d", n: bucket(DAY, 7 * DAY) },
            { label: "7–14d", n: bucket(7 * DAY, 14 * DAY) },
            { label: "14d+", n: bucket(14 * DAY, Infinity) },
          ],
        }
      : null;

  // top devs by graduated tokens
  stage = "devs";
  let devs: StateSnapshot["devs"] = null;
  if (gradsOk) {
    const launchCount = new Map<string, number>();
    const unlistedCount = new Map<string, number>();
    launches.forEach((arr, i) => {
      const unlisted = UNLISTED.has(FACTORIES[i].id);
      for (const L of arr) {
        launchCount.set(L.creator, (launchCount.get(L.creator) ?? 0) + 1);
        if (unlisted) unlistedCount.set(L.creator, (unlistedCount.get(L.creator) ?? 0) + 1);
      }
    });
    const agg = new Map<string, { all: number; week: number; last: Launch | null; lastB: number }>();
    for (const x of verified) {
      const c = x.L.creator;
      const a = agg.get(c) ?? { all: 0, week: 0, last: null, lastB: -1 };
      a.all++;
      if (x.g.b >= winStartBlock) a.week++;
      if (x.g.b > a.lastB) {
        a.lastB = x.g.b;
        a.last = x.L;
      }
      agg.set(c, a);
    }
    const toRow = (c: string): DevRow => {
      const a = agg.get(c)!;
      return { creator: c, grads: a.all, grads7d: a.week, launches: launchCount.get(c) ?? a.all, lastToken: a.last?.token ?? null, lastSymbol: null, unlisted: unlistedCount.get(c) ?? 0 };
    };
    const all = [...agg.keys()].sort((x, y) => agg.get(y)!.all - agg.get(x)!.all || agg.get(y)!.week - agg.get(x)!.week).slice(0, 10).map(toRow);
    const wk = [...agg.keys()].filter((c) => agg.get(c)!.week > 0).sort((x, y) => agg.get(y)!.week - agg.get(x)!.week || agg.get(y)!.all - agg.get(x)!.all).slice(0, 10).map(toRow);
    devs = { all, week: wk };
    // every creator's chain counts, for /dev when vibe's creator list leaves their factory out
    const idx = new Map<string, string>();
    for (const [c, n] of launchCount) idx.set(c, `${n},${agg.get(c)?.all ?? 0},${unlistedCount.get(c) ?? 0}`);
    devIndex = idx;
    devIndexAsOf = nowTs;
    SHARED.__exitDevIndex = { map: idx, asOf: nowTs };
  }

  // newest graduations first (for the door sample and the volume detail reads)
  const newestGrads = [...week].sort((a, b) => b.g.b - a.g.b);
  await loadSymbols([
    ...(devs ? [...devs.all, ...devs.week].map((d) => d.lastToken).filter((t): t is string => !!t) : []),
    ...newestGrads.slice(0, DOOR_MAX_1H + DOOR_MAX_24H + 60).map((x) => x.L.token),
  ]);
  if (devs) for (const d of [...devs.all, ...devs.week]) d.lastSymbol = d.lastToken ? symbols.get(d.lastToken) ?? null : null;

  // the RPC sample and the API reads run side by side (different services, each with its own pace)
  stage = "sample + vibe api";
  const sampleJob = (async () => {
    if (!bounds || !chainOk) return null;
    const lab = labelsOf();
    const cands: Launch[] = [];
    for (let d = 0; d < 7; d++) {
      const lo = bounds[d];
      const hi = d + 1 < 7 ? bounds[d + 1] : head + 1;
      const day: Launch[] = [];
      for (let i = 0; i < FACTORIES.length; i++) {
        if (FACTORIES[i].kind !== "curve") continue; // v6 curves hold bought tokens until graduation: different front
        for (const L of launches[i]) if (L.b >= lo && L.b < hi && L.b <= head - HOUR_BLOCKS) day.push(L);
      }
      day.sort((a, b) => a.b - b.b);
      const n = Math.min(SAMPLE_PER_DAY, day.length);
      for (let k = 0; k < n; k++) cands.push(day[Math.floor(((k + 0.5) * day.length) / n)]);
    }
    const todo = cands.filter((L) => !fronts.has(L.token)).slice(0, SAMPLE_NEW_MAX);
    await pool(todo, 4, async (L) => {
      try {
        fronts.set(L.token, await readFront(L));
      } catch {
        /* left out of the sample this round */
      }
    });
    const got = cands.map((L) => fronts.get(L.token)).filter((x): x is Front => !!x);
    const formed = got.filter((x) => x.buyers >= 5);
    const INDEX = earlyIndex();
    const ixAge = nowTs - INDEX.generatedAt;
    return {
      sampled: got.length,
      formed: formed.length,
      withFive: formed.filter((x) => x.snipers >= 5).length,
      withFarm: formed.filter((x) => x.farmMax >= 3).length,
      medianSnipers: median(formed.map((x) => x.snipers)),
      dist: [
        { label: "0", n: formed.filter((x) => x.snipers === 0).length },
        { label: "1–4", n: formed.filter((x) => x.snipers >= 1 && x.snipers <= 4).length },
        { label: "5–9", n: formed.filter((x) => x.snipers >= 5 && x.snipers <= 9).length },
        { label: "10+", n: formed.filter((x) => x.snipers >= 10).length },
      ],
      indexBuiltAt: INDEX.generatedAt,
      indexStale: ixAge > INDEX_MAX_AGE,
      indexSnipers: lab.sniper.size,
      indexFarms: (INDEX.farms ?? []).length,
    };
  })().catch(() => null);

  const progressJob = progressBuckets().catch(() => null);
  const volumeJob = volumeLeaders(newestGrads.map((x) => x.L.token)).catch(() => null);
  const doorJob = (async () => {
    if (!gradsOk) return null;
    const usable = newestGrads.filter((x) => !x.g.v6 && x.g.p0 > 0 && Number.isFinite(x.g.p0) && /^0x[0-9a-f]{64}$/.test(x.g.pool));
    // one graduation per dev and per batch: farms graduate dozens of tokens within minutes (often from many
    // wallets), and the newest N would be one batch. Newest first, so each dev's / batch's newest stays;
    // a batch = graduations within BATCH_BLOCKS of the last kept one. Picked before reading: no wasted reads.
    const spread = (xs: typeof usable) => {
      const seen = new Set<string>();
      const out: typeof usable = [];
      let lastB = Infinity;
      for (const x of xs) {
        if (seen.has(x.L.creator) || lastB - x.g.b < BATCH_BLOCKS) continue;
        seen.add(x.L.creator);
        lastB = x.g.b;
        out.push(x);
      }
      return out;
    };
    // graduations the sample stands for (all of them between its oldest and newest pick)
    const span = (all: typeof usable, kept: typeof usable) => (kept.length ? all.filter((x) => x.g.b >= kept[kept.length - 1].g.b).length : 0);
    // two cuts so both windows have data: the newest graduations an hour old, and the newest a full day old
    const hourAll = usable.filter((x) => tsOf(x.g.b) <= nowTs - 3600);
    const dayAll = usable.filter((x) => tsOf(x.g.b) <= nowTs - DAY);
    const hour = spread(hourAll).slice(0, DOOR_MAX_1H);
    const day = spread(dayAll).slice(0, DOOR_MAX_24H);
    const pick = [...new Map([...hour, ...day].map((x) => [x.L.token, x])).values()].sort((a, b) => b.g.b - a.g.b);
    const todo = pick
      .filter((x) => {
        const d = doors.get(x.L.token);
        return !d || (!d.ripe && Date.now() - d.at > FRESH_MS);
      })
      .slice(0, DOOR_NEW_MAX);
    await pool(todo, 4, async (x) => {
      const p0 = x.g.p0; // ETH per token at the pool's open (its Initialize price)
      try {
        doors.set(x.L.token, await readDoor(x.g, tsOf(x.g.b), p0, head, nowTs));
      } catch {
        /* unknown for now: left out of the sample */
      }
    });
    const read = pick
      .map((x) => ({ x, d: doors.get(x.L.token) }))
      .filter((r): r is { x: (typeof pick)[number]; d: DoorRead } => !!r.d);
    if (!read.length) return null;
    const rows: DoorRow[] = read.map(({ x, d }) => ({ token: x.L.token, symbol: symbols.get(x.L.token) ?? null, gradTs: tsOf(x.g.b), ret1h: d.ret1h, ret24h: d.ret24h, trades24h: d.trades24h, traded1h: d.traded1h }));
    // the hour cut and the day cut overlap: count each window from its own (already spread) picks
    const inHour = new Set(hour.map((x) => x.L.token));
    const inDay = new Set(day.map((x) => x.L.token));
    const d1 = read.filter((r) => inHour.has(r.x.L.token) && r.d.ret1h !== null).map((r) => r.d);
    const d24 = read.filter((r) => inDay.has(r.x.L.token) && r.d.ret24h !== null).map((r) => r.d);
    const traded = d1.filter((d) => d.traded1h === true); // an untraded pool sits at the open: 0% by construction
    const r1 = traded.map((d) => d.ret1h as number);
    const r24 = d24.map((d) => d.ret24h as number);
    const t24 = d24.map((d) => d.trades24h).filter((v): v is number => v !== null);
    return {
      n1h: d1.length,
      n24h: d24.length,
      median1h: median(r1),
      traded1h: traded.length,
      noTrade1h: d1.length ? d1.filter((d) => d.traded1h === false).length / d1.length : null,
      raw1h: span(hourAll, hour),
      raw24h: span(dayAll, day),
      median24h: median(r24),
      up24h: r24.length ? r24.filter((v) => v > 0.0001).length / r24.length : null,
      dead24h: t24.length ? t24.filter((v) => v === 0).length / t24.length : null,
      rows: [...rows.filter((r) => r.ret24h === null).slice(0, 6), ...rows.filter((r) => r.ret24h !== null).slice(0, 10)],
    };
  })().catch(() => null);

  const [snipers, progress, volumes, door] = await Promise.all([sampleJob, progressJob, volumeJob, doorJob]);
  if (!progress) notes.push("vibe API did not answer for progress buckets.");
  if (!volumes) notes.push("vibe API did not answer for volumes.");

  const asOfChain = nowTs;
  const nowS = Math.floor(Date.now() / 1000);
  const snap: StateSnapshot = {
    v: 1,
    builtAt: nowS,
    buildMs: Date.now() - t0,
    headBlock: head,
    headTs,
    windowStart,
    days,
    daysSrc: { src: "Chain · factory and curve logs", asOf: asOfChain },
    totals: {
      launches7d,
      grads7d,
      cohort: bounds && gradsOk && launches7d !== null ? { launched: launches7d, graduated: cohortGrads } : null,
      allTime: gradsOk ? { launches: allLaunches, grads: verified.length } : null,
      factories,
    },
    ttg,
    ttgSrc: { src: "Chain · launch block → graduation block", asOf: asOfChain },
    progress: progress && progress.buckets.some((b) => b.count !== null) ? progress : null,
    progressSrc: { src: "vibe API · vibe-listed launches, all time", asOf: progress ? nowS : null },
    snipers,
    snipersSrc: { src: "Chain · first-hour buys × Early Index", asOf: asOfChain, note: "Sample, not every launch" },
    devs,
    devsSrc: { src: "Chain · factory history", asOf: asOfChain },
    volumes,
    volumesSrc: { src: "vibe API · trending, door, graduated lists", asOf: volumes ? nowS : null },
    door,
    doorSrc: { src: "Chain · V4 pool swaps after graduation", asOf: door ? asOfChain : null },
    notes,
  };
  stage = "done";
  return snap;
}

/* ------------------------------------------------------------------ public API */

// Without Redis (local dev, a store outage) the last good snapshot also lives in a temp file, so a restarted
// process or a fresh route module answers with "Snapshot · <time>" at once instead of a 2-minute empty page.
const DISK_FILE = "exitliq-state-v1.json";
async function fromDisk(): Promise<StateSnapshot | null> {
  try {
    const [{ readFile }, { tmpdir }, { join }] = await Promise.all([import("node:fs/promises"), import("node:os"), import("node:path")]);
    const s = JSON.parse(await readFile(join(tmpdir(), DISK_FILE), "utf8")) as StateSnapshot;
    return s && s.v === 1 && Date.now() - s.builtAt * 1000 < 3 * DAY * 1000 ? s : null;
  } catch {
    return null;
  }
}
async function toDisk(s: StateSnapshot) {
  try {
    const [{ writeFile, rename }, { tmpdir }, { join }] = await Promise.all([import("node:fs/promises"), import("node:os"), import("node:path")]);
    const f = join(tmpdir(), DISK_FILE);
    await writeFile(`${f}.tmp`, JSON.stringify(s), "utf8");
    await rename(`${f}.tmp`, f); // readers never see half a file
  } catch {
    /* read-only fs: memory copy still serves */
  }
}

async function fromRedis(): Promise<StateSnapshot | null> {
  if (storeKind !== "redis") return fromDisk();
  try {
    const raw = (await redis(["GET", REDIS_KEY])) as string | null;
    if (!raw) return fromDisk();
    const s = JSON.parse(raw) as StateSnapshot;
    return s && s.v === 1 ? s : fromDisk();
  } catch {
    return fromDisk();
  }
}

async function toRedis(s: StateSnapshot) {
  await toDisk(s);
  if (storeKind !== "redis") return;
  try {
    await redis(["SET", REDIS_KEY, JSON.stringify(s), "EX", 3 * DAY]);
  } catch {
    /* memory copy still serves */
  }
}

/** The dev index into a Redis hash (a fresh key, then RENAME: readers never see half of it). */
async function saveDevIndex() {
  if (storeKind !== "redis" || !devIndex || Date.now() - devIndexSavedAt < DEV_INDEX_SAVE_MS) return;
  devIndexSavedAt = Date.now();
  const tmp = `${DEV_INDEX_KEY}:tmp`;
  try {
    await redis(["DEL", tmp]);
    const entries = [...devIndex];
    for (let i = 0; i < entries.length; i += 500) {
      await redis(["HSET", tmp, ...entries.slice(i, i + 500).flat()]);
    }
    await redis(["HSET", tmp, "_asOf", devIndexAsOf]);
    await redis(["RENAME", tmp, DEV_INDEX_KEY]);
    await redis(["EXPIRE", DEV_INDEX_KEY, 3 * DAY]);
  } catch {
    devIndexSavedAt = 0; // retry on the next build
  }
}

export type ChainDevCount = { launches: number; grads: number; unlisted: number; asOf: number };

const parseDev = (v: string | null | undefined, asOf: number): ChainDevCount => {
  const [n, g, u] = (v ?? "0,0,0").split(",").map(Number);
  return { launches: n || 0, grads: g || 0, unlisted: u || 0, asOf };
};

/**
 * One creator's launches and graduations from the factory history (all four factories), whatever vibe's
 * lists say. null = no index yet (no build has finished here or in Redis): unknown, never zero.
 */
export async function chainDevCount(creator: string): Promise<ChainDevCount | null> {
  const c = creator.toLowerCase();
  const mem = devIndex ? { map: devIndex, asOf: devIndexAsOf } : SHARED.__exitDevIndex;
  if (mem) return parseDev(mem.map.get(c), mem.asOf);
  if (storeKind !== "redis") return null;
  try {
    const r = (await redis(["HMGET", DEV_INDEX_KEY, c, "_asOf"])) as (string | null)[] | null;
    const asOf = Number(r?.[1]);
    if (!r || !Number.isFinite(asOf) || asOf <= 0) return null;
    return parseDev(r[0], asOf);
  } catch {
    return null;
  }
}

/** Start (or join) a build. Never throws: a failed build leaves the last snapshot in place. */
export function refreshState(): Promise<StateSnapshot | null> {
  if (!building) {
    building = build()
      .then(async (s) => {
        snapshot = s;
        await toRedis(s);
        await saveDevIndex();
        return s;
      })
      .finally(() => {
        building = null;
        stage = "idle";
      });
  }
  return building.catch(() => null);
}

export type StateRead = { snapshot: StateSnapshot | null; fresh: boolean; building: boolean; stage: string };

/**
 * The newest snapshot this instance has (memory, then Redis), and whether it is fresh.
 * `waitMs` > 0: when there is none, wait that long for a running build.
 */
export async function readState(waitMs = 0): Promise<StateRead> {
  if (!snapshot) {
    const r = await fromRedis();
    if (r && (!snapshot || r.builtAt > (snapshot as StateSnapshot).builtAt)) snapshot = r;
  }
  const fresh = !!snapshot && Date.now() - snapshot.builtAt * 1000 < FRESH_MS;
  if (!fresh) {
    const job = refreshState();
    if (!snapshot && waitMs > 0) await Promise.race([job, sleep(waitMs)]);
  }
  return { snapshot, fresh: !!snapshot && Date.now() - snapshot.builtAt * 1000 < FRESH_MS, building: !!building, stage };
}

/** The pending build, for after(): keeps a serverless instance alive until it lands. */
export function pendingBuild(): Promise<unknown> | null {
  return building;
}

/** The last snapshot (memory, then Redis); never starts a build. For the OG image. */
export async function peekState(): Promise<StateSnapshot | null> {
  if (snapshot) return snapshot;
  return fromRedis();
}

/** the /state lead sentences (pure; lives next to the board so the client can import it without server code) */
export { stateHeadline } from "@/app/state/headline";
