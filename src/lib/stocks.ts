// Testnet stock tokens minted by the Robinhood Chain faucet.
// Addresses and symbol()/decimals() verified with eth_call.
import "server-only";
import { erc20Abi, type Address } from "viem";
import { client } from "./chain";
import { BoundedTtlMap } from "./bounded";

export const STOCK_TOKENS: { symbol: string; address: Address }[] = [
  { symbol: "TSLA", address: "0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e" },
  { symbol: "AMZN", address: "0x5884ad2f920c162cfbbacc88c9c51aa75ec09e02" },
  { symbol: "PLTR", address: "0x1fbe1a0e43594b3455993b5de5fd0a7a266298d0" },
  { symbol: "NFLX", address: "0x3b8262a63d25f0477c4dde23f83cfe22cb768c93" },
  { symbol: "AMD", address: "0x71178bac73cbeb415514eb542a8995b82669778d" },
  { symbol: "SPCX", address: "0x5a5398155d98374c0e26265ea3cb9818169c2739" },
];

type Holdings = { symbol: string; balance: string }[];

// /api/ticket/<any address>, /t/<any address> and its OG image all end up here, and a
// random address is a CDN miss, so without limits every request = one RPC call we pay for.
// - results cached per wallet (bounded, 60 s), concurrent lookups of one wallet share a call;
// - at most MAX_INFLIGHT multicalls at once and BUDGET_PER_SEC new ones per second per
//   instance; over budget the answer is null ("unknown", never "holds none").
const cache = new BoundedTtlMap<Holdings | null>(5_000);
const inflight = new Map<string, Promise<Holdings | null>>();
const MAX_INFLIGHT = 8;
const BUDGET_PER_SEC = 10;
let budget = { sec: 0, used: 0 };

function takeBudget(): boolean {
  const sec = Math.floor(Date.now() / 1000);
  if (budget.sec !== sec) budget = { sec, used: 0 };
  if (budget.used >= BUDGET_PER_SEC) return false;
  budget.used++;
  return true;
}

// null = could not read (unknown), [] = read fine, holds none.
export async function stockBalances(wallet: string, opts: { priority?: boolean } = {}): Promise<Holdings | null> {
  const w = wallet.toLowerCase();
  const hit = cache.get(w);
  if (hit !== undefined) return hit;
  const running = inflight.get(w);
  if (running) return running;
  if (!opts.priority && (inflight.size >= MAX_INFLIGHT || !takeBudget())) return null;
  const job = readStocks(w).finally(() => inflight.delete(w));
  inflight.set(w, job);
  const v = await job;
  cache.set(w, v, v === null ? 10_000 : 60_000);
  return v;
}

async function readStocks(wallet: string): Promise<Holdings | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      client.multicall({
        contracts: STOCK_TOKENS.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet as Address] })),
        allowFailure: true,
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("stocks timeout")), 6_000);
      }),
    ]);
    const held = STOCK_TOKENS.map((t, i) => ({
      symbol: t.symbol,
      balance: res[i].status === "success" ? String(res[i].result) : "0",
    })).filter((b) => b.balance !== "0");
    // a failed read is unknown, not zero: "holds none" only if every read succeeded
    if (!held.length && res.some((r) => r.status !== "success")) return null;
    return held;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
