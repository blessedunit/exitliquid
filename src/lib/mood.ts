// Market Mood: daily % change of the testnet's stock names from a public feed.
// Yahoo chart meta (regularMarketPrice vs chartPreviousClose), CNBC as fallback.
// Both verified keyless from a server on 23.09.
import "server-only";
import type { MoodResponse } from "./types";

export const STOCKS = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];
// Average daily move beyond ±0.5% counts as a red (panic) or green (calm) day.
export const PANIC_AT = 0.5;
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36" };

type Q = { symbol: string; changePct: number | null; close: number | null; date: string | null };

async function yahoo(sym: string): Promise<Q> {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`, {
    headers: UA,
    cache: "no-store", // the in-process memo below already limits calls (a data-cache hit could be hours old)
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  const p = Number(m?.regularMarketPrice);
  const prev = Number(m?.chartPreviousClose);
  if (!p || !prev) throw new Error("yahoo empty");
  return {
    symbol: sym,
    close: p,
    changePct: (p / prev - 1) * 100,
    date: m?.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10) : null,
  };
}

async function cnbc(): Promise<Q[]> {
  const u = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${STOCKS.join("%7C")}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
  const r = await fetch(u, { headers: UA, cache: "no-store", signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`cnbc ${r.status}`);
  const q = (await r.json())?.FormattedQuoteResult?.FormattedQuote as
    | { symbol: string; last: string; change_pct: string; last_time: string }[]
    | undefined;
  if (!q?.length) throw new Error("cnbc empty");
  return q.map((x) => ({
    symbol: x.symbol,
    close: Number(String(x.last).replace(/,/g, "")) || null,
    changePct: Number.isFinite(parseFloat(x.change_pct)) ? parseFloat(x.change_pct) : null,
    date: x.last_time ? x.last_time.slice(0, 10) : null,
  }));
}

let memo: { at: number; ttl: number; value: MoodResponse } | null = null;
let pending: Promise<MoodResponse> | null = null;

// One shared fetch at a time; a known mood is kept 30 min, an unknown one 60 s (so a feed
// outage doesn't turn every request into 6 outbound calls, and recovers quickly).
export function getMood(): Promise<MoodResponse> {
  if (memo && Date.now() - memo.at < memo.ttl) return Promise.resolve(memo.value);
  pending ??= fetchMood().finally(() => {
    pending = null;
  });
  return pending;
}

async function fetchMood(): Promise<MoodResponse> {
  let qs: Q[];
  let source = "Yahoo Finance";
  const y = await Promise.allSettled(STOCKS.map(yahoo));
  qs = y.map((r, i) => (r.status === "fulfilled" ? r.value : { symbol: STOCKS[i], changePct: null, close: null, date: null }));
  if (qs.filter((q) => q.changePct !== null).length < 3) {
    try {
      qs = await cnbc();
      source = "CNBC";
    } catch {
      /* keep partial yahoo */
    }
  }
  const known = qs.filter((q) => q.changePct !== null);
  const avg = known.length >= 3 ? known.reduce((s, q) => s + (q.changePct as number), 0) / known.length : null;
  const value: MoodResponse = {
    // neutral band so a -0.04% day doesn't scream PANIC
    mood: avg === null ? "unknown" : avg <= -PANIC_AT ? "panic" : avg >= PANIC_AT ? "calm" : "normal",
    multiplier: avg !== null && avg <= -PANIC_AT ? 2 : 1,
    avgChangePct: avg === null ? null : Math.round(avg * 100) / 100,
    asOf: known[0]?.date ?? null,
    quotes: qs.map((q) => ({ symbol: q.symbol, changePct: q.changePct === null ? null : Math.round(q.changePct * 100) / 100, close: q.close })),
    source,
  };
  memo = { at: Date.now(), ttl: value.mood === "unknown" ? 60_000 : 30 * 60_000, value };
  return value;
}
