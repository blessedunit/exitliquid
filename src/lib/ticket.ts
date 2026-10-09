import "server-only";
import { buildState, toQueueResponse, wireEntry, wireExit, type Built } from "./service";
import { client } from "./chain";
import { ethUsdPrice } from "./ethPrice";
import { BoundedTtlMap } from "./bounded";
import type { Hex } from "viem";
import { groupFor, tierFor, TIERS } from "./queue";
import { stockBalances } from "./stocks";
import type { TicketPnl, TicketResponse } from "./types";

export const TIER_MULT: Record<number, number> = { 1: 1, 2: 1.1, 3: 1.25, 4: 1.4, 5: 1.6 };
export const STOCK_BONUS = 0.1;

const SEL_QUOTE_SELL = "0xa64190c4"; // quoteSell(uint256) -> (netEthOut, grossEthOut, fee)
const quotes = new BoundedTtlMap<number | null>(5_000);

/** ETH the curve pays for this many tokens right now, after the fee. null = unknown (never 0 by guess). */
async function sellQuote(curve: string, balance: bigint): Promise<number | null> {
  if (balance <= 0n) return 0;
  const key = `${curve}:${balance}`;
  const hit = quotes.get(key);
  if (hit !== undefined) return hit;
  let v: number | null = null;
  try {
    const r = await Promise.race([
      client.call({ to: curve as Hex, data: (SEL_QUOTE_SELL + balance.toString(16).padStart(64, "0")) as Hex }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4_000)),
    ]);
    if (r.data && r.data.length >= 66) v = Number(BigInt(r.data.slice(0, 66))) / 1e18;
  } catch {
    v = null;
  }
  quotes.set(key, v, v === null ? 5_000 : 15_000);
  return v;
}

export function isAddress(a: string) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

export async function getTicket(addr: string, built?: Built, opts: { priority?: boolean } = {}): Promise<TicketResponse> {
  const wallet = addr.toLowerCase();
  const b = built ?? (await buildState());
  const entry = b.state.line.find((e) => e.wallet === wallet);
  const exit = b.state.exits.find((x) => x.wallet === wallet);
  const stocks = b.mode === "mock" ? null : await stockBalances(wallet, opts);
  const stockBacked = stocks && stocks.length > 0;
  // boosts only exist for the real $EXIT line (never for the preview token)
  let multiplier = 1;
  if (b.mode === "live") {
    // the stock bonus is for people in line, like the rank boost
    if (entry) multiplier = (TIER_MULT[entry.tier] ?? 1) + (stockBacked ? STOCK_BONUS : 0);
  }
  const tierName = entry ? (entry.isCreator ? "The Dev" : TIERS.find((t) => t.tier === entry.tier)?.name) : undefined;
  let pnl: TicketPnl | undefined;
  if (entry && b.meta?.curve && b.mode !== "mock" && !b.unavailable) {
    const graduated = !!b.meta.graduated;
    const [quote, ethUsd] = await Promise.all([graduated ? Promise.resolve(null) : sellQuote(b.meta.curve, entry.balance), ethUsdPrice()]);
    const mark = graduated ? toQueueResponse(b, 1) : null;
    pnl = {
      sellQuoteEth: quote,
      graduated,
      markPriceEth: mark?.markPriceEth ?? null,
      markPriceTs: mark?.markPriceTs ?? null,
      ethUsd,
      asOf: Date.now(),
    };
  }
  return {
    mode: b.mode,
    token: b.token,
    wallet,
    status: b.unavailable ? "unknown" : entry ? "in_line" : exit ? "exited" : "never",
    entry: entry ? wireEntry(entry) : undefined,
    exit: exit ? wireExit(exit) : undefined,
    inLine: b.state.totals.inLine,
    group: entry ? groupFor(entry.place, entry.isCreator) : undefined,
    tierName,
    stockBacked: stocks,
    multiplier: Math.round(multiplier * 100) / 100,
    pnl,
  };
}

export { tierFor };
