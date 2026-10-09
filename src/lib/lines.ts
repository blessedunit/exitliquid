// My Lines: every vibe/vibe token a wallet holds, and where it stands in each token's line.
// Read-only, straight from the chain. Unknown is reported as unknown, never as zero.
import "server-only";
import { erc20Abi, parseAbi, type Address } from "viem";
import { ACTIVE_TOKEN, IS_LIVE, EXIT_CREATOR } from "./config";
import { client, cleanText, fetchLaunch, loadEvents, toBalanceEvents, tokensReceivedBy, verifyLaunches, ZERO, type LaunchMeta } from "./chain";
import { buildQueue, curvePrice, TIERS, type QueueState } from "./queue";
import { buildState, PLUMBING } from "./service";
import { stockBalances, STOCK_TOKENS } from "./stocks";
import { BoundedTtlMap } from "./bounded";

const tokenMeta = parseAbi([
  "function curve() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const curveRead = parseAbi(["function curveTokensRemaining() view returns (uint256)", "function graduated() view returns (bool)"]);
const CURVE_TOKENS = 793_100_000; // standard vibe curve allocation (whole tokens)
const MAX_SCAN = 200; // tokens checked per wallet

export type Holding = {
  token: string;
  name: string;
  symbol: string;
  balance: string; // base units
  tokens: number; // whole tokens (approx)
  valueEth: number | null; // at the curve's spot price; null after graduation (price lives in the pool)
  progressBps: number | null;
  graduated: boolean | null; // null = the curve didn't answer (unknown, not "still on the curve")
  isExit: boolean;
};

export type WalletScan = {
  wallet: string;
  eth: number | null;
  stocks: { symbol: string; balance: string }[] | null;
  holdings: Holding[];
  scanned: number;
  truncated: boolean;
  unknownTokens: number; // tokens whose curve/balance couldn't be read right now (unknown, not empty)
};

/** Only a complete scan may be cached: a partial one would hide tokens for the whole TTL. */
export function scanComplete(s: WalletScan) {
  return s.eth !== null && s.stocks !== null && s.unknownTokens === 0;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error("timeout")), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

const scanCache = new BoundedTtlMap<WalletScan>(2_000);
const scanInflight = new Map<string, Promise<WalletScan>>();

/** null = the chain didn't answer (unknown). */
export async function scanWallet(wallet: string): Promise<WalletScan | null> {
  const w = wallet.toLowerCase();
  const hit = scanCache.get(w);
  if (hit) return hit;
  let job = scanInflight.get(w);
  if (!job) {
    // the work keeps its inflight slot until it really ends (a timed-out caller must not start a second one)
    job = scanFresh(w)
      .then((v) => {
        if (scanComplete(v)) scanCache.set(w, v, 30_000);
        return v;
      })
      .finally(() => scanInflight.delete(w));
    scanInflight.set(w, job);
  }
  try {
    return await withTimeout(job, 15_000);
  } catch {
    return null;
  }
}

async function scanFresh(w: string): Promise<WalletScan> {
  const stockSet = new Set(STOCK_TOKENS.map((s) => s.address.toLowerCase()));
  const [received, eth, stocks] = await Promise.all([
    tokensReceivedBy(w),
    client.getBalance({ address: w as Address }).then((b) => Number(b) / 1e18, () => null),
    stockBalances(w, { priority: true }),
  ]);
  const all = received.filter((t) => !stockSet.has(t));
  // $EXIT pinned first (never cut by the cap), the rest newest first (received is oldest first)
  const rest = all.filter((t) => t !== ACTIVE_TOKEN).reverse();
  const cands = [...(IS_LIVE && all.includes(ACTIVE_TOKEN) ? [ACTIVE_TOKEN] : []), ...rest].slice(0, MAX_SCAN) as Address[];

  // one multicall: is it a vibe token (has a curve), and does the wallet still hold it
  const first = cands.length
    ? await client.multicall({
        allowFailure: true,
        contracts: cands.flatMap((t) => [
          { address: t, abi: tokenMeta, functionName: "curve" },
          { address: t, abi: erc20Abi, functionName: "balanceOf", args: [w as Address] },
          { address: t, abi: tokenMeta, functionName: "name" },
          { address: t, abi: tokenMeta, functionName: "symbol" },
        ]),
      })
    : [];
  // A failed item is either the token's own revert (the error names our function: no curve() = not a
  // vibe token) or a failed RPC chunk (the error names aggregate3, or none): the latter is unknown.
  const reverted = (r: (typeof first)[number] | undefined, fn: string) =>
    r?.status === "failure" && (r.error as { functionName?: string } | undefined)?.functionName === fn;
  let unknownTokens = 0;
  let held: { token: Address; curve: Address; balance: bigint; name: string; symbol: string }[] = [];
  cands.forEach((t, i) => {
    const [c, b, n, s] = first.slice(i * 4, i * 4 + 4);
    if (c?.status !== "success") {
      if (!reverted(c, "curve")) unknownTokens++;
      return;
    }
    if (b?.status !== "success") {
      unknownTokens++; // a vibe token whose balance we couldn't read: unknown, not "not held"
      return;
    }
    const balance = b.result as bigint;
    if (balance <= 0n) return;
    held.push({
      token: t,
      curve: c.result as Address,
      balance,
      name: n?.status === "success" ? cleanText(n.result, 48) : "?",
      symbol: s?.status === "success" ? cleanText(s.result, 16) : "?",
    });
  });

  // only tokens a vibe/vibe factory really launched (a fake contract with curve() doesn't get in)
  const real = await verifyLaunches(held.map((h) => h.token.toLowerCase()));
  held = held.filter((h) => real.has(h.token.toLowerCase()));

  const second = held.length
    ? await client.multicall({
        allowFailure: true,
        contracts: held.flatMap((h) => [
          { address: h.curve, abi: curveRead, functionName: "curveTokensRemaining" },
          { address: h.curve, abi: curveRead, functionName: "graduated" },
        ]),
      })
    : [];
  const holdings: Holding[] = held.map((h, i) => {
    const rem = second[i * 2];
    const grad = second[i * 2 + 1];
    const graduated = grad?.status === "success" ? Boolean(grad.result) : null;
    const tokens = Number(h.balance / 10n ** 12n) / 1e6;
    let progressBps: number | null = null;
    let valueEth: number | null = null;
    if (graduated) progressBps = 10_000;
    else if (rem?.status === "success") {
      const left = Number((rem.result as bigint) / 10n ** 18n);
      const sold = Math.max(0, CURVE_TOKENS - left);
      progressBps = Math.min(10_000, Math.round((sold / CURVE_TOKENS) * 10_000));
      valueEth = tokens * curvePrice(sold);
    }
    return {
      token: h.token.toLowerCase(),
      name: h.name,
      symbol: h.symbol,
      balance: h.balance.toString(),
      tokens,
      valueEth,
      progressBps,
      graduated,
      isExit: IS_LIVE && h.token.toLowerCase() === ACTIVE_TOKEN,
    };
  });
  holdings.sort((a, b) => Number(b.isExit) - Number(a.isExit) || (b.valueEth ?? -1) - (a.valueEth ?? -1));
  return { wallet: w, eth, stocks, holdings, scanned: cands.length, truncated: all.length > MAX_SCAN, unknownTokens };
}

// ---- any token's line ----

type TokenLine = { meta: LaunchMeta; state: QueueState; stale?: boolean };
const lineCache = new BoundedTtlMap<TokenLine>(120);
const notVibe = new BoundedTtlMap<true>(5_000); // "not a factory launch": remembered for 10 min
const lineInflight = new Map<string, Promise<TokenLine>>();
let coldLoads = 0;
const MAX_COLD = 3; // big histories are expensive: at most three cold loads at once per instance
const waiters: (() => void)[] = [];
/** wait for a cold-load slot; false if none frees up in time (answer: unknown, not zero) */
async function takeSlot(ms: number): Promise<boolean> {
  if (coldLoads < MAX_COLD) {
    coldLoads++;
    return true;
  }
  if (waiters.length >= 30) return false; // don't pile up requests
  return new Promise<boolean>((resolve) => {
    const wake = () => {
      clearTimeout(t);
      coldLoads++;
      resolve(true);
    };
    const t = setTimeout(() => {
      const i = waiters.indexOf(wake);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, ms);
    waiters.push(wake);
  });
}
function freeSlot() {
  coldLoads--;
  const next = waiters.shift();
  if (next) next();
}

async function buildLine(token: string): Promise<TokenLine> {
  const meta = await fetchLaunch(token);
  if (!meta?.curve) throw new Error("no meta");
  // no factory launch event = not a vibe token (never read a fake contract's history from block 0)
  if (!(meta.createdBlock > 0n)) {
    // remembered as "not vibe" only when both factories answered "no launch"; a failed lookup is unknown
    if (!meta.creationUnknown) notVibe.set(token, true, 600_000);
    throw new Error(meta.creationUnknown ? "launch lookup failed" : "not a vibe token");
  }
  const cache = await loadEvents(token, meta, { anchors: false });
  const plumbing = new Set<string>([ZERO, meta.curve, ...PLUMBING]);
  const state = buildQueue(toBalanceEvents(cache.raw, plumbing, meta.curve), { creator: meta.creator, priceEth: curvePrice(meta.tokensSold) });
  return { meta, state };
}

/** null = unknown right now (chain slow or not a vibe token); "busy" = try again in a moment. */
export async function tokenLine(token: string): Promise<TokenLine | null | "busy"> {
  const t = token.toLowerCase();
  if (t === ACTIVE_TOKEN) {
    const b = await buildState();
    if (b.unavailable || !b.meta) return null;
    return { meta: b.meta, state: b.state, stale: b.stale };
  }
  const hit = lineCache.get(t);
  if (hit) return hit;
  if (notVibe.has(t)) return null;
  let job = lineInflight.get(t);
  if (!job) {
    if (!(await takeSlot(8_000))) return "busy";
    const started = lineInflight.get(t); // someone else started it while we waited for the slot
    if (started) {
      freeSlot();
      job = started;
    } else {
      // the slot and the inflight entry live until the build really ends, even if the caller gave up
      job = buildLine(t)
        .then((v) => {
          lineCache.set(t, v, 20_000);
          return v;
        })
        .finally(() => {
          freeSlot();
          lineInflight.delete(t);
        });
      lineInflight.set(t, job);
    }
  }
  try {
    return await withTimeout(job, 20_000);
  } catch (e) {
    return (e as Error)?.message === "timeout" ? "busy" : null;
  }
}

export type PlaceInfo = {
  token: string;
  name: string;
  symbol: string;
  status: "in_line" | "exited" | "never" | "unknown" | "busy";
  place?: number;
  inLine: number;
  ahead?: number;
  behind?: number;
  exitedAhead?: number; // people who stood ahead of you when you got in and have walked out since
  exitSignalPct?: number; // exitedAhead / everyone who stood ahead of you when you got in (absent if nobody did)
  lp?: number;
  rank?: string;
  skin?: string;
  enteredTs?: number;
  progressBps: number;
  isCreator?: boolean;
  stale?: boolean; // read from an old snapshot of the $EXIT line: don't cache
};

export async function placeIn(token: string, wallet: string): Promise<PlaceInfo> {
  const t = token.toLowerCase();
  const w = wallet.toLowerCase();
  const line = await tokenLine(t);
  if (line === "busy") return { token: t, name: "", symbol: "", status: "busy", inLine: 0, progressBps: 0 };
  if (!line) return { token: t, name: "", symbol: "", status: "unknown", inLine: 0, progressBps: 0 };
  const { meta, state } = line;
  const base = { token: t, name: meta.name, symbol: meta.symbol, inLine: state.totals.inLine, progressBps: meta.progressBps, ...(line.stale ? { stale: true } : {}) };
  const me = state.line.find((e) => e.wallet === w);
  if (!me) {
    const gone = state.exits.find((x) => x.wallet === w);
    return { ...base, status: gone ? "exited" : "never", place: gone?.exitedAtPlace };
  }
  // distinct people who were ahead of me when I got in and have left since (not me, not those back in line)
  const inLineNow = new Set(state.line.map((e) => e.wallet));
  const gone = new Set<string>();
  for (const x of state.exits) {
    // walk-ins (in and out within the hour) are hidden from the Hall, so they don't count as "left" either
    if (x.wallet === w || inLineNow.has(x.wallet) || x.quick) continue;
    if (x.enteredBlock < me.enteredBlock && x.exitedBlock >= me.enteredBlock) gone.add(x.wallet);
  }
  const exitedAhead = gone.size;
  const before = me.ahead + exitedAhead;
  const creator = meta.creator || (IS_LIVE && t === ACTIVE_TOKEN ? EXIT_CREATOR : "");
  return {
    ...base,
    status: "in_line",
    place: me.place,
    ahead: me.ahead,
    behind: me.behind,
    exitedAhead,
    exitSignalPct: before > 0 ? Math.round((exitedAhead / before) * 100) : undefined,
    lp: Math.round(me.lp * 100) / 100,
    rank: me.isCreator ? "The Dev" : TIERS.find((x) => x.tier === me.tier)?.name,
    skin: me.skin,
    enteredTs: me.enteredTs,
    isCreator: !!creator && creator === w,
  };
}
