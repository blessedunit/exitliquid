// Live market state of a vibe/vibe token: the bonding curve before graduation, the Uniswap V4 pool after.
// Server only. Every read is an eth_call against the contracts themselves (never the vibe API):
// - curve: virtualEthReserve / virtualTokenReserve / realEthReserve / curveTokensRemaining, quoteBuy / quoteSell
// - pool:  curve.graduationAdapter() -> adapter.poolKeyOf(token) -> poolId -> PoolManager.extsload (slot0, liquidity),
//          quotes from the V4 Quoter (it runs the hook, so the 1.25% hook fee is inside the quote)
// Swap sizes of graduated tokens come from the PoolManager's own Swap events (ETH side, exact).
import "server-only";
import { encodeAbiParameters, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { client } from "@/lib/chain";
import { BoundedTtlMap } from "@/lib/bounded";
import { FEE, buyOut, type Reserves } from "./cpmm";
import { IMPACT_SIZES } from "./compute";
import type { Market } from "./types";

export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const V4_QUOTER: Address = "0x498928d32bf7649587C4C2D2944038500644c950";
const ETH = "0x0000000000000000000000000000000000000000";
const SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f" as Hex; // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
const Q96 = 2 ** 96;

const curveAbi = parseAbi([
  "function virtualEthReserve() view returns (uint256)",
  "function virtualTokenReserve() view returns (uint256)",
  "function realEthReserve() view returns (uint256)",
  "function curveTokensRemaining() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function graduationAdapter() view returns (address)",
  "function quoteBuy(uint256 ethIn) view returns (uint256 tokensOut, uint256 ethIn_, uint256 ethNet)",
  "function quoteSell(uint256 tokensIn) view returns (uint256 ethNet, uint256 ethGross, uint256 fee)",
]);
const adapterAbi = parseAbi(["function poolKeyOf(address) view returns ((address,address,uint24,int24,address))"]);
const pmAbi = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)",
]);

type PoolKey = readonly [Address, Address, number, number, Address];
/** buyQuotes: the contract's own quote (tokens out) for each IMPACT_SIZES entry, read in the same batch; null = failed */
export type MarketState = Market & { reserves: Reserves; curve: string; poolKey: PoolKey | null; buyQuotes: (number | null)[] };

const wei = (v: bigint) => Number(v) / 1e18;
const toWei = (v: number) => BigInt(Math.floor(v * 1e18));

const memo = new BoundedTtlMap<MarketState>(300);
const keyMemo = new BoundedTtlMap<PoolKey>(2_000); // a pool key never changes once graduated
const inflight = new Map<string, Promise<MarketState>>();

/** Live state; cached 15 s per token. Throws when the contracts can't be read (unknown, not zero). */
export function marketOf(token: string, curve: string): Promise<MarketState> {
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

async function readMarket(token: string, curve: string): Promise<MarketState> {
  const c = { address: curve as Address, abi: curveAbi } as const;
  // one eth_call: the curve state AND the buy quotes for every impact size (a graduated curve's quotes just
  // fail, allowFailure keeps them unknown); before this the RPC saw 6 separate calls per rebuild
  const calls = [
    { ...c, functionName: "virtualEthReserve" },
    { ...c, functionName: "virtualTokenReserve" },
    { ...c, functionName: "realEthReserve" },
    { ...c, functionName: "curveTokensRemaining" },
    { ...c, functionName: "graduated" },
    { ...c, functionName: "graduationAdapter" },
    ...IMPACT_SIZES.map((eth) => ({ ...c, functionName: "quoteBuy", args: [toWei(eth)] })),
  ];
  const res = (await client.multicall({ contracts: calls as never, allowFailure: true })) as { status: "success" | "failure"; result?: unknown }[];
  const head = res.slice(0, 6);
  if (head.some((r) => r.status !== "success")) throw new Error("curve state unreadable");
  const [ve, vt, real, left, grad, adapter] = head.map((r) => r.result) as unknown as [bigint, bigint, bigint, bigint, boolean, Address];
  if (!grad) {
    const reserves = { e: wei(ve), t: wei(vt) };
    if (!(reserves.e > 0 && reserves.t > 0)) throw new Error("curve reserves unreadable");
    const buyQuotes = res.slice(6).map((r) => (r.status === "success" ? wei((r.result as readonly [bigint, bigint, bigint])[0]) : null));
    // the 0.1 ETH quote checks the model (a bonus: the reserves are still the contract's own)
    const q01 = buyQuotes[IMPACT_SIZES.indexOf(0.1)] ?? null;
    const modelCheck = q01 === null ? null : q01 / buyOut(reserves, 0.1).tokens;
    return {
      venue: "curve",
      spotEth: reserves.e / reserves.t,
      virtualEth: reserves.e,
      virtualTokens: reserves.t,
      fee: FEE,
      realEthReserve: wei(real),
      tokensLeft: wei(left),
      poolId: null,
      modelCheck,
      supply: null,
      mcapEth: null,
      reserves,
      curve,
      poolKey: null,
      buyQuotes,
    };
  }

  // graduated: the V4 pool behind the curve's own adapter (legacy and new adapters both answer poolKeyOf)
  let key = keyMemo.get(token);
  if (!key) {
    key = (await client.readContract({ address: adapter as Address, abi: adapterAbi, functionName: "poolKeyOf", args: [token as Address] })) as PoolKey;
    keyMemo.set(token, key, 30 * 86_400_000);
  }
  if (key[0].toLowerCase() !== ETH || key[1].toLowerCase() !== token) throw new Error("not an ETH pool");
  const poolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    key as unknown as [Address, Address, number, number, Address],
  ));
  // Pool.State lives at keccak(poolId, 6): slot0 at +0, liquidity at +3
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n])));
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
  // currency0 = ETH, currency1 = token, both 18 decimals: price(token per ETH) = sqrtP^2
  const reserves = { e: L / sqrtP / 1e18, t: (L * sqrtP) / 1e18 };
  const state: MarketState = {
    venue: "pool",
    spotEth: 1 / (sqrtP * sqrtP),
    virtualEth: reserves.e,
    virtualTokens: reserves.t,
    fee: FEE,
    realEthReserve: null,
    tokensLeft: null,
    poolId,
    modelCheck: null,
    supply: null,
    mcapEth: null,
    reserves,
    curve,
    poolKey: key,
    buyQuotes: IMPACT_SIZES.map(() => null),
  };
  state.buyQuotes = await quotePoolBatch(state, IMPACT_SIZES);
  const q = state.buyQuotes[IMPACT_SIZES.indexOf(0.1)] ?? null;
  state.modelCheck = q === null ? null : q / buyOut(reserves, 0.1).tokens;
  return state;
}

/** Several V4 quoter buys in one eth_call (multicall3; the quoter returns normally, so it batches). */
async function quotePoolBatch(m: MarketState, sizes: number[]): Promise<(number | null)[]> {
  if (!m.poolKey) return sizes.map(() => null);
  try {
    const res = await client.multicall({
      contracts: sizes.map((eth) => ({
        address: V4_QUOTER,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle" as const,
        args: [{ poolKey: m.poolKey!, zeroForOne: true, exactAmount: toWei(eth), hookData: "0x" as Hex }] as const,
      })),
      allowFailure: true,
    });
    return res.map((r) => (r.status === "success" ? wei((r.result as readonly [bigint, bigint])[0]) : null));
  } catch {
    // the batch itself failed: one by one (each failure stays unknown)
    return Promise.all(sizes.map((eth) => quotePool(m, true, eth)));
  }
}

async function quotePool(m: MarketState, buy: boolean, amount: number): Promise<number | null> {
  if (!m.poolKey) return null;
  try {
    const { result } = await client.simulateContract({
      address: V4_QUOTER,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: m.poolKey, zeroForOne: buy, exactAmount: toWei(amount), hookData: "0x" }],
    });
    return wei(result[0]);
  } catch {
    return null;
  }
}

/** The contract's own quote: tokens out for `eth` in. null = the quote failed (unknown). */
export async function quoteBuy(m: MarketState, eth: number): Promise<number | null> {
  // read in the same batch as the state: no second call for the impact sizes
  const i = IMPACT_SIZES.indexOf(eth);
  if (i >= 0) return m.buyQuotes[i] ?? null;
  if (m.venue === "pool") return quotePool(m, true, eth);
  try {
    const q = await client.readContract({ address: m.curve as Address, abi: curveAbi, functionName: "quoteBuy", args: [toWei(eth)] });
    return wei(q[0]);
  } catch {
    return null;
  }
}

/** The contract's own quote: ETH out (after the fee) for selling `tokens`. null = the quote failed or reverted. */
export async function quoteSell(m: MarketState, tokens: number): Promise<number | null> {
  if (m.venue === "pool") return quotePool(m, false, tokens);
  try {
    const q = await client.readContract({ address: m.curve as Address, abi: curveAbi, functionName: "quoteSell", args: [toWei(tokens)] });
    return wei(q[0]);
  } catch {
    return null;
  }
}

/* ---------------- V4 swap sizes (graduated tokens) ---------------- */

type SwapCache = { lastBlock: number; byTx: Map<string, number>; at: number };
const swaps = new BoundedTtlMap<SwapCache>(200);
const swapInflight = new Map<string, Promise<Map<string, number>>>();
const errText = (e: unknown) => String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? e);

async function pullSwaps(poolId: string, a: number, b: number, out: Map<string, number>, depth = 0): Promise<void> {
  try {
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [{ address: POOL_MANAGER, fromBlock: toHex(a), toBlock: toHex(b), topics: [SWAP_TOPIC, poolId] }],
    } as never)) as { transactionHash: string; data: Hex }[];
    for (const l of logs) {
      // amount0 is the ETH side (currency0 = ETH), signed int128 in the first data word
      let a0 = BigInt(`0x${l.data.slice(2, 66)}`);
      if (a0 >= 1n << 255n) a0 -= 1n << 256n;
      const eth = Math.abs(Number(a0)) / 1e18;
      const tx = l.transactionHash.toLowerCase();
      out.set(tx, (out.get(tx) ?? 0) + eth);
    }
  } catch (e) {
    const m = errText(e);
    if (/429|rate limit/i.test(m) && depth < 4) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** depth));
      return pullSwaps(poolId, a, b, out, depth + 1);
    }
    if (/exceeds limit|timed? ?out|too many|range/i.test(m) && b > a && depth < 10) {
      const mid = Math.floor((a + b) / 2);
      await pullSwaps(poolId, a, mid, out, depth + 1);
      await pullSwaps(poolId, mid + 1, b, out, depth + 1);
      return;
    }
    throw e;
  }
}

/**
 * ETH size of every swap in this pool, by tx hash, from `fromBlock` to `toBlock` (the transfer log's head,
 * so both logs end at the same block). Incremental: a warm pool costs one small getLogs.
 */
export async function poolSwapEth(poolId: string, fromBlock: number, toBlock: number): Promise<Map<string, number>> {
  const hit = swaps.get(poolId);
  if (hit && hit.lastBlock >= toBlock) return hit.byTx;
  const running = swapInflight.get(poolId);
  if (running) return running;
  const job = (async () => {
    const cache = hit ?? { lastBlock: fromBlock - 1, byTx: new Map<string, number>(), at: 0 };
    const start = cache.lastBlock + 1;
    const WINDOW = 2_000_000;
    for (let s = start; s <= toBlock; s += WINDOW) await pullSwaps(poolId, s, Math.min(toBlock, s + WINDOW - 1), cache.byTx);
    cache.lastBlock = toBlock;
    cache.at = Date.now();
    swaps.set(poolId, cache, 6 * 3_600_000);
    return cache.byTx;
  })().finally(() => swapInflight.delete(poolId));
  swapInflight.set(poolId, job);
  return job;
}
