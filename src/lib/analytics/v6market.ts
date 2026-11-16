// Chain reads for taxed v6 launches (factory 0xe794…). Server only. Everything here is an eth_call or a log
// of the contracts themselves, never the vibe API.
//
// Measured 16.10 on PAK07ADS (curve), LEADER (graduated, V4 pool), the curve is not verified; selectors from
// its bytecode, names matched on the 4byte database, outputs checked against vibe's own trade records:
// - curve is x*y=k on virtual reserves: reserveAt(sold) = V*sold/(T-sold) (fit exact to 1e-15 on 11 points,
//   V=1.3333 ETH, T=1066.67M tokens for a 4 ETH target). spot = (V+R)^2/(V*T) = e/t with e=V+R, t=T-sold.
// - every trade pays the token's tax per side, part in the pair (fee) and part in tokens (tax transfer
//   curve/pool -> token contract): (1-pairFee)*(1-tokenTax) = 1 - taxBps (2% tax: 0.715% + 1.28%).
// - Buy(actor, recipient) data [grossTokens, netTokens, taxTokens, pairNet, pairFee, rateBps]: the buyer paid
//   pairNet + pairFee (= tx value on ETH pairs). Sell(actor, recipient) data [grossTokens, netTokens, taxTokens,
//   pairGross, pairFee]: the seller got pairGross - pairFee.
// - after graduation the token trades in a Uniswap V4 pool (PoolManager 0x8366…, poolId from curve.poolId());
//   wallets trade through vibe's zap 0x2784… (PM -> zap -> buyer, seller -> zap -> PM).
import "server-only";
import { encodeAbiParameters, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { client } from "@/lib/chain";
import { BoundedTtlMap } from "@/lib/bounded";
import { POOL_MANAGER } from "@/lib/factories";
import type { Reserves } from "./cpmm";

const BUY_TOPIC = "0x55867fe9a84ea30ad247ef1bb703eba47fd9af476149002512a2814b1e3d8fb5";
const SELL_TOPIC = "0x3899b2b9ba4dfe77b54ff5e6f921672b2a7563ade468f2a106b25a4b808d60de";
// the creator's buy inside the launch tx: (recipient) data [grossTokens, netTokens, pairNet, pairFee]
const INITIAL_BUY_TOPIC = "0x5b18697b3628e2e1fc787629f624c31f0e98e273ced4f25efbb83d3865368dda";
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const ZERO = "0x0000000000000000000000000000000000000000";
const Q96 = 2 ** 96;

const curveAbi = parseAbi([
  "function sold() view returns (uint256)",
  "function remainingInventory() view returns (uint256)",
  "function complete() view returns (bool)",
  "function currentRateBps() view returns (uint256)",
  "function pairCurrency() view returns (address)",
  "function poolId() view returns (bytes32)",
  "function reserveAt(uint256) view returns (uint256)",
  "function quoteBuyExactIn(uint256 pairIn) view returns (uint256 grossTokens, uint256 netTokens, uint256 pairNet, uint256 pairFee, uint256 refund)",
  "function quoteSell(uint256 tokensIn) view returns (uint256 netTokens, uint256 pairGross, uint256 pairFee, uint256 pairNet)",
]);
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const pmAbi = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);

const whole = (v: bigint, dec = 18) => Number(v) / 10 ** dec;
const toUnits = (v: number, dec = 18) => BigInt(Math.floor(v * 10 ** Math.min(dec, 18))) * 10n ** BigInt(Math.max(0, dec - 18));

export type V6Pair = { address: string | null; native: boolean; decimals: number | null; symbol: string | null };

export type V6Market = {
  venue: "curve" | "pool";
  pair: V6Pair;
  /** pair units per whole token */
  spot: number;
  reserves: Reserves;
  /** per-side cost (tax), as a fraction */
  fee: number;
  rateBps: number | null;
  /** curve: real pair reserve and tokens left to buy; target = reserve at a full curve */
  realReserve: number | null;
  tokensLeft: number | null;
  target: number | null;
  poolId: string | null;
  /** the contract's quotes for the impact sizes: net tokens out; null = failed */
  buyQuotes: (number | null)[];
  sizes: number[];
  modelCheck: number | null;
  curve: string;
};

/* ---------------- pair facts (never change) ---------------- */

const pairMemo = new BoundedTtlMap<V6Pair>(2_000);
async function pairOf(curve: string): Promise<V6Pair> {
  const hit = pairMemo.get(curve);
  if (hit) return hit;
  const addr = ((await client.readContract({ address: curve as Address, abi: curveAbi, functionName: "pairCurrency" })) as string).toLowerCase();
  if (addr === ZERO) {
    const p = { address: null, native: true, decimals: 18, symbol: "ETH" };
    pairMemo.set(curve, p, 30 * 86_400_000);
    return p;
  }
  const r = await client.multicall({
    contracts: [{ address: addr as Address, abi: erc20, functionName: "decimals" }, { address: addr as Address, abi: erc20, functionName: "symbol" }],
    allowFailure: true,
  });
  const p: V6Pair = {
    address: addr,
    native: false,
    decimals: r[0].status === "success" ? Number(r[0].result) : null,
    symbol: r[1].status === "success" ? String(r[1].result).replace(/[^\w.$-]/g, "").slice(0, 16) || null : null,
  };
  // a failed read is retried in 10 min, a full answer is kept
  pairMemo.set(curve, p, p.decimals !== null && p.symbol ? 30 * 86_400_000 : 600_000);
  return p;
}

/* ---------------- the curve's virtual reserves (fit once per curve) ---------------- */

const virtMemo = new BoundedTtlMap<{ V: number; T: number }>(2_000);
async function virtualOf(curve: string, inventory: bigint, dec: number): Promise<{ V: number; T: number }> {
  const hit = virtMemo.get(curve);
  if (hit) return hit;
  const s1 = inventory / 8n;
  const s2 = inventory / 2n;
  const [a, b] = await client.multicall({
    contracts: [
      { address: curve as Address, abi: curveAbi, functionName: "reserveAt", args: [s1] },
      { address: curve as Address, abi: curveAbi, functionName: "reserveAt", args: [s2] },
    ],
    allowFailure: false,
  });
  const x1 = whole(s1), x2 = whole(s2), r1 = whole(a as bigint, dec), r2 = whole(b as bigint, dec);
  // R(s) = V*s/(T-s) through two points
  const det = s1 === s2 ? 0 : -r1 * x2 + x1 * r2;
  if (!(det > 0)) throw new Error("curve shape unreadable");
  const v = { V: (r1 * r2 * (x2 - x1)) / det, T: (x1 * x2 * (r2 - r1)) / det };
  if (!(v.V > 0 && v.T > 0)) throw new Error("curve shape unreadable");
  virtMemo.set(curve, v, 30 * 86_400_000);
  return v;
}

/** impact sizes: 0.1 / 0.5 / 1 ETH like v1; a token pair gets round sizes of its own scale (about 1-25% of the virtual reserve) */
function sizesFor(native: boolean, virtualPair: number): number[] {
  if (native) return [0.1, 0.5, 1];
  const base = 10 ** Math.floor(Math.log10(Math.max(1e-12, virtualPair / 40)));
  return [base, base * 5, base * 10];
}

/* ---------------- live state ---------------- */

const memo = new BoundedTtlMap<V6Market>(500);
const inflight = new Map<string, Promise<V6Market>>();

/** Live curve or pool state of a v6 token; 15 s per token. Throws when the contracts can't be read. */
export function v6MarketOf(token: string, curve: string): Promise<V6Market> {
  const t = token.toLowerCase();
  const hit = memo.get(t);
  if (hit) return Promise.resolve(hit);
  let job = inflight.get(t);
  if (!job) {
    job = readMarket(t, curve.toLowerCase())
      .then((m) => {
        memo.set(t, m, 15_000);
        return m;
      })
      .finally(() => inflight.delete(t));
    inflight.set(t, job);
  }
  return job;
}

async function readMarket(token: string, curve: string): Promise<V6Market> {
  const c = { address: curve as Address, abi: curveAbi } as const;
  const [pair, head] = await Promise.all([
    pairOf(curve),
    client.multicall({
      contracts: [
        { ...c, functionName: "sold" },
        { ...c, functionName: "remainingInventory" },
        { ...c, functionName: "complete" },
        { ...c, functionName: "currentRateBps" },
        { ...c, functionName: "poolId" },
      ],
      allowFailure: true,
    }),
  ]);
  if (head.slice(0, 3).some((r) => r.status !== "success")) throw new Error("curve state unreadable");
  const sold = head[0].result as bigint;
  const left = head[1].result as bigint;
  const complete = head[2].result as boolean;
  const rateBps = head[3].status === "success" ? Number(head[3].result) : null;
  const poolIdRaw = head[4].status === "success" ? (head[4].result as Hex) : null;
  const dec = pair.decimals ?? 18;
  // the tax is the cost of every exit quote: unread (or not a rate) = the market is unread, never "0% fee"
  if (rateBps === null || !(rateBps >= 0 && rateBps < 10_000)) throw new Error("curve tax unreadable");
  const fee = rateBps / 10_000;
  const poolId = poolIdRaw && BigInt(poolIdRaw) !== 0n ? poolIdRaw.toLowerCase() : null;

  if (!complete || !poolId) {
    const inventory = sold + left;
    const [virt, more] = await Promise.all([
      virtualOf(curve, inventory, dec),
      client.multicall({
        contracts: [
          { ...c, functionName: "reserveAt", args: [sold] },
          { ...c, functionName: "reserveAt", args: [inventory] },
        ],
        allowFailure: true,
      }),
    ]);
    const real = more[0].status === "success" ? whole(more[0].result as bigint, dec) : null;
    const target = more[1].status === "success" ? whole(more[1].result as bigint, dec) : null;
    const R = real ?? (virt.V * whole(sold)) / (virt.T - whole(sold));
    const reserves = { e: virt.V + R, t: virt.T - whole(sold) };
    if (!(reserves.e > 0 && reserves.t > 0)) throw new Error("curve reserves unreadable");
    const sizes = sizesFor(pair.native, reserves.e);
    let buyQuotes: (number | null)[] = sizes.map(() => null);
    try {
      const q = await client.multicall({
        contracts: sizes.map((s) => ({ ...c, functionName: "quoteBuyExactIn" as const, args: [toUnits(s, dec)] as const })),
        allowFailure: true,
      });
      buyQuotes = q.map((r) => (r.status === "success" ? whole((r.result as readonly bigint[])[1]) : null));
    } catch { /* quotes unknown, the model stays */ }
    const q0 = buyQuotes[0];
    const model = modelBuy(reserves, sizes[0], fee);
    return {
      venue: "curve", pair, spot: reserves.e / reserves.t, reserves, fee, rateBps,
      realReserve: R, tokensLeft: whole(left), target, poolId: null,
      buyQuotes, sizes, modelCheck: q0 && model > 0 ? q0 / model : null, curve,
    };
  }

  // graduated: the V4 pool's slot0 and liquidity (Pool.State at keccak(poolId, 6): slot0 +0, liquidity +3)
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId as Hex, 6n])));
  const [s0, liq] = await client.multicall({
    contracts: [
      { address: POOL_MANAGER as Address, abi: pmAbi, functionName: "extsload", args: [toHex(base, { size: 32 })] },
      { address: POOL_MANAGER as Address, abi: pmAbi, functionName: "extsload", args: [toHex(base + 3n, { size: 32 })] },
    ],
    allowFailure: false,
  });
  const sqrtP = Number(BigInt(s0) & ((1n << 160n) - 1n)) / Q96;
  const L = Number(BigInt(liq) & ((1n << 128n) - 1n));
  if (!(sqrtP > 0 && L > 0)) throw new Error("pool empty");
  // currency0 is the lower address: native ETH (0x0) always; a token pair whichever sorts first
  const pairIs0 = pair.native || (pair.address !== null && pair.address < token);
  const r0 = L / sqrtP; // raw units of currency0
  const r1 = L * sqrtP; // raw units of currency1
  const reserves = pairIs0 ? { e: r0 / 10 ** dec, t: r1 / 1e18 } : { e: r1 / 10 ** dec, t: r0 / 1e18 };
  if (!(reserves.e > 0 && reserves.t > 0)) throw new Error("pool empty");
  const sizes = sizesFor(pair.native, reserves.e);
  return {
    venue: "pool", pair, spot: reserves.e / reserves.t, reserves, fee, rateBps,
    realReserve: null, tokensLeft: null, target: null, poolId,
    buyQuotes: sizes.map(() => null), sizes, modelCheck: null, curve,
  };
}

function modelBuy(r: Reserves, pairIn: number, fee: number): number {
  const net = pairIn * (1 - fee);
  return r.t - (r.e * r.t) / (r.e + net);
}

/** The curve's own quote: pair out (after the fee) for selling `tokens`. null = failed / not a curve. */
export async function v6QuoteSell(m: V6Market, tokens: number): Promise<number | null> {
  if (m.venue !== "curve" || !(tokens > 0)) return null;
  try {
    const q = await client.readContract({ address: m.curve as Address, abi: curveAbi, functionName: "quoteSell", args: [toUnits(tokens)] });
    return whole(q[3], m.pair.decimals ?? 18);
  } catch {
    return null;
  }
}

/* ---------------- logs: curve trades and pool swaps (incremental) ---------------- */

type AnyLog = { transactionHash: string; topics: string[]; data: string; blockNumber: string };
const errText = (e: unknown) => String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? e);

async function pull(filter: Record<string, unknown>, a: number, b: number, out: AnyLog[], depth = 0): Promise<void> {
  try {
    const logs = (await client.request({ method: "eth_getLogs", params: [{ ...filter, fromBlock: toHex(a), toBlock: toHex(b) }] } as never)) as AnyLog[];
    out.push(...logs);
  } catch (e) {
    const m = errText(e);
    if (/429|rate limit/i.test(m) && depth < 4) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** depth));
      return pull(filter, a, b, out, depth + 1);
    }
    if (/exceeds limit|timed? ?out|too many|range/i.test(m) && b > a && depth < 12) {
      const mid = Math.floor((a + b) / 2);
      await pull(filter, a, mid, out, depth + 1);
      await pull(filter, mid + 1, b, out, depth + 1);
      return;
    }
    throw e;
  }
}

const WINDOW = 2_000_000;
type LogCache = { lastBlock: number; logs: AnyLog[] };
const logCaches = new BoundedTtlMap<LogCache>(300);
const logInflight = new Map<string, Promise<AnyLog[]>>();
async function logsOf(key: string, filter: Record<string, unknown>, from: number, to: number): Promise<AnyLog[]> {
  const hit = logCaches.get(key);
  if (hit && hit.lastBlock >= to) return hit.logs;
  const running = logInflight.get(key);
  if (running) return running;
  const job = (async () => {
    const cache = hit ?? { lastBlock: from - 1, logs: [] };
    const fresh: AnyLog[] = [];
    for (let s = cache.lastBlock + 1; s <= to; s += WINDOW) await pull(filter, s, Math.min(to, s + WINDOW - 1), fresh);
    const next = { lastBlock: Math.max(cache.lastBlock, to), logs: cache.logs.concat(fresh) };
    logCaches.set(key, next, 6 * 3_600_000);
    return next.logs;
  })().finally(() => logInflight.delete(key));
  logInflight.set(key, job);
  return job;
}

const word = (data: string, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1)) || "0"}`);
const int128 = (data: string, i: number) => {
  let v = word(data, i);
  if (v >= 1n << 255n) v -= 1n << 256n;
  return v < 0n ? -v : v;
};

/** per tx: pair paid by buyers (fee included) and pair received by sellers (fee taken), in pair units */
export type CurveTx = { buyPair: number; buyTokens: number; sellPair: number; sellTokens: number };
export type CurveTrades = { byTx: Map<string, CurveTx>; feesPair: number; buys: number; sells: number };

export async function v6CurveTrades(curve: string, fromBlock: number, toBlock: number, dec: number): Promise<CurveTrades> {
  // every log of the curve, filtered here: a topic OR-list drops the node's span cap to 100k blocks
  const logs = await logsOf(`ct:${curve}`, { address: curve }, fromBlock, toBlock);
  const byTx = new Map<string, CurveTx>();
  let fees = 0, buys = 0, sells = 0;
  const u = (v: bigint) => Number(v) / 10 ** dec;
  for (const l of logs) {
    const t0 = l.topics[0]?.toLowerCase();
    const tx = l.transactionHash.toLowerCase();
    const row = byTx.get(tx) ?? { buyPair: 0, buyTokens: 0, sellPair: 0, sellTokens: 0 };
    if (t0 === INITIAL_BUY_TOPIC) {
      const net = word(l.data, 1), pairNet = word(l.data, 2), pairFee = word(l.data, 3);
      row.buyPair += u(pairNet + pairFee);
      row.buyTokens += Number(net / 10n ** 12n) / 1e6;
      fees += u(pairFee);
      buys++;
    } else if (t0 === BUY_TOPIC) {
      const net = word(l.data, 1), pairNet = word(l.data, 3), pairFee = word(l.data, 4);
      row.buyPair += u(pairNet + pairFee);
      row.buyTokens += Number(net / 10n ** 12n) / 1e6;
      fees += u(pairFee);
      buys++;
    } else if (t0 === SELL_TOPIC) {
      const gross = word(l.data, 0), pairGross = word(l.data, 3), pairFee = word(l.data, 4);
      row.sellPair += u(pairGross > pairFee ? pairGross - pairFee : 0n);
      row.sellTokens += Number(gross / 10n ** 12n) / 1e6;
      fees += u(pairFee);
      sells++;
    } else continue;
    byTx.set(tx, row);
  }
  return { byTx, feesPair: fees, buys, sells };
}

/** per tx: the pair side of the pool swap (pair units, absolute), from the PoolManager's own Swap events */
export async function v6PoolSwaps(poolId: string, pairIs0: boolean, dec: number, fromBlock: number, toBlock: number): Promise<Map<string, number>> {
  const logs = await logsOf(`ps:${poolId}`, { address: POOL_MANAGER, topics: [SWAP_TOPIC, poolId] }, fromBlock, toBlock);
  const out = new Map<string, number>();
  for (const l of logs) {
    const amt = int128(l.data, pairIs0 ? 0 : 1);
    const tx = l.transactionHash.toLowerCase();
    out.set(tx, (out.get(tx) ?? 0) + Number(amt) / 10 ** dec);
  }
  return out;
}

// emitted by the token once per gift-list delivery batch (up to 256 wallets per tx; 16 txs for 3,879 gifts)
const GIFT_BATCH_TOPIC = "0x43a91e6c9086bb050583dd8d0ae41b67d0c672246a68d47d6856113444a83890";

/** tx hashes of the token's gift-list deliveries (amounts differ per wallet: the batch event marks them) */
export async function v6GiftTxs(token: string, fromBlock: number, toBlock: number): Promise<Set<string>> {
  const logs = await logsOf(`gt:${token}`, { address: token, topics: [GIFT_BATCH_TOPIC] }, fromBlock, toBlock);
  return new Set(logs.map((l) => l.transactionHash.toLowerCase()));
}
