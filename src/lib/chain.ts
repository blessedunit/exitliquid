// Server-only chain access, verified against the live testnet:
// - eth_getLogs: a single response is capped at 10,000 logs -> split the range on "exceeds limit".
//   Since 05.10.2026 the span is capped too: 10M blocks for one address, 100k for an address list or a
//   topic OR-list, 30k without an address (lib/logs picks the span; wallet-wide reads use Blockscout).
// - Logs carry no timestamp on this node -> interpolate from anchor blocks.
// - Curve progress is read on-chain (the vibe API indexer can lag by hours).
// Results are cached per token and refreshed incrementally.
import "server-only";
import { createPublicClient, http, parseAbi, pad, type Address, type Hex } from "viem";
import { PUBLIC_RPC_URL, CHAIN_ID, ACTIVE_TOKEN } from "./config";
import { curveBuyCost, curvePrice, type BalanceEvent } from "./queue";
import { getLogsChunked, SPAN_NO_ADDRESS } from "./logs";
import { addressTokens, addressTransfers, creationTx } from "./blockscout";

const BUY_FEE = 0.0125;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // Uniswap V4 PoolManager (graduated vibe tokens) // vibe/vibe fee on every curve buy (paid on top of the curve cost)

const RPC_URL = process.env.EXIT_RPC_URL || PUBLIC_RPC_URL; // server only (may carry an API key)

export { ZERO };
export const client = createPublicClient({
  chain: {
    id: CHAIN_ID,
    name: "Robinhood Chain Testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  },
  transport: http(RPC_URL, { timeout: 20_000, retryCount: 2, retryDelay: 400 }),
});

const FACTORY: Address = "0x40f1be6faf8DAB9C143cce1a0A04c2075Fb2DF59";
const LEGACY_FACTORY: Address = "0xB5B7A2f6c4EAFa2D73918fcA32d50e2126339eb9";
// the first curve factory (Aug 2026, ~14.8k launches): same LaunchCreated layout and curve ABI,
// vibe's /launches/<token> knows its tokens (checked 01.10 on GMCO68), only its lists leave them out
const FIRST_FACTORY: Address = "0x4febc267e0c24440bcdef72b5dbc5fe7bed091df";
const LAUNCH_CREATED = "0x56eef5c350583250e71791d6d659f4d181796c9deb08b977252efc3995aa9279" as Hex;
const SEL_CURVE_SUPPLY = "0xbda57323" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";

export const tokenAbi = parseAbi([
  "function curve() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const curveAbi = parseAbi([
  "function realEthReserve() view returns (uint256)",
  "function curveTokensRemaining() view returns (uint256)",
  "function NET_GRADUATION_TARGET() view returns (uint256)",
  "function complete() view returns (bool)",
  "function graduated() view returns (bool)",
]);
const TRANSFER = tokenAbi[4];

export type LaunchMeta = {
  token: string;
  name: string;
  symbol: string;
  creator: string;
  curve: string;
  createdBlock: bigint;
  progressBps: number;
  tokensSold: number; // whole tokens sold on the curve (for the spot price)
  raisedEth: number;
  targetEth: number;
  graduated: boolean;
  // createdBlock is 0 and the factory lookup failed (RPC flake): not a verdict, unknown
  creationUnknown?: boolean;
};

type Created = { block: bigint; creator: string; curve: string };
const createdCache = new Map<string, Created>(); // launch events never change; ~100 bytes each

/** A launch event already read by this instance (no RPC). undefined = not cached, not "not a launch". */
export function cachedCreation(token: string): { block: number; curve: string; creator: string } | undefined {
  const c = createdCache.get(token.toLowerCase()) ?? createdCache.get(token);
  return c ? { block: Number(c.block), curve: c.curve, creator: c.creator } : undefined;
}

// ---- full-history log reads ----
// Since early Oct 2026 the public node refuses eth_getLogs spanning more than 10,000,000 blocks
// ("narrow the block range"). Every "whole history" read goes through these helpers: fixed spans,
// a few at a time, newest first when we only need the first hit.
export const LOG_SPAN = 9_500_000;
const FACTORIES_ALL: Address[] = [FACTORY, LEGACY_FACTORY, FIRST_FACTORY];
let headMemo: { at: number; block: number } | null = null;
export async function headBlock(): Promise<number> {
  if (headMemo && Date.now() - headMemo.at < 15_000) return headMemo.block;
  const block = Number(await client.getBlockNumber());
  headMemo = { at: Date.now(), block };
  return block;
}
type AnyLog = { blockNumber: Hex; topics: Hex[]; data: Hex; address: Hex; transactionHash?: Hex; logIndex?: Hex };
const hexN = (n: number) => `0x${n.toString(16)}`;
/** Every log matching `filter` over the whole chain, read in LOG_SPAN slices (4 in flight). Throws if a slice fails. */
export async function logsAllHistory<T = AnyLog>(filter: Record<string, unknown>, opts: { from?: number } = {}): Promise<T[]> {
  const head = await headBlock();
  const spans: [number, number][] = [];
  for (let a = opts.from ?? 0; a <= head; a += LOG_SPAN) spans.push([a, Math.min(head, a + LOG_SPAN - 1)]);
  const out: T[][] = new Array(spans.length);
  let next = 0;
  const worker = async () => {
    while (next < spans.length) {
      const i = next++;
      const [a, b] = spans[i];
      out[i] = (await client.request({ method: "eth_getLogs", params: [{ ...filter, fromBlock: hexN(a), toBlock: hexN(b) }] } as never)) as T[];
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, spans.length) }, worker));
  return out.flat();
}
/**
 * The LaunchCreated log of a token from any vibe factory (the three factories in parallel per slice),
 * newest slices first, stopping at the first hit. null = no factory ever launched it; throws = unknown.
 */
export async function launchLog(token: string): Promise<AnyLog | null> {
  // fast path: the launch log sits in the tx that created the token (Blockscout knows it): 2 calls instead of
  // up to 14 slices x 3 factories for an old or a foreign token
  try {
    const tx = await creationTx(token);
    if (tx) {
      const r = (await client.request({ method: "eth_getTransactionReceipt", params: [tx] } as never)) as { logs?: AnyLog[] } | null;
      if (r && Array.isArray(r.logs)) {
        const want = pad(token.toLowerCase() as Address).toLowerCase();
        const facts = new Set(FACTORIES_ALL.map((f) => f.toLowerCase()));
        const hit = r.logs.find((l) => facts.has(l.address.toLowerCase()) && l.topics?.[0]?.toLowerCase() === LAUNCH_CREATED && l.topics?.[2]?.toLowerCase() === want);
        return hit ?? null; // the creating tx has no factory launch log: not a vibe launch
      }
    }
  } catch {
    // Blockscout or the receipt failed: the slices below decide
  }
  const head = await headBlock();
  const topics = [LAUNCH_CREATED, null, pad(token as Address)];
  for (let b = head; b >= 0; b -= LOG_SPAN) {
    const a = Math.max(0, b - LOG_SPAN + 1);
    // one address per request: an address list drops the node's cap to 100,000 blocks
    const found = await Promise.all(
      FACTORIES_ALL.map((address) => client.request({ method: "eth_getLogs", params: [{ address, topics, fromBlock: hexN(a), toBlock: hexN(b) }] } as never) as Promise<AnyLog[]>),
    );
    const hit = found.flat()[0];
    if (hit) return hit;
    if (a === 0) break;
  }
  return null;
}

// The taxed v6 factory (Oct 2026): LaunchCreated(id, launcher, token indexed; curve in data), a different
// layout and topic from the curve factories above (same as lib/state.ts LC_V6). Kept out of launchLog() so
// callers that parse the v1 layout are never handed a v6 log.
const V6_FACTORY = "0xe794217880011f9ca6961340ed5c16ec9559fea0";
const V6_LAUNCH_CREATED = "0xa7e8032bfd07a9fbcde50eabe91eb2901faee6dbddd9cced579491d9b07ef5c8";
const V6_FROM = 126_000_000; // a little before its first launch (measured 01.10)

/** A taxed v6 launch's creation: block, curve, creator. null = the v6 factory never launched it; throws = unknown. */
export async function v6LaunchCreation(token: string): Promise<{ block: number; curve: string; creator: string } | null> {
  const want = pad(token.toLowerCase() as Address).toLowerCase();
  const parse = (l: AnyLog) => ({ block: Number(BigInt(l.blockNumber)), curve: `0x${l.data.slice(26, 66)}`.toLowerCase(), creator: `0x${l.topics[2].slice(26)}`.toLowerCase() });
  const isHit = (l: AnyLog) => l.address.toLowerCase() === V6_FACTORY && l.topics?.[0]?.toLowerCase() === V6_LAUNCH_CREATED && l.topics?.[3]?.toLowerCase() === want;
  try {
    const tx = await creationTx(token);
    if (tx) {
      const r = (await client.request({ method: "eth_getTransactionReceipt", params: [tx] } as never)) as { logs?: AnyLog[] } | null;
      if (r && Array.isArray(r.logs)) {
        const hit = r.logs.find(isHit);
        return hit ? parse(hit) : null;
      }
    }
  } catch {
    // Blockscout or the receipt failed: the log slices below decide
  }
  const head = await headBlock();
  for (let a = V6_FROM; a <= head; a += LOG_SPAN) {
    const b = Math.min(head, a + LOG_SPAN - 1);
    const got = (await client.request({ method: "eth_getLogs", params: [{ address: V6_FACTORY, topics: [V6_LAUNCH_CREATED, null, null, want], fromBlock: hexN(a), toBlock: hexN(b) }] } as never)) as AnyLog[];
    const hit = got.find(isHit);
    if (hit) return parse(hit);
  }
  return null;
}

/** null = no launch log from either factory; "unknown" = a lookup threw (never read as "not a vibe token"). */
/** true = a vibe/vibe factory launched it, false = no factory ever did, "unknown" = the lookup failed. */
export async function isVibeLaunch(token: string): Promise<boolean | "unknown"> {
  const f = await findCreation(token);
  return f === "unknown" ? "unknown" : !!f;
}

async function findCreation(token: string): Promise<Created | null | "unknown"> {
  const hit = createdCache.get(token);
  if (hit) return hit;
  try {
    const l = await launchLog(token);
    if (!l) return null; // not cached: a later launch can't appear for an existing address, but stay cheap and honest
    const c: Created = {
      block: BigInt(l.blockNumber),
      curve: `0x${l.topics[3].slice(26)}`.toLowerCase(),
      creator: `0x${l.data.slice(2 + 24, 2 + 64)}`.toLowerCase(), // first data word
    };
    createdCache.set(token, c);
    return c;
  } catch {
    return "unknown"; // a flaky RPC must not poison the cache or read as "not a vibe token"
  }
}

/**
 * On-chain strings are attacker-controlled (anyone can deploy a token called anything).
 * React escapes them, but strip control, bidi-override and zero-width characters (spoofing,
 * layout breaking) and cap the length before they reach any page, JSON or image.
 */
// C0/C1 controls, zero-width, bidi embeddings/overrides/isolates, BOM (escaped: keep this file ASCII)
const UNSAFE_TEXT = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]", "g");

export function cleanText(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(UNSAFE_TEXT, "")
    .trim()
    .slice(0, max);
}

const staticMeta = new Map<string, { name: string; symbol: string; curve: string }>();
const metaCache = new Map<string, { at: number; value: LaunchMeta }>();

export async function fetchLaunch(token: string): Promise<LaunchMeta | null> {
  const t = token.toLowerCase() as Address;
  const cached = metaCache.get(t);
  if (cached && Date.now() - cached.at < 15_000) return cached.value;
  const value = await fetchLaunchUncached(t);
  // a meta without its launch event (findCreation flaked) is not cached: the next read retries it
  if (value && value.curve && !value.creationUnknown && value.createdBlock > 0n) metaCache.set(t, { at: Date.now(), value });
  return value;
}

async function fetchLaunchUncached(t: Address): Promise<LaunchMeta | null> {
  const found = await findCreation(t);
  const created = found === "unknown" ? null : found;
  let curve = created?.curve;
  try {
    if (!curve) curve = (await client.readContract({ address: t, abi: tokenAbi, functionName: "curve" })).toLowerCase();
    const c = { address: curve as Address, abi: curveAbi } as const;
    const st = staticMeta.get(t);
    const [rawName, rawSymbol, remaining, target, realEth, graduated, supplyRes] = await Promise.all([
      st ? st.name : client.readContract({ address: t, abi: tokenAbi, functionName: "name" }),
      st ? st.symbol : client.readContract({ address: t, abi: tokenAbi, functionName: "symbol" }),
      client.readContract({ ...c, functionName: "curveTokensRemaining" }),
      client.readContract({ ...c, functionName: "NET_GRADUATION_TARGET" }),
      client.readContract({ ...c, functionName: "realEthReserve" }),
      client.readContract({ ...c, functionName: "graduated" }),
      client.call({ to: curve as Address, data: SEL_CURVE_SUPPLY }),
    ]);
    // name/symbol are whatever the token contract returns: treat as untrusted text
    const name = st ? st.name : cleanText(rawName, 64);
    const symbol = st ? st.symbol : cleanText(rawSymbol, 16);
    if (!st) staticMeta.set(t, { name, symbol, curve: curve! });
    const curveSupply = supplyRes.data ? BigInt(supplyRes.data) : 793_100_000n * 10n ** 18n;
    const sold = curveSupply - remaining;
    return {
      token: t,
      name,
      symbol,
      creator: created?.creator ?? "",
      curve: curve!,
      createdBlock: created?.block ?? 0n,
      progressBps: graduated ? 10000 : Number((sold * 10000n) / curveSupply),
      tokensSold: graduated ? Number(curveSupply / 10n ** 18n) : Number(sold / 10n ** 18n),
      raisedEth: Number(realEth) / 1e18,
      targetEth: Number(target) / 1e18,
      graduated,
      creationUnknown: found === "unknown" || undefined,
    };
  } catch {
    return null; // curve unreadable: progress is unknown, not 0%
  }
}

export type RawTransfer = { from: string; to: string; value: bigint; block: number; logIndex: number; tx?: string; ts: number };

type Cache = {
  token: string;
  lastBlock: bigint;
  raw: RawTransfer[];
  anchors: [number, number][]; // [block, ts] sorted
  updatedAt: number;
};

const caches = new Map<string, Cache>();
const MAX_TOKEN_CACHES = 80;
const inflight = new Map<string, Promise<Cache>>();

type TransferLog = { args: { from?: string; to?: string; value?: bigint }; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hex | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? e);
const isRateLimit = (m: string) => /429|rate limit|too many requests/i.test(m);
const isTooBig = (m: string) => /exceeds limit|timed out|timeout|too many (logs|results)|range/i.test(m);

// One window: retry with backoff on 429, split in half when the node says "too big / timed out".
async function pullLogs(token: Address, a: bigint, b: bigint, out: TransferLog[], attempt = 0): Promise<void> {
  try {
    const logs = await client.getLogs({ address: token, event: TRANSFER, fromBlock: a, toBlock: b });
    out.push(...(logs as unknown as TransferLog[]));
  } catch (e) {
    const msg = errMsg(e);
    if (isRateLimit(msg) && attempt < 5) {
      await sleep(400 * 2 ** attempt + Math.random() * 200);
      return pullLogs(token, a, b, out, attempt + 1);
    }
    if (isTooBig(msg) && b > a) {
      const m = (a + b) / 2n;
      await pullLogs(token, a, m, out);
      await pullLogs(token, m + 1n, b, out);
      return;
    }
    throw e;
  }
}

// Whole range: fixed windows (~4.6 days of blocks each), at most 3 in flight.
const WINDOW = 2_000_000n;
async function pullRange(token: Address, from: bigint, to: bigint): Promise<TransferLog[]> {
  const windows: [bigint, bigint][] = [];
  for (let s = from; s <= to; s += WINDOW) windows.push([s, s + WINDOW - 1n > to ? to : s + WINDOW - 1n]);
  const parts: TransferLog[][] = windows.map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const i = next++;
      await pullLogs(token, windows[i][0], windows[i][1], parts[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, windows.length) }, worker));
  return parts.flat();
}

async function getBlockTs(b: number, attempt = 0): Promise<[number, number] | null> {
  try {
    const blk = await client.getBlock({ blockNumber: BigInt(b) });
    return [b, Number(blk.timestamp)];
  } catch (e) {
    if (isRateLimit(errMsg(e)) && attempt < 4) {
      await sleep(300 * 2 ** attempt);
      return getBlockTs(b, attempt + 1);
    }
    return null;
  }
}

async function addAnchors(cache: Cache, from: bigint, to: bigint) {
  const want: bigint[] = [];
  const n = to - from < 5000n ? 1 : 24;
  for (let i = 0; i <= n; i++) want.push(from + ((to - from) * BigInt(i)) / BigInt(n));
  const have = new Set(cache.anchors.map((a) => a[0]));
  const missing = [...new Set(want.map(Number))].filter((b) => !have.has(b));
  // small batches: the public node answers 429 to ~25 parallel getBlock calls
  for (let i = 0; i < missing.length; i += 4) {
    const got = await Promise.all(missing.slice(i, i + 4).map((b) => getBlockTs(b)));
    for (const g of got) if (g) cache.anchors.push(g);
  }
  cache.anchors.sort((x, y) => x[0] - y[0]);
  if (cache.anchors.length > 400) cache.anchors = cache.anchors.filter((_, i) => i % 2 === 0 || i === cache.anchors.length - 1);
}

function interpTs(anchors: [number, number][], block: number) {
  if (anchors.length === 0) return 0;
  // blocks are ~0.165 s (measured 24.09)
  if (block <= anchors[0][0]) return Math.round(anchors[0][1] - (anchors[0][0] - block) * 0.165);
  for (let i = 1; i < anchors.length; i++) {
    const [b1, t1] = anchors[i];
    if (block <= b1) {
      const [b0, t0] = anchors[i - 1];
      return Math.round(t0 + ((t1 - t0) * (block - b0)) / Math.max(1, b1 - b0));
    }
  }
  const [bl, tl] = anchors[anchors.length - 1];
  return Math.round(tl + (block - bl) * 0.165);
}

/** Balance events for people only (curve, pool and protocol contracts removed at read time). */
export function toBalanceEvents(raw: RawTransfer[], plumbing: Set<string>, curve?: string): BalanceEvent[] {
  const out: BalanceEvent[] = [];
  // tokens sold on the curve so far, replayed from its own transfers -> the spot price at every moment
  // (used for "a place needs a bag worth 0.0003 ETH at the price you bought")
  let sold = 0n;
  for (const r of raw) {
    let buyValueEth: number | undefined;
    if (curve) {
      if (r.from === curve && r.to !== ZERO) {
        const before = Number((sold > 0n ? sold : 0n) / 10n ** 18n);
        sold += r.value;
        const after = Number(sold / 10n ** 18n);
        // what the buyer paid for these tokens: curve cost + fee (deterministic, no tx lookup)
        if (!plumbing.has(r.to)) buyValueEth = curveBuyCost(before, after) / (1 - BUY_FEE);
      } else if (r.to === curve && r.from !== ZERO) sold -= r.value;
    }
    const priceEth = curve ? curvePrice(Number((sold > 0n ? sold : 0n) / 10n ** 18n)) : undefined;
    if (!plumbing.has(r.from)) out.push({ wallet: r.from, delta: -r.value, block: r.block, logIndex: r.logIndex, ts: r.ts, tx: r.tx, priceEth });
    // market = a real buy: tokens straight from the curve, or (after graduation) straight from the V4 PoolManager.
    // Measured 28.09: 6,153 pool buys in 100k blocks all go PoolManager -> buyer; the router never sends tokens,
    // so anything else (router sweep, locker, another wallet) is a gift and never buys a place or points.
    const market = (!!curve && r.from === curve) || r.from === POOL_MANAGER;
    if (!plumbing.has(r.to))
      out.push({ wallet: r.to, delta: r.value, block: r.block, logIndex: r.logIndex, ts: r.ts, tx: r.tx, market, priceEth, buyValueEth });
  }
  return out;
}

export async function loadEvents(token: string, meta: LaunchMeta | null, opts: { anchors?: boolean } = {}): Promise<Cache> {
  const key = token.toLowerCase();
  const existing = caches.get(key);
  if (existing && Date.now() - existing.updatedAt < 4_000) return existing;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    // stay 64 blocks (~10 s) behind the head: the public RPC sits behind a load balancer whose nodes can
    // lag each other, and getLogs past a node's own head returns [] without an error (lost transfers)
    const latest = (await client.getBlockNumber()) - 64n;
    let cache = caches.get(key);
    if (!cache) {
      const start = meta?.createdBlock && meta.createdBlock > 0n ? meta.createdBlock : 0n;
      cache = { token: key, lastBlock: start - 1n, raw: [], anchors: [], updatedAt: 0 };
    }
    if (latest > cache.lastBlock) {
      const from = cache.lastBlock + 1n;
      const logs: TransferLog[] = [];
      logs.push(...(await pullRange(key as Address, from, latest)));
      const fresh: RawTransfer[] = logs.map((l) => ({
        from: (l.args.from ?? "").toLowerCase(),
        to: (l.args.to ?? "").toLowerCase(),
        value: l.args.value ?? 0n,
        block: Number(l.blockNumber ?? 0n),
        logIndex: Number(l.logIndex ?? 0),
        tx: l.transactionHash ?? undefined,
        ts: 0,
      }));
      // anchors = block timestamps for entry times; My Lines never shows them, so it skips ~25 RPC calls
      if (fresh.length && opts.anchors !== false) {
        const lo = BigInt(fresh.reduce((m, e) => Math.min(m, e.block), Number.MAX_SAFE_INTEGER));
        await addAnchors(cache, lo, latest);
      }
      cache.raw.push(...fresh);
      cache.lastBlock = latest;
      for (const e of cache.raw) if (!e.ts) e.ts = interpTs(cache.anchors, e.block);
    }
    cache.updatedAt = Date.now();
    caches.set(key, cache);
    // My Lines can touch any token: keep memory bounded (the $EXIT line itself is never evicted)
    if (caches.size > MAX_TOKEN_CACHES) {
      const victims = [...caches.values()].filter((c) => c.token !== ACTIVE_TOKEN).sort((a, b) => a.updatedAt - b.updatedAt);
      for (const v of victims.slice(0, caches.size - MAX_TOKEN_CACHES)) caches.delete(v.token);
    }
    return cache;
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Transfer logs of one wallet over the newest ~29k blocks (~80 min), straight from the node: the one
 * whole-wallet read the node still allows without an address filter (topic-only is capped at 30,000 blocks).
 * Blockscout covers the history; this covers the minutes its index may not have yet.
 */
export async function recentWalletLogs(wallet: string, dir: "to" | "from", head?: number): Promise<AnyLog[]> {
  const top = head ?? (await headBlock());
  const t = pad(wallet.toLowerCase() as Address);
  const topics = dir === "to" ? [TRANSFER_TOPIC_HEX, null, t] : [TRANSFER_TOPIC_HEX, t];
  return getLogsChunked<AnyLog>({ topics }, Math.max(0, top - SPAN_NO_ADDRESS + 1), top, (q) => client.request({ method: "eth_getLogs", params: [q] } as never) as Promise<AnyLog[]>);
}
const TRANSFER_TOPIC_HEX = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

/**
 * Tokens that reached this wallet, oldest first: what it holds now (Blockscout balances, the 200 largest), its
 * newest incoming transfers (Blockscout, 2 pages) and the last ~80 min from the node (fresher than any index).
 * A wallet with more tokens returns more than My Lines' 200-token cap, so the scan reports itself truncated.
 * Throws when Blockscout or the node fails: the caller reports unknown, never "holds nothing".
 */
export async function tokensReceivedBy(wallet: string): Promise<string[]> {
  const w = wallet.toLowerCase();
  const [held, recent, tail] = await Promise.all([
    // largest bags first, 4 pages = 200 tokens: My Lines checks 200 at most (a fuller list only costs time)
    addressTokens(w, 4),
    addressTransfers(w, { filter: "to", maxPages: 2 }),
    recentWalletLogs(w, "to"),
  ]);
  const newestFirst: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      newestFirst.push(k);
    }
  };
  [...tail].sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber))).forEach((l) => add(l.address));
  recent.items.forEach((x) => add(x.token));
  held.tokens.forEach(add);
  return newestFirst.reverse();
}

/**
 * Which of these tokens were really created by a vibe/vibe factory. Anyone can deploy a contract
 * with a curve() function and send it to a wallet; only factory launches count.
 * One launchLog per token (its creation tx via Blockscout, else node-sized slices), 8 at a time;
 * confirmed launches are cached for good (a launch event never changes).
 * Throws if any token couldn't be checked: the answer is unknown, not "not a vibe token".
 */
export async function verifyLaunches(tokens: string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  const todo = tokens.filter((t) => {
    if (createdCache.has(t)) ok.add(t);
    return !createdCache.has(t);
  });
  let failed = 0;
  const check = async (t: string) => {
    const f = await findCreation(t);
    if (f === "unknown") failed++;
    else if (f) ok.add(t);
  };
  // 8 at a time: a check is usually 2 calls (Blockscout creation tx + its receipt), see launchLog
  for (let k = 0; k < todo.length; k += 8) await Promise.all(todo.slice(k, k + 8).map(check));
  if (failed) throw new Error(`launch check failed for ${failed} token(s)`);
  return ok;
}
