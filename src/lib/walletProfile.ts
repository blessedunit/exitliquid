// Wallet profile: everything public about one wallet on the vibe/vibe testnet, in one read.
// Signals, not verdicts: a tag is a reason to look closer, never proof of who is behind a wallet.
// Unknown is never zero: every section carries its own status and a reason when it couldn't be read.
//
// Sources and costs (per wallet, cold; everything below is cached):
// - Blockscout: the wallet's ERC-20 transfers (both ways, newest first, up to 60 pages); chain RPC: 2 getLogs
//   (Transfer in / out over the newest ~29k blocks, the node's topic-only cap), 1 multicall (curve() of each
//   token touched), 2-3 getBlock (time anchors), 1 getBalance.
// - vibe API: positions (positionLens), season traders (realized PnL), creator launches (devrep, shared cache),
//   funder's launches. Failures are remembered for a minute (no hammering while vibe answers 403/429).
// - Blockscout: address info + counters, the wallet's oldest 10 txs / internal txs (funder), the funder's
//   oldest 200 txs / internal txs (siblings), funder counters.
// - Early entries (separate call, filled across requests): 1 getLogs per bought token over the ~80 min before
//   the wallet's first buy; the answer never changes, so it is kept for a month.
import "server-only";
import { parseAbi, type Address, type Hex } from "viem";
import { CHAIN_ID } from "./config";
import { cachedCreation, client, cleanText, launchLog, recentWalletLogs, v6LaunchCreation, ZERO } from "./chain";
import { addressTransfers } from "./blockscout";
import { PLUMBING } from "./service";
import { BoundedTtlMap } from "./bounded";
import { devReputation, type DevRep } from "./devrep";
import { scanWallet } from "./lines";
import { earlyIndex, perIndex } from "@/lib/earlyIndex";


const VIBE = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
const VIBE_HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "Mozilla/5.0" };
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const EXPLORER_HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0" };

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const FAUCET = "0x8762f93772c663c6a88ba50900bd5381df2717be"; // the public testnet faucet contract
const PLUMBING_SET = new Set<string>(PLUMBING);
const PLUMBING_NAMES: Record<string, string> = {
  "0x40f1be6faf8dab9c143cce1a0a04c2075fb2df59": "vibe/vibe factory",
  "0xb5b7a2f6c4eafa2d73918fca32d50e2126339eb9": "vibe/vibe legacy factory",
  "0xa6a5d4c098da8f79eae1203a8e42ff9ac7a17f06": "graduation adapter",
  "0x2779651fee12f6fb5a187578de6b63709f85d0cc": "fee hook",
  "0xc0a2deebdc40b7083dc9a067f6992f884fb6074d": "liquidity locker",
  "0x91719a47f855079678b3d5e3af69cde2b830c5c9": "protocol treasury",
  "0x8366a39cc670b4001a1121b8f6a443a643e40951": "Uniswap V4 pool manager",
  "0x8876789976decbfcbbbe364623c63652db8c0904": "universal router",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0x000000000000000000000000000000000000dead": "burn address",
  "0x0d0c44bfeb2a60f9b81c221c4cd24ca89acbacec": "legacy liquidity locker",
  "0x1ed9e88ae14713ca4bc964bade2bc1e3f5cd501a": "legacy graduation adapter",
  "0xc5b22f31f247a6ee33592792d44bde31c0ef10cc": "legacy fee hook",
  [FAUCET]: "public testnet faucet",
};
// Arbitrum-style chains: an L1 deposit arrives from the sender's L1 address + this offset
const ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;
const aliasOf = (a: string) => `0x${((BigInt(a) + ALIAS_OFFSET) % (1n << 160n)).toString(16).padStart(40, "0")}`;

const SEC_PER_BLOCK = 0.165; // measured 24.09 (chain.ts); replaced by a live measurement when anchors load
const HOUR_BLOCKS = 22_000;
const EXIT_SHARE = 20n; // "walked out" = the bag fell to 5% of its peak or less (the line's 95% rule)
const INDEX_MAX_AGE = 14 * 86_400;
const MAX_TOKENS = 400; // tokens checked for a curve per wallet
const ENTRY_WINDOW = 30_000; // ~80 min of blocks before the first buy: the launch must be inside to rank
const ENTRY_CHECK = 60; // newest bought tokens ranked per wallet
const ENTRY_PER_REQUEST = 20; // new tokens ranked per request (the page polls until done)
const SIBLINGS_SHOWN = 24;
const FOREVER = 30 * 86_400_000;

/* ---------------- small helpers ---------------- */

export const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const weiEth = (v: unknown): number | null => {
  try {
    if (v === null || v === undefined || v === "") return null;
    return Number(BigInt(String(v))) / 1e18;
  } catch {
    return null;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? e);
const isRateLimit = (m: string) => /429|rate limit|too many requests/i.test(m);
const isTooBig = (m: string) => /exceeds limit|timed out|timeout|too many (logs|results)|range|limit exceeded|response size/i.test(m);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A tiny semaphore: at most `n` calls to one external service at once (per server instance). */
function gate(n: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((res) => q.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      q.shift()?.();
    }
  };
}
const rpcGate = gate(4);
const vibeGate = gate(3);
const explorerGate = gate(4);

/** Memo + in-flight dedupe; failures are not cached (the caller decides about backoff). */
function memoized<V>(max: number, ttl: (v: V) => number) {
  const memo = new BoundedTtlMap<V>(max);
  const inflight = new Map<string, Promise<V>>();
  return (key: string, load: () => Promise<V>): Promise<V> => {
    const hit = memo.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const running = inflight.get(key);
    if (running) return running;
    const p = load()
      .then((v) => {
        const t = ttl(v);
        if (t > 0) memo.set(key, v, t);
        return v;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

/* ---------------- vibe API (with a failure backoff) ---------------- */

let vibeDownUntil = 0;
let vibeDownReason = "";

class VibeError extends Error {}

async function vibeGet<T>(path: string): Promise<T> {
  if (Date.now() < vibeDownUntil) throw new VibeError(vibeDownReason || "vibe API backing off");
  return vibeGate(async () => {
    let r: Response;
    try {
      r = await fetch(`${VIBE}${path}`, { headers: VIBE_HEADERS, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new VibeError("vibe API did not answer");
    }
    if (r.status === 403 || r.status === 429) {
      // blocked or throttled: back off for a minute so a page refresh doesn't make it worse
      vibeDownUntil = Date.now() + 60_000;
      vibeDownReason = r.status === 429 ? "vibe API rate-limited us (429)" : "vibe API refused the request (403)";
      throw new VibeError(vibeDownReason);
    }
    // a 5xx can be one heavy query (a wallet with thousands of positions): not a reason to stop every lookup
    if (r.status >= 500) throw new VibeError(`vibe API error (${r.status})`);
    if (!r.ok) throw new VibeError(`vibe API ${r.status}`);
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) throw new VibeError("vibe API sent a non-JSON page");
    return (await r.json()) as T;
  });
}

/* ---------------- explorer (Blockscout) ---------------- */

async function explorerGet<T>(path: string): Promise<T> {
  return explorerGate(async () => {
    const r = await fetch(`${EXPLORER}${path}`, { headers: EXPLORER_HEADERS, cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`explorer ${r.status}`);
    return (await r.json()) as T;
  });
}

type V1Tx = { blockNumber: string; timeStamp?: string; transactionIndex?: string; index?: string; from: string; to: string; value: string; isError?: string };
type V1 = { status?: string; message?: string; result?: V1Tx[] | string };

async function v1List(action: "txlist" | "txlistinternal", address: string, rows: number): Promise<V1Tx[]> {
  const j = await explorerGet<V1>(`/api?module=account&action=${action}&address=${address}&sort=asc&page=1&offset=${rows}`);
  if (Array.isArray(j.result)) return j.result;
  // "No transactions found" is an answer; anything else (rate limit, error page) is not
  if (j.status === "0" && /^No (internal )?transactions found/i.test(String(j.message ?? ""))) return [];
  throw new Error(`explorer: ${String(j.message ?? j.result ?? "bad answer").slice(0, 60)}`);
}

// txCount/transfersCount: Blockscout counters, display only ("≈"). They come back stale on the first read
// (measured: 27 then 74 eight seconds later) and 0/missing means "not counted yet", so 0 is read as unknown.
// sentTx: the account nonce from the RPC, exact for an EOA (= txs it sent); null for a contract.
type AddrInfo = { isContract: boolean; name: string | null; txCount: number | null; transfersCount: number | null; sentTx: number | null };
const addrInfoMemo = memoized<AddrInfo>(20_000, () => 10 * 60_000);
function addressInfo(a: string): Promise<AddrInfo> {
  return addrInfoMemo(a, async () => {
    const [info, counters, nonce] = await Promise.all([
      explorerGet<{ is_contract?: boolean; name?: string | null }>(`/api/v2/addresses/${a}`).catch((e) => {
        // 404 = the explorer has never seen this address: a fresh EOA, not an error
        if (/explorer 404/.test(errMsg(e))) return { is_contract: false, name: null };
        throw e;
      }),
      explorerGet<{ transactions_count?: string; token_transfers_count?: string }>(`/api/v2/addresses/${a}/counters`).catch(() => null),
      client.getTransactionCount({ address: a as Address }).catch(() => null),
    ]);
    const num = (v: unknown) => (v === undefined || v === null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
    const isContract = !!info.is_contract;
    return {
      isContract,
      name: info.name ? cleanText(info.name, 40) : null,
      txCount: counters ? num(counters.transactions_count) : null,
      transfersCount: counters ? num(counters.token_transfers_count) : null,
      sentTx: isContract || nonce === null ? null : nonce,
    };
  });
}

/* ---------------- labels (Early Index) ---------------- */

export type TagTone = "risk" | "warn" | "good" | "info" | "dev";
export type Tag = { id: string; label: string; tone: TagTone; detail: string };

type Labels = { sniper: Set<string>; farm: Map<string, number>; farmSize: Map<number, string[]>; verified: Set<string> };
// rebuilt only when a new index lands on disk (lib/earlyIndex)
function labels(): Labels {
  return perIndex("walletProfile.labels", buildLabels);
}
function buildLabels(EARLY_INDEX: ReturnType<typeof earlyIndex>): Labels {
  const farm = new Map<string, number>();
  const farmSize = new Map<number, string[]>();
  for (const f of EARLY_INDEX.farms ?? []) {
    const ws = f.wallets.map((w) => w.toLowerCase());
    farmSize.set(f.id, ws);
    for (const w of ws) farm.set(w, f.id);
  }
  return {
    sniper: new Set((EARLY_INDEX.snipers ?? []).map((w) => w.toLowerCase())),
    farm,
    farmSize,
    verified: new Set((EARLY_INDEX.verifiedEarly ?? []).map((w) => w.toLowerCase())),
  };
}

export type IndexInfo = { ageSec: number | null; stale: boolean; windowDays: number | null; tokensScanned: number | null; sniperMinTokens: number | null; snipers: number; farms: number };
function indexInfo(): IndexInfo {
  const EARLY_INDEX = earlyIndex();
  const gen = Number(EARLY_INDEX.generatedAt) || 0;
  const ageSec = gen ? Math.max(0, Math.floor(Date.now() / 1000) - gen) : null;
  return {
    ageSec,
    stale: ageSec === null || ageSec > INDEX_MAX_AGE,
    windowDays: EARLY_INDEX.windowDays ?? null,
    tokensScanned: EARLY_INDEX.tokensScanned ?? null,
    sniperMinTokens: EARLY_INDEX.sniperMinTokens ?? null,
    snipers: EARLY_INDEX.snipers?.length ?? 0,
    farms: EARLY_INDEX.farms?.length ?? 0,
  };
}

/** Short labels for any address (used for the wallet, its funder and its siblings). */
export function labelsFor(a: string): ("sniper" | `farm:${number}` | "verified" | "plumbing" | "faucet")[] {
  const w = a.toLowerCase();
  const out: ("sniper" | `farm:${number}` | "verified" | "plumbing" | "faucet")[] = [];
  if (w === FAUCET) out.push("faucet");
  else if (PLUMBING_SET.has(w) || PLUMBING_NAMES[w]) out.push("plumbing");
  if (indexInfo().stale) return out;
  const l = labels();
  if (l.sniper.has(w)) out.push("sniper");
  const f = l.farm.get(w);
  if (f !== undefined) out.push(`farm:${f}`);
  if (l.verified.has(w)) out.push("verified");
  return out;
}

/* ---------------- chain: the wallet's Transfer logs ---------------- */

type WLog = { token: string; from: string; to: string; value: bigint; block: number; logIndex: number; tx: string };
type WalletLogs = { inn: WLog[]; out: WLog[]; head: number; truncated: boolean };

// Since 05.10.2026 the node caps a topic-only getLogs (no address) at 30,000 blocks: the history comes from
// Blockscout (both directions in one newest-first stream), the newest ~80 min from the node itself.
const MAX_PAGES = 60; // 50 transfers a page: a wallet with more is summarised on the newest part
const LOGS_BUDGET_MS = 9_000;

function fromRpc(l: { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex?: Hex; transactionHash?: Hex }): WLog | null {
  if (!l.topics?.[1] || !l.topics?.[2]) return null; // ERC-721 style or malformed
  try {
    return {
      token: l.address.toLowerCase(),
      from: `0x${l.topics[1].slice(26)}`.toLowerCase(),
      to: `0x${l.topics[2].slice(26)}`.toLowerCase(),
      value: BigInt(l.data && l.data !== "0x" ? l.data.slice(0, 66) : "0x0"),
      block: Number(BigInt(l.blockNumber)),
      logIndex: Number(BigInt(l.logIndex ?? "0x0")),
      tx: (l.transactionHash ?? "").toLowerCase(),
    };
  } catch {
    return null;
  }
}

const logsMemo = memoized<WalletLogs>(500, () => 60_000);
function walletLogs(w: string): Promise<WalletLogs> {
  return logsMemo(w, async () => {
    // stay a few blocks behind the head: nodes behind the load balancer can lag each other
    const head = Number(await rpcGate(() => client.getBlockNumber())) - 16;
    const [hist, tailIn, tailOut] = await Promise.all([
      addressTransfers(w, { maxPages: MAX_PAGES, deadline: Date.now() + LOGS_BUDGET_MS }),
      rpcGate(() => recentWalletLogs(w, "to", head)),
      rpcGate(() => recentWalletLogs(w, "from", head)),
    ]);
    const seen = new Set<string>();
    const inn: WLog[] = [];
    const out: WLog[] = [];
    const put = (l: WLog) => {
      if (l.block > head) return;
      const k = `${l.tx}:${l.logIndex}`;
      if (seen.has(k)) return;
      seen.add(k);
      if (l.to === w) inn.push(l);
      if (l.from === w) out.push(l);
    };
    for (const l of [...tailIn, ...tailOut]) {
      const x = fromRpc(l as never);
      if (x) put(x);
    }
    for (const t of hist.items) put({ token: t.token, from: t.from, to: t.to, value: t.value, block: t.block, logIndex: t.logIndex, tx: t.tx });
    const order = (x: WLog, y: WLog) => x.block - y.block || x.logIndex - y.logIndex;
    inn.sort(order);
    out.sort(order);
    return { inn, out, head, truncated: !hist.complete };
  });
}

/* ---------------- chain: which tokens are vibe tokens (have a curve) ---------------- */

const curveAbi = parseAbi(["function curve() view returns (address)", "function symbol() view returns (string)"]);
const curveOf = new BoundedTtlMap<{ curve: string | null; symbol: string }>(100_000); // null = no curve() (not a vibe token)

async function curves(tokens: string[]): Promise<{ map: Map<string, { curve: string | null; symbol: string }>; unknown: number }> {
  const map = new Map<string, { curve: string | null; symbol: string }>();
  const todo: string[] = [];
  for (const t of tokens) {
    const hit = curveOf.get(t);
    if (hit) map.set(t, hit);
    else todo.push(t);
  }
  let unknown = 0;
  for (let i = 0; i < todo.length; i += 150) {
    const chunk = todo.slice(i, i + 150);
    try {
      const res = await rpcGate(() =>
        client.multicall({
          allowFailure: true,
          contracts: chunk.flatMap((t) => [
            { address: t as Address, abi: curveAbi, functionName: "curve" as const },
            { address: t as Address, abi: curveAbi, functionName: "symbol" as const },
          ]),
        }),
      );
      chunk.forEach((t, k) => {
        const c = res[k * 2];
        const s = res[k * 2 + 1];
        const fn = (c?.error as { functionName?: string } | undefined)?.functionName;
        if (c?.status === "success") {
          const v = { curve: String(c.result).toLowerCase(), symbol: s?.status === "success" ? cleanText(s.result, 16) : "" };
          curveOf.set(t, v, FOREVER);
          map.set(t, v);
        } else if (fn === "curve") {
          const v = { curve: null, symbol: "" }; // the token's own revert: not a vibe token
          curveOf.set(t, v, FOREVER);
          map.set(t, v);
        } else unknown++;
      });
    } catch {
      unknown += chunk.length;
    }
  }
  return { map, unknown };
}

/* ---------------- chain: time anchors ---------------- */

const blockTs = new BoundedTtlMap<number>(5_000);
async function tsOf(b: number): Promise<number | null> {
  const hit = blockTs.get(String(b));
  if (hit) return hit;
  try {
    const blk = await rpcGate(() => client.getBlock({ blockNumber: BigInt(b) }));
    const t = Number(blk.timestamp);
    blockTs.set(String(b), t, FOREVER);
    return t;
  } catch {
    return null;
  }
}

/* ---------------- activity: trading behaviour from the logs ---------------- */

export type TokenTrade = {
  token: string;
  symbol: string;
  buys: number;
  sells: number;
  firstBuyBlock: number | null;
  firstBuyTs: number | null;
  exitBlock: number | null; // first time the bag fell to <= 5% of its peak after buying
  holdSec: number | null; // first buy -> exit
  holding: boolean;
  giftsIn: number;
  giftsOut: number;
};

export type Activity = {
  status: "ok" | "partial" | "unavailable";
  reason: string | null;
  truncated: boolean;
  tokensTouched: number; // any ERC-20 that moved in or out
  vibeTokens: number; // tokens with a curve the wallet bought or sold
  unknownTokens: number; // tokens whose curve() couldn't be read now (unknown, not "not vibe")
  buys: number;
  sells: number;
  bought: number; // vibe tokens bought at least once
  exited: number; // bought and walked out (bag <= 5% of peak)
  holding: number;
  exitedWithinHour: number;
  medianHoldSec: number | null; // over exited tokens
  giftsIn: number; // tokens received not from a market (airdrops, transfers between wallets)
  giftsOut: number;
  firstTs: number | null;
  lastTs: number | null;
  activeDays: number | null;
  launchesPerDay: number | null; // new tokens bought per active day
  secPerBlock: number;
  tokens: TokenTrade[]; // newest first buy first (capped for the wire)
};

type ActivityCore = Activity & { allTokens: TokenTrade[]; head: number };

async function buildActivity(w: string): Promise<ActivityCore> {
  const logs = await walletLogs(w);
  const all = [...logs.inn, ...logs.out].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const tokenSet = [...new Set(all.map((l) => l.token))];
  // newest-touched tokens first, capped
  const lastTouch = new Map<string, number>();
  for (const l of all) lastTouch.set(l.token, l.block);
  const cands = tokenSet.sort((a, b) => (lastTouch.get(b) ?? 0) - (lastTouch.get(a) ?? 0)).slice(0, MAX_TOKENS);
  const { map, unknown } = await curves(cands);

  // time anchors: first, last activity and the head -> a live seconds-per-block for everything in between
  const firstBlock = all[0]?.block ?? null;
  const lastBlock = all.length ? all[all.length - 1].block : null;
  const [tFirst, tLast, tHead] = await Promise.all([
    firstBlock !== null ? tsOf(firstBlock) : Promise.resolve(null),
    lastBlock !== null ? tsOf(lastBlock) : Promise.resolve(null),
    tsOf(logs.head),
  ]);
  let spb = SEC_PER_BLOCK;
  if (tFirst !== null && tHead !== null && firstBlock !== null && logs.head - firstBlock > 10_000) {
    const m = (tHead - tFirst) / (logs.head - firstBlock);
    if (m > 0.05 && m < 2) spb = m;
  }
  const tsAt = (b: number) => (tHead !== null ? Math.round(tHead - (logs.head - b) * spb) : null);

  const per = new Map<string, { bal: bigint; peak: bigint; t: TokenTrade }>();
  let buys = 0, sells = 0, giftsIn = 0, giftsOut = 0;
  for (const l of all) {
    const info = map.get(l.token);
    const curve = info?.curve ?? null;
    if (!curve) continue; // not a vibe token (or unknown): only vibe trading is profiled
    let p = per.get(l.token);
    if (!p) {
      p = { bal: 0n, peak: 0n, t: { token: l.token, symbol: info?.symbol ?? "", buys: 0, sells: 0, firstBuyBlock: null, firstBuyTs: null, exitBlock: null, holdSec: null, holding: false, giftsIn: 0, giftsOut: 0 } };
      per.set(l.token, p);
    }
    if (l.to === w && l.from !== w) {
      const market = l.from === curve || l.from === POOL_MANAGER;
      p.bal += l.value;
      if (p.bal > p.peak) p.peak = p.bal;
      if (market) {
        p.t.buys++;
        buys++;
        if (p.t.firstBuyBlock === null) p.t.firstBuyBlock = l.block;
      } else if (l.from !== ZERO) {
        p.t.giftsIn++;
        giftsIn++;
      }
    } else if (l.from === w && l.to !== w) {
      const market = l.to === curve || PLUMBING_SET.has(l.to);
      p.bal = p.bal > l.value ? p.bal - l.value : 0n;
      if (market) {
        p.t.sells++;
        sells++;
      } else {
        p.t.giftsOut++;
        giftsOut++;
      }
      if (p.t.firstBuyBlock !== null && p.t.exitBlock === null && p.peak > 0n && p.bal * EXIT_SHARE <= p.peak) p.t.exitBlock = l.block;
    }
  }
  const tokens: TokenTrade[] = [];
  for (const { bal, peak, t } of per.values()) {
    t.holding = peak > 0n && bal * EXIT_SHARE > peak;
    // a bag that fell under 5% and was later rebuilt is held again: its exit is not the story any more
    if (t.holding) t.exitBlock = null;
    if (t.firstBuyBlock !== null) t.firstBuyTs = tsAt(t.firstBuyBlock);
    if (t.firstBuyBlock !== null && t.exitBlock !== null) t.holdSec = Math.max(0, Math.round((t.exitBlock - t.firstBuyBlock) * spb));
    tokens.push(t);
  }
  tokens.sort((a, b) => (b.firstBuyBlock ?? -1) - (a.firstBuyBlock ?? -1));
  const bought = tokens.filter((t) => t.firstBuyBlock !== null);
  const exited = bought.filter((t) => t.exitBlock !== null);
  const firstTs = tFirst;
  const lastTs = tLast;
  const activeDays = firstTs !== null && lastTs !== null ? Math.max(1, (lastTs - firstTs) / 86_400) : null;
  // pace over the span the checked tokens cover (a capped scan only sees the newest tokens)
  const capped = logs.truncated || tokenSet.length > MAX_TOKENS;
  const oldestBuy = bought.reduce<number | null>((m, t) => (t.firstBuyTs !== null && (m === null || t.firstBuyTs < m) ? t.firstBuyTs : m), null);
  const paceDays = capped ? (oldestBuy !== null && lastTs !== null ? Math.max(1, (lastTs - oldestBuy) / 86_400) : null) : activeDays;
  const pace = paceDays ? Math.round((bought.length / paceDays) * 10) / 10 : null;
  const partial = logs.truncated || unknown > 0 || tokenSet.length > MAX_TOKENS;
  const reasons = [
    logs.truncated ? `more than ${(MAX_PAGES * 50).toLocaleString("en-US")} transfers: oldest not loaded` : "",
    tokenSet.length > MAX_TOKENS ? `${tokenSet.length} tokens touched: newest ${MAX_TOKENS} checked` : "",
    unknown ? `${unknown} token(s) unreadable right now` : "",
  ].filter(Boolean);
  return {
    status: partial ? "partial" : "ok",
    reason: reasons.length ? reasons.join("; ") : null,
    truncated: logs.truncated,
    tokensTouched: tokenSet.length,
    vibeTokens: tokens.length,
    unknownTokens: unknown,
    buys,
    sells,
    bought: bought.length,
    exited: exited.length,
    holding: bought.filter((t) => t.holding).length,
    exitedWithinHour: exited.filter((t) => t.exitBlock! - t.firstBuyBlock! <= HOUR_BLOCKS).length,
    medianHoldSec: median(exited.map((t) => t.holdSec!).filter((x) => Number.isFinite(x))),
    giftsIn,
    giftsOut,
    firstTs,
    lastTs,
    activeDays,
    launchesPerDay: pace,
    secPerBlock: spb,
    tokens: tokens.slice(0, 50),
    allTokens: tokens,
    head: logs.head,
  };
}

const activityMemo = memoized<ActivityCore>(500, (v) => (v.status === "ok" ? 60_000 : 20_000));
function activity(w: string) {
  return activityMemo(w, () => buildActivity(w));
}

/* ---------------- vibe: positions (positionLens) ---------------- */

export type Position = {
  token: string;
  symbol: string;
  name: string;
  tokens: number | null;
  valueEth: number | null;
  costEth: number | null;
  unrealizedEth: number | null;
  realizedEth: number | null;
  avgEntryWei: number | null; // per whole token
  priceWei: number | null;
  multiple: number | null; // current price / average entry
  complete: boolean; // vibe's coverage for this position
};

export type Positions = {
  status: "ok" | "fallback" | "unavailable";
  source: "vibe" | "chain" | null;
  reason: string | null;
  capped: boolean; // vibe sends at most 100: the list (and totals) may be cut
  items: Position[];
  totals: { valueEth: number | null; costEth: number | null; unrealizedEth: number | null; realizedEth: number | null; incomplete: number } | null;
  asOfBlock: number | null;
  /** vibe's indexer is behind (meta.freshness.reason, or every row UNAVAILABLE): cost and PnL are missing for everyone, not for this wallet */
  indexerBehind: boolean;
};

/** /api/wprofile/<address>/cost: the chain's cost basis for a held token (from its line) */
export type ChainCost = {
  /** ETH paid for the bought part of the bag still held (from the token's own history); null = unknown */
  costEth: number | null;
  /** "line" = read from the line; "absent" = not in the line (bag too small or only transferred in); "unknown" = line unreadable now */
  status: "line" | "absent" | "unknown";
};

type VibePosition = {
  tokenAddress?: string; name?: string; symbol?: string; coverage?: string;
  balanceBaseUnits?: string; currentPriceWeiPerToken?: string; estimatedValueWei?: string; costBasisWei?: string;
  averageEntryPriceWeiPerToken?: string; realizedPnlWei?: string; unrealizedPnlWei?: string;
};
type VibeEnvelope<T> = { data?: T; error?: { code?: string; message?: string }; meta?: { freshness?: { asOfBlock?: string; status?: string; reason?: string | null } } };

const POS_LIMIT = 100;
const positionsMemo = memoized<Positions>(2_000, (v) => (v.status === "ok" ? 60_000 : 0));

async function vibePositions(w: string): Promise<Positions> {
  const j = await vibeGet<VibeEnvelope<{ items?: VibePosition[] }>>(`/wallets/${w}/positions?limit=${POS_LIMIT}`);
  const items = j.data?.items;
  if (!Array.isArray(items)) throw new VibeError(j.error?.message ? `vibe API: ${cleanText(j.error.message, 60)}` : "vibe API: no positions list");
  const num = (v: unknown) => {
    const x = Number(v);
    return v === undefined || v === null || v === "" || !Number.isFinite(x) ? null : x;
  };
  const out: Position[] = items
    .filter((x) => typeof x.tokenAddress === "string" && isAddr(x.tokenAddress))
    .map((x) => {
      const complete = x.coverage === "COMPLETE";
      const price = num(x.currentPriceWeiPerToken);
      const avg = num(x.averageEntryPriceWeiPerToken);
      let tokens: number | null = null;
      try {
        tokens = x.balanceBaseUnits ? Number(BigInt(x.balanceBaseUnits) / 10n ** 12n) / 1e6 : null;
      } catch { tokens = null; }
      return {
        token: x.tokenAddress!.toLowerCase(),
        symbol: cleanText(x.symbol, 16),
        name: cleanText(x.name, 48),
        tokens,
        valueEth: weiEth(x.estimatedValueWei),
        costEth: complete ? weiEth(x.costBasisWei) : null,
        unrealizedEth: complete ? weiEth(x.unrealizedPnlWei) : null,
        realizedEth: complete ? weiEth(x.realizedPnlWei) : null,
        avgEntryWei: complete ? avg : null,
        priceWei: price,
        multiple: complete && price !== null && avg ? price / avg : null,
        complete,
      };
    })
    .filter((p) => p.tokens === null || p.tokens > 0);
  const sum = (k: "valueEth" | "costEth" | "unrealizedEth" | "realizedEth") => {
    const xs = out.map((p) => p[k]);
    if (!xs.length) return 0;
    if (xs.every((x) => x === null)) return null;
    return xs.reduce<number>((s, x) => s + (x ?? 0), 0);
  };
  const incomplete = out.filter((p) => !p.complete || p.valueEth === null).length;
  const noHistory = out.filter((p) => !p.complete).length;
  const unpriced = out.filter((p) => p.valueEth === null).length;
  const asOf = Number(j.meta?.freshness?.asOfBlock);
  // a stale indexer leaves every row UNAVAILABLE: that is vibe being behind, not this wallet's history
  const indexerBehind = noHistory > 0 && (!!j.meta?.freshness?.reason || noHistory === out.length);
  const why = [
    indexerBehind ? "vibe's indexer is behind: cost and PnL unavailable right now" : noHistory ? `${noHistory} position(s) without full price history: left out of cost and PnL` : "",
    unpriced ? `${unpriced} without a current price: left out of value` : "",
  ].filter(Boolean).join("; ");
  return {
    status: "ok",
    source: "vibe",
    reason: why || null,
    capped: items.length >= POS_LIMIT,
    items: out,
    totals: { valueEth: sum("valueEth"), costEth: sum("costEth"), unrealizedEth: sum("unrealizedEth"), realizedEth: sum("realizedEth"), incomplete },
    asOfBlock: Number.isFinite(asOf) ? asOf : null,
    indexerBehind,
  };
}

async function positions(w: string): Promise<Positions> {
  try {
    return await positionsMemo(w, () => vibePositions(w));
  } catch (e) {
    const why = e instanceof VibeError ? e.message : "vibe API failed";
    // fallback: balances straight from the chain (values at the curve spot price, no cost basis)
    const scan = await scanWallet(w).catch(() => null);
    if (!scan) return { status: "unavailable", source: null, reason: `${why}; chain scan also failed`, capped: false, items: [], totals: null, asOfBlock: null, indexerBehind: false };
    const items: Position[] = scan.holdings.map((h) => ({
      token: h.token, symbol: h.symbol, name: h.name, tokens: h.tokens, valueEth: h.valueEth,
      costEth: null, unrealizedEth: null, realizedEth: null, avgEntryWei: null, priceWei: null, multiple: null, complete: false,
    }));
    const vals = items.map((p) => p.valueEth);
    return {
      status: "fallback",
      source: "chain",
      reason: `${why}. Balances read from the chain: cost and PnL unknown${scan.holdings.some((h) => h.valueEth === null) ? ", graduated tokens unpriced" : ""}.`,
      capped: scan.truncated,
      items,
      totals: { valueEth: vals.length && vals.every((v) => v === null) ? null : vals.reduce<number>((s, v) => s + (v ?? 0), 0), costEth: null, unrealizedEth: null, realizedEth: null, incomplete: vals.filter((v) => v === null).length },
      asOfBlock: null,
      indexerBehind: false,
    };
  }
}

/* ---------------- vibe: season traders (realized PnL) ---------------- */

export type Trader = {
  status: "ok" | "absent" | "unavailable";
  reason: string | null;
  rank: number | null;
  of: number | null;
  realizedEth: number | null;
  unrealizedEth: number | null;
  pnlEth: number | null;
  equityEth: number | null;
  buys: number | null;
  sells: number | null;
  tokensTraded: number | null;
  complete: boolean | null;
};

type VibeTrader = { address?: string; rank?: number; coverage?: string; coverageReason?: string | null; realizedPnlWei?: string; unrealizedPnlWei?: string; pnlWei?: string; equityWei?: string; buyCount?: number; sellCount?: number; tokensTraded?: number };
const traderMemo = memoized<Trader>(2_000, (v) => (v.status === "unavailable" ? 0 : 120_000));
const EMPTY_TRADER = { rank: null, of: null, realizedEth: null, unrealizedEth: null, pnlEth: null, equityEth: null, buys: null, sells: null, tokensTraded: null, complete: null };

async function trader(w: string): Promise<Trader> {
  try {
    return await traderMemo(w, async () => {
      const j = await vibeGet<VibeEnvelope<{ boardStatus?: string; boardReason?: string | null; items?: VibeTrader[]; page?: { totalCount?: number } }>>(`/season/traders?address=${w}&limit=1`);
      const d = j.data;
      if (!d || !Array.isArray(d.items)) throw new VibeError("season board did not answer (endpoint down)");
      if (d.boardStatus && d.boardStatus !== "READY") throw new VibeError(`season board ${d.boardStatus.toLowerCase()}${d.boardReason ? `: ${cleanText(d.boardReason, 60)}` : ""}`);
      const it = d.items.find((x) => x.address?.toLowerCase() === w);
      const of = Number(d.page?.totalCount);
      if (!it) return { status: "absent", reason: "Not on the season traders board (no trades in the season window).", ...EMPTY_TRADER, of: Number.isFinite(of) ? of : null };
      const complete = it.coverage === "COMPLETE";
      return {
        status: "ok",
        reason: complete ? null : `vibe coverage ${String(it.coverage ?? "unknown").toLowerCase()}${it.coverageReason ? `: ${cleanText(it.coverageReason, 60)}` : ""}`,
        rank: Number.isFinite(Number(it.rank)) ? Number(it.rank) : null,
        of: Number.isFinite(of) ? of : null,
        realizedEth: weiEth(it.realizedPnlWei),
        unrealizedEth: weiEth(it.unrealizedPnlWei),
        pnlEth: weiEth(it.pnlWei),
        equityEth: weiEth(it.equityWei),
        buys: Number.isFinite(Number(it.buyCount)) ? Number(it.buyCount) : null,
        sells: Number.isFinite(Number(it.sellCount)) ? Number(it.sellCount) : null,
        tokensTraded: Number.isFinite(Number(it.tokensTraded)) ? Number(it.tokensTraded) : null,
        complete,
      };
    });
  } catch (e) {
    // the page shows one plain reason, never an HTTP code ("vibe API error (503)" read as a site defect)
    const why = e instanceof VibeError && /^season board (?!did not answer)/.test(e.message) ? e.message : "season board offline";
    return { status: "unavailable", reason: why, ...EMPTY_TRADER };
  }
}

/* ---------------- funding + cluster (Blockscout) ---------------- */

export type Sibling = { address: string; labels: ReturnType<typeof labelsFor> };
export type Funding = {
  status: "ok" | "unavailable";
  reason: string | null;
  kind: "source" | "faucet" | "bridge" | "none" | null; // none = no incoming ETH in the oldest rows
  from: string | null;
  fundedAt: number | null; // unix seconds of the first funding
  amountEth: number | null;
  funder: {
    labels: ReturnType<typeof labelsFor>;
    name: string | null; // plumbing / known contract name
    isContract: boolean | null;
    txCount: number | null; // explorer counter, approximate ("≈")
    sentTx: number | null; // nonce: exact txs sent (EOA only)
    busy: boolean | null; // 1,000+ txs: a hub, siblings may be unrelated
    launches: number | null; // launches the funder created (null = unknown)
    launchTokens: string[];
  } | null;
  siblings: {
    status: "ok" | "unavailable" | "skipped";
    reason: string | null;
    scanned: number; // funder txs read (oldest first)
    total: number; // distinct wallets it sent ETH to in those rows (this wallet excluded)
    snipers: number;
    farm: number;
    list: Sibling[];
    capped: boolean;
  };
  boughtFromFunder: number | null; // launches made by the funder that this wallet bought
};

const fundingMemo = memoized<Omit<Funding, "boughtFromFunder">>(20_000, (v) => (v.status === "ok" ? (v.siblings.status === "ok" || v.siblings.status === "skipped" ? 6 * 3_600_000 : 120_000) : 0));
const SIB_ROWS = 200;

async function lookupFunding(w: string): Promise<Omit<Funding, "boughtFromFunder">> {
  const [txs, internal] = await Promise.all([v1List("txlist", w, 10), v1List("txlistinternal", w, 10)]);
  const order = (x: V1Tx) => Number(x.blockNumber) * 1e6 + Number(x.transactionIndex ?? x.index ?? 0);
  const firstOut = txs.filter((x) => x.from?.toLowerCase() === w).reduce((m, x) => Math.min(m, Number(x.blockNumber)), Infinity);
  const incoming = [...txs, ...internal]
    .filter((x) => x.to?.toLowerCase() === w && x.isError !== "1" && /^\d+$/.test(x.value ?? "") && BigInt(x.value) > 0n)
    .sort((x, y) => order(x) - order(y));
  const self = aliasOf(w);
  const skipped = { status: "skipped" as const, reason: null, scanned: 0, total: 0, snipers: 0, farm: 0, list: [], capped: false };
  const base = { status: "ok" as const, reason: null, funder: null, siblings: skipped };
  if (!incoming.length) return { ...base, kind: "none", from: null, fundedAt: null, amountEth: null };
  // ETH that arrived before the wallet did anything: later ETH can be sale proceeds
  const before = incoming.filter((x) => Number(x.blockNumber) <= firstOut);
  let src: V1Tx | null = null;
  for (const x of before) {
    const f = x.from.toLowerCase();
    if (f === FAUCET || f === self) continue;
    src = x;
    break;
  }
  if (!src) {
    const first = incoming[0];
    const f = first.from.toLowerCase();
    const at = Number(first.timeStamp) || null;
    if (f === FAUCET) return { ...base, kind: "faucet", from: FAUCET, fundedAt: at, amountEth: weiEth(first.value) };
    if (f === self) return { ...base, kind: "bridge", from: null, fundedAt: at, amountEth: weiEth(first.value) };
    return { ...base, kind: "none", from: null, fundedAt: null, amountEth: null };
  }
  const from = src.from.toLowerCase();
  const name = PLUMBING_NAMES[from] ?? null;
  const [info, rep, sibs] = await Promise.all([
    addressInfo(from).catch(() => null),
    devReputation(from).catch(() => null),
    funderSiblings(from, w),
  ]);
  // hub check on the nonce (exact, hubs are senders); a contract falls back to the counter, which only
  // under-reads, so a high counter is trusted and a low or missing one stays unknown
  const busy = !info ? null : info.sentTx !== null ? info.sentTx >= 1_000 : info.txCount !== null && info.txCount >= 1_000 ? true : null;
  return {
    status: "ok",
    reason: null,
    kind: "source",
    from,
    fundedAt: Number(src.timeStamp) || null,
    amountEth: weiEth(src.value),
    funder: {
      labels: labelsFor(from),
      name: name ?? info?.name ?? null,
      isContract: info ? info.isContract : null,
      txCount: info?.txCount ?? null,
      sentTx: info?.sentTx ?? null,
      busy,
      launches: rep ? rep.total ?? rep.loaded : null,
      launchTokens: rep ? rep.launches.map((l) => l.token) : [],
    },
    siblings: sibs,
  };
}

async function funderSiblings(funder: string, w: string): Promise<Funding["siblings"]> {
  try {
    const [txs, internal] = await Promise.all([v1List("txlist", funder, SIB_ROWS), v1List("txlistinternal", funder, SIB_ROWS)]);
    const kids: string[] = [];
    const seen = new Set<string>([w, funder]);
    for (const x of [...txs, ...internal].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))) {
      if (x.from?.toLowerCase() !== funder || x.isError === "1" || !/^\d+$/.test(x.value ?? "") || BigInt(x.value) === 0n) continue;
      const to = x.to?.toLowerCase();
      if (!to || !isAddr(to) || seen.has(to) || PLUMBING_SET.has(to)) continue;
      seen.add(to);
      kids.push(to);
    }
    const tagged = kids.map((a) => ({ address: a, labels: labelsFor(a) }));
    // flagged siblings first: they are the story
    tagged.sort((a, b) => b.labels.length - a.labels.length);
    return {
      status: "ok",
      reason: null,
      scanned: txs.length + internal.length,
      total: kids.length,
      snipers: tagged.filter((s) => s.labels.includes("sniper")).length,
      farm: tagged.filter((s) => s.labels.some((l) => l.startsWith("farm:"))).length,
      list: tagged.slice(0, SIBLINGS_SHOWN),
      capped: txs.length >= SIB_ROWS || internal.length >= SIB_ROWS,
    };
  } catch (e) {
    return { status: "unavailable", reason: `explorer: ${errMsg(e).slice(0, 60)}`, scanned: 0, total: 0, snipers: 0, farm: 0, list: [], capped: false };
  }
}

async function funding(w: string): Promise<Omit<Funding, "boughtFromFunder">> {
  try {
    return await fundingMemo(w, () => lookupFunding(w));
  } catch (e) {
    const skipped = { status: "skipped" as const, reason: null, scanned: 0, total: 0, snipers: 0, farm: 0, list: [], capped: false };
    return { status: "unavailable", reason: `explorer: ${errMsg(e).slice(0, 60)}`, kind: null, from: null, fundedAt: null, amountEth: null, funder: null, siblings: skipped };
  }
}

/* ---------------- the profile ---------------- */

export type DevSection = {
  status: "ok" | "unavailable";
  reason: string | null;
  total: number | null;
  loaded: number;
  graduated: number | null;
  launches: { token: string; symbol: string; createdAt: number; progressBps: number; graduated: boolean; hidden: boolean; taxed?: boolean }[];
  /** "v1-only" = vibe's taxed v6 list did not answer: v6 launches are unknown, not absent */
  coverage: "full" | "v1-only" | null;
};

export type WalletProfile = {
  wallet: string;
  updatedAt: number;
  kind: { contract: boolean | null; plumbing: string | null; faucet: boolean; explorerName: string | null };
  tags: Tag[];
  index: IndexInfo & { farm: { id: number; size: number; peers: string[] } | null };
  eth: { balance: number | null; reason: string | null };
  explorer: { status: "ok" | "unavailable"; txCount: number | null; transfersCount: number | null; sentTx: number | null; reason: string | null };
  positions: Positions;
  trader: Trader;
  dev: DevSection;
  activity: Activity;
  funding: Funding;
  partial: boolean; // any section unknown: the page must not be cached as the answer
};

function devSection(rep: DevRep | null, reason: string | null): DevSection {
  if (!rep) return { status: "unavailable", reason: reason ?? "vibe/vibe didn't answer", total: null, loaded: 0, graduated: null, launches: [], coverage: null };
  return {
    status: "ok",
    reason: rep.total !== null && rep.total > rep.loaded ? `newest ${rep.loaded} of ${rep.total} loaded` : null,
    total: rep.total,
    loaded: rep.loaded,
    graduated: rep.graduated,
    launches: rep.launches.slice(0, 12).map((l) => ({ ...l, symbol: cleanText(l.symbol, 16) })),
    coverage: rep.coverage,
  };
}

const UNAVAILABLE_ACTIVITY = (reason: string): Activity => ({
  status: "unavailable", reason, truncated: false, tokensTouched: 0, vibeTokens: 0, unknownTokens: 0, buys: 0, sells: 0, bought: 0, exited: 0, holding: 0,
  exitedWithinHour: 0, medianHoldSec: null, giftsIn: 0, giftsOut: 0, firstTs: null, lastTs: null, activeDays: null, launchesPerDay: null, secPerBlock: SEC_PER_BLOCK, tokens: [],
});

const profileMemo = memoized<WalletProfile>(1_000, (v) => (v.partial ? 15_000 : 45_000));

export function walletProfile(wallet: string): Promise<WalletProfile> {
  const w = wallet.toLowerCase();
  return profileMemo(w, () => buildProfile(w));
}

async function buildProfile(w: string): Promise<WalletProfile> {
  const [ethRes, infoRes, posRes, traderRes, repRes, actRes, fundRes] = await Promise.allSettled([
    rpcGate(() => client.getBalance({ address: w as Address })),
    addressInfo(w),
    positions(w),
    trader(w),
    devReputation(w),
    activity(w),
    funding(w),
  ]);

  const info = infoRes.status === "fulfilled" ? infoRes.value : null;
  const act: Activity = actRes.status === "fulfilled" ? stripCore(actRes.value) : UNAVAILABLE_ACTIVITY("chain logs could not be read right now");
  const allTokens = actRes.status === "fulfilled" ? actRes.value.allTokens : [];
  const rep = repRes.status === "fulfilled" ? repRes.value : null;
  const fundBase = fundRes.status === "fulfilled" ? fundRes.value : null;

  // launches by the funder that this wallet bought: a dev buying their own launch through a fresh wallet looks like this
  let boughtFromFunder: number | null = null;
  if (fundBase?.funder && fundBase.funder.launches !== null && actRes.status === "fulfilled") {
    const mine = new Set(allTokens.filter((t) => t.firstBuyBlock !== null).map((t) => t.token));
    boughtFromFunder = fundBase.funder.launchTokens.filter((t) => mine.has(t)).length;
  }
  const fund: Funding = fundBase
    ? { ...fundBase, funder: fundBase.funder ? { ...fundBase.funder, launchTokens: [] } : null, boughtFromFunder }
    : { status: "unavailable", reason: "explorer did not answer", kind: null, from: null, fundedAt: null, amountEth: null, funder: null, siblings: { status: "unavailable", reason: null, scanned: 0, total: 0, snipers: 0, farm: 0, list: [], capped: false }, boughtFromFunder: null };

  const ix = indexInfo();
  const own = labelsFor(w);
  const farmId = own.find((l) => l.startsWith("farm:"));
  const farm = farmId ? (() => {
    const id = Number(farmId.slice(5));
    const peers = (labels().farmSize.get(id) ?? []).filter((p) => p !== w);
    return { id, size: peers.length + 1, peers };
  })() : null;
  const plumbingName = PLUMBING_NAMES[w] ?? null;

  /* ---- tags ---- */
  const tags: Tag[] = [];
  if (w === FAUCET) tags.push({ id: "faucet", label: "Faucet", tone: "info", detail: "The public testnet faucet: the first ETH of most testnet wallets comes from here." });
  else if (plumbingName) tags.push({ id: "plumbing", label: "Protocol", tone: "info", detail: `vibe/vibe or Uniswap plumbing (${plumbingName}): moves tokens for everyone, never a person.` });
  if (info?.isContract && !plumbingName && w !== FAUCET) tags.push({ id: "contract", label: "Contract", tone: "info", detail: "A smart contract, not a person's wallet." });
  if (own.includes("sniper")) tags.push({ id: "sniper", label: "Sniper", tone: "risk", detail: `Bought among the first 20 of ${ix.sniperMinTokens ?? "many"}+ launches in ${ix.windowDays ?? "?"} days (Early Index). Usually sells into the line.` });
  if (farm) tags.push({ id: "farm", label: `Farm #${farm.id}`, tone: "warn", detail: `One of ${farm.size} wallets that keep buying the first minutes of the same launches together. Often one operator.` });
  if (own.includes("verified")) tags.push({ id: "verified", label: "Verified early", tone: "good", detail: "Its early entries graduated well above chance in the index window." });
  if (rep && (rep.total ?? rep.loaded) > 0) tags.push({ id: "dev", label: `Dev · ${rep.total ?? `${rep.loaded}+`}`, tone: "dev", detail: `Created ${rep.total ?? `${rep.loaded}+`} launch${(rep.total ?? rep.loaded) === 1 ? "" : "es"} on vibe/vibe, ${rep.graduated} graduated.` });
  if (fund.kind === "faucet") tags.push({ id: "faucet_funded", label: "Faucet-funded", tone: "info", detail: "Its first ETH came from the public faucet." });
  if (fund.kind === "bridge") tags.push({ id: "bridged", label: "Bridged", tone: "info", detail: "Its first ETH was bridged from L1 by the same address." });
  if (fund.funder?.labels.includes("sniper")) tags.push({ id: "funder_sniper", label: "Funded by a sniper", tone: "risk", detail: "The wallet that first sent it ETH is on the sniper list." });
  if (fund.funder?.labels.some((l) => l.startsWith("farm:"))) tags.push({ id: "funder_farm", label: "Funded by a farm", tone: "warn", detail: "The wallet that first sent it ETH is in a farm group." });
  if (fund.funder && fund.funder.launches && fund.funder.launches > 0) tags.push({ id: "funder_dev", label: "Funded by a dev", tone: "warn", detail: `Its first ETH came from a wallet that created ${fund.funder.launches} launch${fund.funder.launches === 1 ? "" : "es"}.` });
  if (boughtFromFunder) tags.push({ id: "buys_funder", label: `Buys funder's launches · ${boughtFromFunder}`, tone: "risk", detail: `It bought ${boughtFromFunder} launch${boughtFromFunder === 1 ? "" : "es"} that vibe/vibe lists under the wallet that funded it. A dev buying their own launch through a second wallet looks like this.` });
  if (fund.siblings.status === "ok" && fund.siblings.snipers + fund.siblings.farm >= 2 && !fund.funder?.busy) tags.push({ id: "cluster", label: "Flagged siblings", tone: "warn", detail: `Its funder also funded ${fund.siblings.snipers} sniper(s) and ${fund.siblings.farm} farm wallet(s).` });
  if (act.status !== "unavailable" && act.exited >= 5 && act.exitedWithinHour / act.exited >= 0.6) tags.push({ id: "flipper", label: "Fast flipper", tone: "warn", detail: `${act.exitedWithinHour} of ${act.exited} exits came within an hour of buying.` });
  if (act.status !== "unavailable" && act.bought >= 10 && act.exited / act.bought <= 0.1) tags.push({ id: "holder", label: "Holder", tone: "good", detail: `Still holds ${act.holding} of ${act.bought} launches it bought.` });
  if (act.launchesPerDay !== null && act.launchesPerDay >= 30) tags.push({ id: "bot_pace", label: "Bot pace", tone: "warn", detail: `Buys about ${act.launchesPerDay} new launches per active day.` });

  const eth = ethRes.status === "fulfilled" ? { balance: Number(ethRes.value) / 1e18, reason: null } : { balance: null, reason: "RPC did not answer" };
  const explorer = info
    ? { status: "ok" as const, txCount: info.txCount, transfersCount: info.transfersCount, sentTx: info.sentTx, reason: info.txCount === null && info.sentTx === null ? "tx count not ready" : null }
    : { status: "unavailable" as const, txCount: null, transfersCount: null, sentTx: null, reason: "explorer did not answer" };
  const positionsRes: Positions = posRes.status === "fulfilled" ? posRes.value : { status: "unavailable", source: null, reason: "positions failed", capped: false, items: [], totals: null, asOfBlock: null, indexerBehind: false };
  const traderOut: Trader = traderRes.status === "fulfilled" ? traderRes.value : { status: "unavailable", reason: "season board failed", ...EMPTY_TRADER };
  const dev = devSection(rep, repRes.status === "rejected" ? "vibe/vibe didn't answer (launch list)" : null);

  const partial =
    eth.balance === null || explorer.status !== "ok" || positionsRes.status !== "ok" || traderOut.status === "unavailable" ||
    dev.status !== "ok" || act.status !== "ok" || fund.status !== "ok" || fund.siblings.status === "unavailable";

  return {
    wallet: w,
    updatedAt: Date.now(),
    kind: { contract: info ? info.isContract : null, plumbing: plumbingName, faucet: w === FAUCET, explorerName: info?.name ?? null },
    tags,
    index: { ...ix, farm: farm ? { id: farm.id, size: farm.size, peers: farm.peers.slice(0, 30) } : null },
    eth,
    explorer,
    positions: positionsRes,
    trader: traderOut,
    dev,
    activity: act,
    funding: fund,
    partial,
  };
}

function stripCore(a: ActivityCore): Activity {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { allTokens, head, ...rest } = a;
  return rest;
}

/* ---------------- early entries: where in each launch's line did it come in ---------------- */

export type Entry = {
  token: string;
  symbol: string;
  buyBlock: number;
  buyTs: number | null;
  status: "ranked" | "late" | "pending" | "error";
  rank: number | null; // 1 = first buyer after the creator; null unless ranked (and for its own launches)
  rankCapped: boolean; // the rank is a floor ("200+")
  delaySec: number | null; // launch -> its first buy
  creator: string | null; // from the factory's launch event (null = not read yet)
  own: boolean; // it created this launch
  funders: boolean; // its funder created this launch
  holding: boolean;
  exited: boolean;
};

export type CreatorCount = { creator: string; launches: number; labels: ReturnType<typeof labelsFor> };

export type EntriesResponse = {
  wallet: string;
  status: "ok" | "unavailable";
  reason: string | null;
  bought: number; // vibe launches it bought (all)
  considered: number; // newest launches we rank (cap)
  checked: number; // ranked or late (its own launches excluded)
  pending: number; // not checked yet: the page asks again
  errors: number;
  skipped: number; // among `considered`: tokens no vibe factory we read launched (not placed, shown as a count)
  first20: number;
  first5: number;
  withinMinute: number;
  late: number;
  medianRank: number | null;
  medianDelaySec: number | null;
  first20Rate: number | null; // first20 / checked
  ownLaunches: number; // launches it created itself, among the newest `considered` it bought (a floor, not its dev total)
  funderLaunches: number | null; // checked launches created by its funder (null = funder unknown)
  funder: string | null;
  topCreators: CreatorCount[]; // creators whose launches it bought most (2+)
  items: Entry[];
  updatedAt: number;
};

const FACTORIES = ["0x40f1be6faf8dab9c143cce1a0a04c2075fb2df59", "0xb5b7a2f6c4eafa2d73918fca32d50e2126339eb9", "0x4febc267e0c24440bcdef72b5dbc5fe7bed091df"]; // main, legacy, first (lib/chain)
const LAUNCH_CREATED = "0x56eef5c350583250e71791d6d659f4d181796c9deb08b977252efc3995aa9279" as Hex;

type LaunchInfo = { block: number; curve: string; creator: string } | null; // null = no factory launched it
type LaunchWindow = { buyers: { wallet: string; block: number }[]; end: number; capped: boolean };
type RpcLog = { topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex };
const launchMemo = new BoundedTtlMap<LaunchInfo>(100_000);
const windowMemo = new BoundedTtlMap<LaunchWindow>(20_000);
const entryMemo = new BoundedTtlMap<EntryCore>(100_000);
const entryFailed = new BoundedTtlMap<true>(20_000);
const MAX_BUYERS = 200;

async function rpcLogs(params: object, depth = 0): Promise<RpcLog[]> {
  try {
    return (await rpcGate(() => client.request({ method: "eth_getLogs", params: [params] } as never))) as RpcLog[];
  } catch (e) {
    if (isRateLimit(errMsg(e)) && depth < 4) {
      await sleep(500 * 2 ** depth + Math.random() * 200);
      return rpcLogs(params, depth + 1);
    }
    throw e;
  }
}

/** The factory's launch event for a token: launch block, curve and creator. Never changes, cached for good. */
async function launchInfo(token: string): Promise<LaunchInfo> {
  const hit = launchMemo.get(token);
  if (hit !== undefined) return hit;
  // the token pages already read this launch event: reuse it before a full-history factory getLogs
  const known = cachedCreation(token);
  if (known) {
    launchMemo.set(token, known, FOREVER);
    return known;
  }
  {
    const l = await launchLog(token); // whole history in node-sized slices (the node caps a getLogs at 10M blocks)
    if (l) {
      const v = { block: Number(BigInt(l.blockNumber)), curve: `0x${l.topics[3].slice(26)}`.toLowerCase(), creator: `0x${l.data.slice(2 + 24, 2 + 64)}`.toLowerCase() };
      launchMemo.set(token, v, FOREVER);
      return v;
    }
  }
  // not from a curve factory: a taxed v6 launch (its own factory and log layout) before calling it "not a launch"
  const v6 = await v6LaunchCreation(token);
  if (v6) {
    launchMemo.set(token, v6, FOREVER);
    return v6;
  }
  // no factory we read launched it. Kept for 6 h only: a factory vibe adds later must not be ruled out for good
  launchMemo.set(token, null, NOT_LAUNCH_TTL);
  return null;
}
const NOT_LAUNCH_TTL = 6 * 3_600_000;

async function pullTokenWindow(token: string, from: number, to: number, depth = 0): Promise<{ from: string; to: string; block: number; logIndex: number }[]> {
  try {
    const got = await rpcLogs({ address: token, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TRANSFER_TOPIC] });
    return got
      .filter((l) => l.topics?.[1] && l.topics?.[2])
      .map((l) => ({ from: `0x${l.topics[1].slice(26)}`.toLowerCase(), to: `0x${l.topics[2].slice(26)}`.toLowerCase(), block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)) }));
  } catch (e) {
    if (isTooBig(errMsg(e)) && to > from && depth < 10) {
      const m = Math.floor((from + to) / 2);
      return [...(await pullTokenWindow(token, from, m, depth + 1)), ...(await pullTokenWindow(token, m + 1, to, depth + 1))];
    }
    throw e;
  }
}

/** Ordered market buyers of one launch (creator excluded), from the launch block up to `upTo`. */
async function launchWindow(token: string, li: NonNullable<LaunchInfo>, upTo: number): Promise<LaunchWindow> {
  const hit = windowMemo.get(token);
  if (hit && (hit.end >= upTo || hit.capped)) return hit;
  const logs = (await pullTokenWindow(token, li.block, upTo)).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const buyers: { wallet: string; block: number }[] = [];
  const seen = new Set<string>([li.creator]);
  let capped = false;
  for (const l of logs) {
    const market = l.from === li.curve || l.from === POOL_MANAGER;
    if (!market || l.to === li.curve || PLUMBING_SET.has(l.to) || seen.has(l.to)) continue;
    seen.add(l.to);
    buyers.push({ wallet: l.to, block: l.block });
    if (buyers.length >= MAX_BUYERS) {
      capped = true;
      break;
    }
  }
  const v: LaunchWindow = { buyers, end: upTo, capped };
  windowMemo.set(token, v, FOREVER);
  return v;
}

type EntryCore = Omit<Entry, "funders" | "holding" | "exited">;

async function rankEntry(w: string, t: TokenTrade, spb: number): Promise<EntryCore | null> {
  const key = `${w}:${t.token}`;
  const hit = entryMemo.get(key);
  if (hit) return hit;
  const li = await launchInfo(t.token);
  if (!li) return null; // not a vibe launch after all (a token with its own curve())
  const buy = t.firstBuyBlock!;
  const delaySec = Math.max(0, Math.round((buy - li.block) * spb));
  const base = { token: t.token, symbol: t.symbol, buyBlock: buy, buyTs: t.firstBuyTs, creator: li.creator, own: li.creator === w, delaySec };
  let e: EntryCore;
  if (li.creator === w) {
    e = { ...base, status: "ranked", rank: null, rankCapped: false }; // its own launch: the dev buy has no place in the line
  } else if (buy - li.block > ENTRY_WINDOW) {
    e = { ...base, status: "late", rank: null, rankCapped: false };
  } else {
    const win = await launchWindow(t.token, li, buy);
    const i = win.buyers.findIndex((b) => b.wallet === w);
    if (i >= 0) e = { ...base, status: "ranked", rank: i + 1, rankCapped: false };
    else if (win.capped) e = { ...base, status: "ranked", rank: MAX_BUYERS, rankCapped: true };
    // bought, but not straight from the market (e.g. through an aggregator): placed by time
    else e = { ...base, status: "ranked", rank: win.buyers.filter((b) => b.block <= buy).length + 1, rankCapped: false };
  }
  entryMemo.set(key, e, FOREVER);
  return e;
}

const entriesLocks = new Map<string, Promise<EntriesResponse>>();

export function walletEntries(wallet: string): Promise<EntriesResponse> {
  const w = wallet.toLowerCase();
  const running = entriesLocks.get(w);
  if (running) return running;
  const p = buildEntries(w).finally(() => entriesLocks.delete(w));
  entriesLocks.set(w, p);
  return p;
}

async function buildEntries(w: string): Promise<EntriesResponse> {
  const [actRes, fundRes] = await Promise.allSettled([activity(w), funding(w)]);
  if (actRes.status === "rejected") {
    return {
      wallet: w, status: "unavailable", reason: "chain logs could not be read right now", bought: 0, considered: 0, checked: 0, pending: 0, errors: 0, skipped: 0,
      first20: 0, first5: 0, withinMinute: 0, late: 0, medianRank: null, medianDelaySec: null, first20Rate: null,
      ownLaunches: 0, funderLaunches: null, funder: null, topCreators: [], items: [], updatedAt: Date.now(),
    };
  }
  const act = actRes.value;
  const fund = fundRes.status === "fulfilled" && fundRes.value.status === "ok" ? fundRes.value : null;
  const funder = fund?.kind === "source" ? fund.from : null;
  const bought = act.allTokens.filter((t) => t.firstBuyBlock !== null);
  const considered = bought.slice(0, ENTRY_CHECK);
  const items: (Entry | null)[] = [];
  let budget = ENTRY_PER_REQUEST;
  const todo: { t: TokenTrade; idx: number }[] = [];
  const finish = (c: EntryCore, t: TokenTrade): Entry => ({ ...c, funders: !!funder && c.creator === funder, holding: t.holding, exited: t.exitBlock !== null });
  const pendingOf = (t: TokenTrade, status: "pending" | "error"): Entry => ({
    token: t.token, symbol: t.symbol, buyBlock: t.firstBuyBlock!, buyTs: t.firstBuyTs, status, rank: null, rankCapped: false, delaySec: null,
    creator: null, own: false, funders: false, holding: t.holding, exited: t.exitBlock !== null,
  });
  considered.forEach((t, idx) => {
    const key = `${w}:${t.token}`;
    const hit = entryMemo.get(key);
    if (hit) items[idx] = finish(hit, t);
    else if (launchMemo.get(t.token) === null) items[idx] = null; // known non-launch
    else if (entryFailed.has(key)) items[idx] = pendingOf(t, "error");
    else {
      if (budget > 0) {
        budget--;
        todo.push({ t, idx });
      }
      items[idx] = pendingOf(t, "pending");
    }
  });
  await Promise.all(
    todo.map(async ({ t, idx }) => {
      try {
        const c = await rankEntry(w, t, act.secPerBlock);
        items[idx] = c ? finish(c, t) : null;
      } catch {
        entryFailed.set(`${w}:${t.token}`, true, 120_000); // retried after 2 min
        items[idx] = pendingOf(t, "error");
      }
    }),
  );
  const list = items.filter((e): e is Entry => !!e);
  const others = list.filter((e) => !e.own);
  const ranked = others.filter((e) => e.status === "ranked");
  const late = others.filter((e) => e.status === "late").length;
  const checked = ranked.length + late;
  const first20 = ranked.filter((e) => !e.rankCapped && e.rank !== null && e.rank <= 20).length;
  const byCreator = new Map<string, number>();
  for (const e of others) if (e.creator) byCreator.set(e.creator, (byCreator.get(e.creator) ?? 0) + 1);
  const topCreators = [...byCreator.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([creator, launches]) => ({ creator, launches, labels: labelsFor(creator) }));
  return {
    wallet: w,
    status: "ok",
    reason: act.truncated ? "oldest transfers not loaded" : null,
    bought: bought.length,
    considered: considered.length,
    checked,
    pending: list.filter((e) => e.status === "pending").length,
    errors: list.filter((e) => e.status === "error").length,
    skipped: items.filter((e) => e === null).length,
    first20,
    first5: ranked.filter((e) => !e.rankCapped && e.rank !== null && e.rank <= 5).length,
    withinMinute: ranked.filter((e) => e.delaySec !== null && e.delaySec <= 60).length,
    late,
    medianRank: median(ranked.filter((e) => !e.rankCapped && e.rank !== null).map((e) => e.rank!)),
    medianDelaySec: median(others.map((e) => e.delaySec).filter((x): x is number => x !== null && Number.isFinite(x))),
    first20Rate: checked ? first20 / checked : null,
    ownLaunches: list.filter((e) => e.own).length,
    funderLaunches: funder ? list.filter((e) => e.funders).length : null,
    funder,
    topCreators,
    items: list,
    updatedAt: Date.now(),
  };
}

/** The /w/<addr> lead (pure; lives in ./walletSummary so the client view can import it). */
export { walletSummary } from "./walletSummary";
