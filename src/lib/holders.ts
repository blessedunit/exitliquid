// Top holders: the biggest wallets of a line and who first sent each of them ETH.
// Wallets whose ETH came from one source are grouped into a cluster ("funded from one source").
// Signals, not verdicts: a shared funder is a reason to look closer, never proof.
//
// Costs (measured 29.09 on $TREE and $WIND):
// - vibe: 1 call per token per 5 min (holders, shared cache).
// - explorer (Blockscout): 2 calls per NEW wallet (normal + internal tx lists, oldest first, 10 rows each),
//   at most MAX_NEW_PER_REQUEST wallets per request; the answer never changes, so it is kept "forever".
//   Plus, per new candidate source (faucet/hub check, at most MAX_HUB_CHECKS): 2 RPC calls (code + nonce),
//   and 1 explorer counters call only when the source is a contract.
//   A cold top-30 fills in 3 requests (~2-3 s each); after that 0 explorer calls.
import "server-only";
import { CHAIN_ID } from "./config";
import { BoundedTtlMap } from "./bounded";
import { client } from "./chain";
import { noteVibeStatus, vibeCoolingDown } from "./vibeCooldown";

const API = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
const VIBE_HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "Mozilla/5.0" };
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const EXPLORER_HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0" };

export const TOP_N = 30;
const MAX_NEW_PER_REQUEST = 10;
const MAX_HUB_CHECKS = 5;
const EXPLORER_CONCURRENCY = 6;
const EXPLORER_PER_MINUTE = 240; // per server instance, across all visitors
const FOREVER = 30 * 86_400_000; // a wallet's first funder never changes
export const HUB_CHILDREN = 50; // a source that funded more wallets than this is a faucet/hub, not a cluster
const HUB_TX_COUNT = 1_000;

/** Faucets and hubs on Robinhood testnet (checked on the explorer). */
export const KNOWN_HUBS = new Set([
  "0x8762f93772c663c6a88ba50900bd5381df2717be", // "Faucet" contract, 1.2M txs: first funder of most testnet wallets
]);

// Arbitrum-style chains: an L1 deposit arrives from the sender's L1 address + this offset
const ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;
const aliasOf = (a: string) => `0x${((BigInt(a) + ALIAS_OFFSET) % (1n << 160n)).toString(16).padStart(40, "0")}`;

export type Funding =
  | { kind: "source"; from: string; block: number } // first ETH from a wallet or contract before any activity
  | { kind: "faucet" } // only the public faucet funded it
  | { kind: "bridge" } // bridged its own ETH from L1
  | { kind: "none" }; // no incoming ETH found in the oldest rows: unknown source

export type HolderRow = {
  rank: number;
  address: string;
  shareBps: number;
  /** "pending" = not looked up yet (filled on a later request); "error" = explorer failed, retried later */
  status: "ok" | "pending" | "error";
  funding: Funding | null;
  cluster: number | null; // index into clusters
};
export type Cluster = { id: number; wallets: number; shareBps: number; source: string };
export type HoldersResponse = {
  token: string;
  rows: HolderRow[];
  clusters: Cluster[];
  clusteredBps: number; // share of supply held by wallets in clusters (checked wallets only)
  pending: number; // wallets not checked yet (unknown, not "no cluster")
  protocolSkipped: number;
  updatedAt: number;
};

/* ---------------- caches ---------------- */

const fundings = new BoundedTtlMap<Funding>(50_000);
const failedAt = new BoundedTtlMap<true>(5_000); // explorer failed: back off 2 min
const inflight = new Map<string, Promise<Funding | null>>();
const hubs = new BoundedTtlMap<boolean | null>(10_000); // null = unknown, kept 2 min only
// wallets we have seen funded by each source (capped): a cheap in-data faucet detector
const childrenOf = new BoundedTtlMap<Set<string>>(20_000);
const holdersMemo = new BoundedTtlMap<{ list: VibeHolder[]; protocol: number }>(2_000);
const holdersFailed = new BoundedTtlMap<string>(2_000); // vibe didn't answer for this token: don't ask again for 90 s

/* ---------------- explorer with a per-instance budget ---------------- */

let active = 0;
const queue: (() => void)[] = [];
let windowStart = 0;
let windowCalls = 0;

function budgetLeft() {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCalls = 0;
  }
  return EXPLORER_PER_MINUTE - windowCalls;
}

/** share of this minute's explorer budget still free (0..1): free analytics only spend the first half */
export function explorerBudgetShare(): number {
  return Math.max(0, budgetLeft()) / EXPLORER_PER_MINUTE;
}

export async function explorer<T>(path: string): Promise<T> {
  if (budgetLeft() <= 0) throw new Error("explorer budget");
  windowCalls++;
  if (active >= EXPLORER_CONCURRENCY) await new Promise<void>((res) => queue.push(res));
  active++;
  try {
    const r = await fetch(`${EXPLORER}${path}`, { headers: EXPLORER_HEADERS, cache: "no-store", signal: AbortSignal.timeout(7_000) });
    if (!r.ok) throw new Error(`explorer ${r.status}`);
    return (await r.json()) as T;
  } finally {
    active--;
    queue.shift()?.();
  }
}

type V1Tx = { blockNumber: string; transactionIndex?: string; index?: string; from: string; to: string; value: string; isError?: string };
type V1 = { status?: string; message?: string; result?: V1Tx[] | string };

async function v1List(action: "txlist" | "txlistinternal", address: string): Promise<V1Tx[]> {
  const j = await explorer<V1>(`/api?module=account&action=${action}&address=${address}&sort=asc&page=1&offset=10`);
  if (Array.isArray(j.result)) return j.result;
  // "No transactions found" / "No internal transactions found" is an answer; anything else (rate limit) is not
  if (j.status === "0" && /^No (internal )?transactions found/i.test(String(j.message ?? ""))) return [];
  throw new Error(`explorer: ${String(j.message ?? j.result ?? "bad answer").slice(0, 60)}`);
}

async function lookupFunding(address: string): Promise<Funding> {
  const [txs, internal] = await Promise.all([v1List("txlist", address), v1List("txlistinternal", address)]);
  const a = address.toLowerCase();
  const order = (x: V1Tx) => Number(x.blockNumber) * 1e6 + Number(x.transactionIndex ?? x.index ?? 0);
  const firstOut = txs.filter((x) => x.from?.toLowerCase() === a).reduce((m, x) => Math.min(m, Number(x.blockNumber)), Infinity);
  const incoming = [...txs, ...internal]
    .filter((x) => x.to?.toLowerCase() === a && x.isError !== "1" && /^\d+$/.test(x.value ?? "") && BigInt(x.value) > 0n)
    .sort((x, y) => order(x) - order(y));
  if (!incoming.length) return { kind: "none" };
  // ETH that arrived before the wallet did anything: later ETH can be sale proceeds from a curve
  const before = incoming.filter((x) => Number(x.blockNumber) <= firstOut);
  const self = aliasOf(a);
  for (const x of before) {
    const f = x.from.toLowerCase();
    if (KNOWN_HUBS.has(f) || f === self) continue;
    return { kind: "source", from: f, block: Number(x.blockNumber) };
  }
  const first = incoming[0].from.toLowerCase();
  if (KNOWN_HUBS.has(first)) return { kind: "faucet" };
  if (first === self) return { kind: "bridge" };
  return { kind: "none" };
}

export function funding(address: string): Promise<Funding | null> {
  const running = inflight.get(address);
  if (running) return running;
  const p = lookupFunding(address)
    .then((f) => {
      fundings.set(address, f, FOREVER);
      if (f.kind === "source") {
        const set = childrenOf.get(f.from) ?? new Set<string>();
        if (set.size <= HUB_CHILDREN) set.add(address);
        childrenOf.set(f.from, set, FOREVER);
      }
      return f;
    })
    .catch(() => {
      failedAt.set(address, true, 120_000);
      return null;
    })
    .finally(() => inflight.delete(address));
  inflight.set(address, p);
  return p;
}

/** A source that funded a crowd (faucet, exchange, bot hub) says nothing about who is behind a wallet. */
export async function isHub(source: string): Promise<boolean | null> {
  if (KNOWN_HUBS.has(source)) return true;
  if ((childrenOf.get(source)?.size ?? 0) > HUB_CHILDREN) return true;
  const cached = hubs.get(source);
  if (cached !== undefined) return cached;
  // Hubs are senders: the nonce (eth_getTransactionCount) is exact and one RPC call. The explorer
  // counter is stale on the first read (27, then 74 eight seconds later) and 0/missing = not counted yet,
  // so it is only used for contracts (their nonce counts deployments, not sends), and only a HIGH reading is
  // trusted (a stale counter under-reads, never over-reads).
  try {
    const [code, nonce] = await Promise.all([
      client.getCode({ address: source as `0x${string}` }),
      client.getTransactionCount({ address: source as `0x${string}` }),
    ]);
    const isContract = !!code && code !== "0x";
    if (!isContract) {
      const hub = nonce >= HUB_TX_COUNT;
      // a wallet's nonce only grows: "hub" is final; "not a hub" is re-read after a few hours
      hubs.set(source, hub, hub ? 86_400_000 : 6 * 3_600_000);
      return hub;
    }
    const c = await explorer<{ transactions_count?: string }>(`/api/v2/addresses/${source}/counters`).catch(() => null);
    const n = Number(c?.transactions_count);
    if (Number.isFinite(n) && n >= HUB_TX_COUNT) {
      hubs.set(source, true, 86_400_000);
      return true;
    }
    if (Number.isFinite(n) && n > 0) {
      hubs.set(source, false, 10 * 60_000); // low but maybe stale: re-check soon
      return false;
    }
  } catch {
    /* RPC failed: unknown */
  }
  hubs.set(source, null, 120_000); // unknown: the group is still shown (it IS one source), the check retries in 2 min
  return null;
}

/* ---------------- vibe holders ---------------- */

type VibeHolder = { rank: number; address: string; shareBps: number };

async function vibeHolders(token: string): Promise<{ list: VibeHolder[]; protocol: number }> {
  const hit = holdersMemo.get(token);
  if (hit) return hit;
  // a recent failure, or vibe throttling us: unknown now, no new call (every rebuild used to ask again)
  const failed = holdersFailed.get(token);
  if (failed) throw new Error(failed);
  if (vibeCoolingDown()) throw new Error("vibe api cooling down");
  let r: Response;
  try {
    r = await fetch(`${API}/launches/${token}/holders?limit=100`, { headers: VIBE_HEADERS, next: { revalidate: 300 }, signal: AbortSignal.timeout(8_000) });
  } catch (e) {
    holdersFailed.set(token, "vibe api unreachable", 90_000);
    throw e;
  }
  if (!r.ok) {
    noteVibeStatus(r.status);
    holdersFailed.set(token, `vibe api ${r.status}`, 90_000);
    throw new Error(`vibe api ${r.status}`);
  }
  const j = (await r.json()) as { data?: { items?: { rank?: number; address?: string; shareBps?: number; excludedAsProtocol?: boolean }[] } };
  const items = j.data?.items;
  if (!Array.isArray(items)) throw new Error("vibe api: no items");
  let protocol = 0;
  const list: VibeHolder[] = [];
  for (const x of items) {
    if (typeof x.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x.address)) continue;
    if (x.excludedAsProtocol) { protocol++; continue; } // the curve, the pool
    list.push({ rank: Number(x.rank) || list.length + 1, address: x.address.toLowerCase(), shareBps: Math.max(0, Number(x.shareBps) || 0) });
  }
  const v = { list: list.slice(0, TOP_N), protocol };
  holdersMemo.set(token, v, 300_000);
  return v;
}

/* ---------------- clusters ---------------- */

/**
 * `lookups: false` = cached funders only, no new explorer calls (the analytics pass it once half of this
 * minute's explorer budget is gone, so token-hopping can't starve the Top holders card).
 */
export async function topHolders(token: string, opts: { lookups?: boolean } = {}): Promise<HoldersResponse> {
  const t = token.toLowerCase();
  const { list, protocol } = await vibeHolders(t);
  const lookups = opts.lookups !== false;

  // look up at most MAX_NEW_PER_REQUEST wallets we don't know yet; the rest stay "pending"
  const toLookup = lookups ? list.filter((h) => !fundings.has(h.address) && !failedAt.has(h.address)).slice(0, MAX_NEW_PER_REQUEST) : [];
  if (toLookup.length) await Promise.all(toLookup.map((h) => funding(h.address)));

  const rows: HolderRow[] = list.map((h) => {
    const f = fundings.get(h.address) ?? null;
    return { rank: h.rank, address: h.address, shareBps: h.shareBps, status: f ? "ok" : failedAt.has(h.address) ? "error" : "pending", funding: f, cluster: null };
  });

  // union-find over holders and their sources: a source that is itself a top holder joins its children
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const add = (x: string) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const bySource = new Map<string, string[]>();
  for (const r of rows) if (r.funding?.kind === "source") bySource.set(r.funding.from, [...(bySource.get(r.funding.from) ?? []), r.address]);
  const holderSet = new Set(rows.map((r) => r.address));
  // only sources that link two or more top holders matter; check those for faucet/hub (a few calls, cached)
  const linking = [...bySource.entries()].filter(([src, kids]) => kids.length >= 2 || holderSet.has(src));
  let checks = 0;
  const hubVerdict = new Map<string, boolean | null>();
  await Promise.all(linking.map(async ([src]) => {
    const known = KNOWN_HUBS.has(src) || hubs.has(src) || (childrenOf.get(src)?.size ?? 0) > HUB_CHILDREN;
    if (!known && (!lookups || checks >= MAX_HUB_CHECKS)) { hubVerdict.set(src, null); return; }
    if (!known) checks++;
    hubVerdict.set(src, await isHub(src));
  }));
  for (const [src, kids] of linking) {
    if (hubVerdict.get(src) === true) continue;
    for (const k of kids) union(src, k);
  }

  const groups = new Map<string, HolderRow[]>();
  for (const r of rows) {
    if (!parent.has(r.address)) continue;
    const root = find(r.address);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  const clusters: Cluster[] = [];
  const sorted = [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([root, members]) => ({ root, members, share: members.reduce((s, m) => s + m.shareBps, 0) }))
    .sort((a, b) => b.share - a.share);
  sorted.forEach((g, id) => {
    // the source named for the group: the one that funded the most of its members
    let source = g.root;
    let most = 0;
    for (const [src, kids] of linking) {
      if (!parent.has(src) || find(src) !== find(g.root)) continue;
      if (kids.length > most) { most = kids.length; source = src; }
    }
    for (const m of g.members) m.cluster = id;
    clusters.push({ id, wallets: g.members.length, shareBps: g.share, source });
  });

  return {
    token: t,
    rows,
    clusters,
    clusteredBps: clusters.reduce((s, c) => s + c.shareBps, 0),
    pending: rows.filter((r) => r.status !== "ok").length,
    protocolSkipped: protocol,
    updatedAt: Date.now(),
  };
}
