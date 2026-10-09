// Freshness of every data source behind the site, for /status and /api/status.
// Three network pings (RPC head, one vibe/vibe list row, the explorer's newest blocks; in parallel, short
// timeouts) plus three local reads (Early Index file, State snapshot, in-memory caches). The whole report is
// shared for PROBE_TTL_MS by every visitor, so the status page itself can never hammer vibe/vibe, the RPC or the explorer.
// Unknown is never "fine": a probe that fails is red with the reason, never a green zero.
import "server-only";
import { CHAIN_ID, EXPLORER, PUBLIC_RPC_URL } from "./config";
import { earlyIndex } from "@/lib/earlyIndex";
import { peekState, stateBuildSince } from "@/lib/state";
import { readBeat, type Beat } from "@/lib/beacon";

export type Level = "ok" | "warn" | "down";
export type Probe = {
  id: "vibe" | "rpc" | "explorer" | "index" | "state" | "caches";
  name: string;
  level: Level;
  /** the headline, e.g. "Head 3 s behind" */
  value: string;
  /** the visible things this source feeds, e.g. "Board, ETA, holders" (shown first on /status) */
  affects: string;
  /** the thresholds behind the colour */
  detail: string;
  /** how far behind the chain head this source is, in seconds; null = unknown or not applicable */
  lagSec?: number | null;
  /** why it is yellow/red; null when green */
  reason: string | null;
  /** the same in a few words for the /status banner ("vibe/vibe API ~3 min behind"); null when green */
  short?: string | null;
  latencyMs: number | null;
  /** shown instead of a latency for local reads ("hourly file", "in memory") */
  local?: string;
};
export type StatusReport = { checkedAt: number; probes: Probe[]; overall: Level };

const PROBE_TTL_MS = 60_000;
const TIMEOUT_MS = 6_000;
const VIBE_API = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
const VIBE_HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "exitliquid.fun (read-only directory)" };
// the server's private RPC when set (what the site really reads from); never printed
const RPC_URL = process.env.EXIT_RPC_URL || PUBLIC_RPC_URL;
const INDEX_FRESH_SEC = 2 * 3600; // refreshed hourly: one missed run is still green
const INDEX_STALE_SEC = 6 * 3600; // five missed runs: the refresh task has stopped
const STATE_FRESH_SEC = 30 * 60; // a snapshot is served as is for 15 min, then rebuilt on the next read
const STATE_STALE_SEC = 6 * 3600;

const ago = (sec: number) =>
  sec < 90 ? `${Math.max(0, Math.round(sec))} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172_800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} d`;

async function timed<T>(run: (signal: AbortSignal) => Promise<T>): Promise<{ v: T | null; ms: number; err: string | null }> {
  const t0 = Date.now();
  try {
    const v = await run(AbortSignal.timeout(TIMEOUT_MS));
    return { v, ms: Date.now() - t0, err: null };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const msg = name === "TimeoutError" || name === "AbortError" ? `No answer in ${TIMEOUT_MS / 1000} s` : String((e as Error)?.message ?? e).slice(0, 120);
    return { v: null, ms: Date.now() - t0, err: msg };
  }
}

/* ---------------- probes ---------------- */

type Head = { block: number; ts: number } | null;

async function readHead(): Promise<{ v: Head; ms: number; err: string | null }> {
  return timed(async (signal) => {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
      signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { result?: { number?: string; timestamp?: string }; error?: { message?: string } };
    if (!j.result?.number || !j.result.timestamp) throw new Error(j.error?.message ?? "No block in the answer");
    return { block: Number(BigInt(j.result.number)), ts: Number(BigInt(j.result.timestamp)) };
  });
}

function probeRpc(r: { v: Head; ms: number; err: string | null }): Probe {
  const base = {
    id: "rpc" as const,
    name: "Chain RPC",
    affects: "Lines, places, trades, balances, exit math, curve progress",
    detail: "Green under 30 s behind, yellow under 2 min.",
  };
  if (!r.v) return { ...base, level: "down", value: "No answer", reason: r.err, short: "Chain RPC not answering", latencyMs: r.ms, lagSec: null };
  const lag = Math.max(0, Date.now() / 1000 - r.v.ts);
  // it answered: red here means a stale head (2 min+), not "down". lagSec stays a number so the lead can tell the two apart.
  const level: Level = lag < 30 ? "ok" : lag < 120 ? "warn" : "down";
  return {
    ...base,
    level,
    value: `Block ${r.v.block.toLocaleString("en-US")} · ${ago(lag)} behind`,
    reason: level === "ok" ? null : `The node answers, but its newest block is ${ago(lag)} old: the chain or this node is lagging, so recent trades may be missing.`,
    short: level === "ok" ? null : `chain ${ago(lag)} behind`,
    latencyMs: r.ms,
    lagSec: lag,
  };
}

const BLOCK_SEC = 0.165; // measured block time (lib/queue.ts MATURE_BLOCKS)

/** vibe/vibe answers with the block its indexer has reached (page.snapshotBlock): its lag behind the chain head. */
async function probeVibe(head: Promise<{ v: Head }>): Promise<Probe> {
  const base = {
    id: "vibe" as const,
    name: "vibe/vibe API",
    affects: "Board, names & logos, 24 h stats, holders, dev history, ETA pace",
    detail: "Green when its indexer is under 2 min behind the chain, yellow under 15 min.",
  };
  // meta.freshness = vibe's own verdict on its data (measured 02.10: status PARTIAL, reason INDEXER_HEAD_OBSERVATION_STALE)
  type Fresh = { status?: string; reason?: string; chainHeadBlock?: string; coverageComplete?: boolean };
  type Page = { meta?: { freshness?: Fresh }; data?: { page?: { snapshotBlock?: string }; items?: unknown[] } };
  const r = await timed(async (signal) => {
    const res = await fetch(`${VIBE_API}/launches?sort=CREATED_DESC&limit=1`, { headers: VIBE_HEADERS, signal, cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 403 ? "HTTP 403: refused (Cloudflare blocked this server)" : res.status === 429 ? "HTTP 429: rate-limited" : `HTTP ${res.status}`);
    return (await res.json()) as Page;
  });
  if (!r.v) {
    const rate = r.err?.includes("429");
    return { ...base, level: rate ? "warn" : "down", value: rate ? "Rate-limited" : "Unavailable", reason: `${r.err}. Pages fall back to cached data; unknown values show as —.`, short: rate ? "vibe/vibe API rate-limited" : "vibe/vibe API not answering", latencyMs: r.ms };
  }
  const snap = Number(r.v.data?.page?.snapshotBlock);
  const fr = r.v.meta?.freshness;
  const frStatus = typeof fr?.status === "string" ? fr.status.toUpperCase() : null;
  // vibe calls its own data incomplete: say so in yellow even when the block lag looks small
  const partial = frStatus !== null && !/^(COMPLETE|FRESH|LIVE|OK|CURRENT)$/.test(frStatus);
  const partialWhy = partial
    ? `vibe/vibe marks its own data ${frStatus!.toLowerCase()}${fr?.reason ? ` (${String(fr.reason).slice(0, 60)})` : ""}: wallet PnL and positions may be unavailable.`
    : null;
  const hh = (await head).v;
  // our node can lag too: measure against the newer of our head and the head vibe saw
  const vibeHead = Number(fr?.chainHeadBlock);
  const h: Head = hh && Number.isFinite(vibeHead) && vibeHead > hh.block ? { block: vibeHead, ts: hh.ts } : hh;
  if (!Number.isFinite(snap) || snap <= 0) {
    return { ...base, level: "warn", value: `Answers in ${(r.ms / 1000).toFixed(1)} s`, reason: "No indexer block in the answer: its lag is unknown.", short: "vibe/vibe lag unknown", latencyMs: r.ms };
  }
  if (!h) {
    return { ...base, level: "warn", value: `Indexer at block ${snap.toLocaleString("en-US")}`, reason: "Chain head unknown (RPC down): the indexer's lag can't be measured.", short: "vibe/vibe lag unknown", latencyMs: r.ms };
  }
  const lagBlocks = Math.max(0, h.block - snap);
  const lag = lagBlocks * BLOCK_SEC;
  const slow = r.ms > 4_000;
  const byLag: Level = lag < 120 ? (slow ? "warn" : "ok") : lag < 900 ? "warn" : "down";
  const level: Level = partial && byLag === "ok" ? "warn" : byLag;
  const lagWhy =
    lag >= 120
      ? `The vibe/vibe indexer is ~${ago(lag)} behind the chain: new launches, holders and 24 h stats arrive late. Curve progress is read on-chain.`
      : slow
        ? `Slow answer (${(r.ms / 1000).toFixed(1)} s).`
        : null;
  return {
    ...base,
    level,
    value: `${partial ? "Partial · " : ""}Indexer ${lagBlocks.toLocaleString("en-US")} blocks · ~${ago(lag)} behind`,
    lagSec: lag,
    reason: level === "ok" ? null : [lagWhy, partialWhy].filter(Boolean).join(" ") || null,
    short: level === "ok" ? null : lag >= 120 ? `vibe/vibe API ~${ago(lag)} behind` : partial ? "vibe/vibe data partial, PnL may be missing" : "vibe/vibe API slow",
    latencyMs: r.ms,
  };
}

async function probeExplorer(): Promise<Probe> {
  const base = { id: "explorer" as const, name: "Blockscout explorer", affects: "Who funded each top holder (funding clusters)", detail: "Green under 2 min behind." };
  const r = await timed(async (signal) => {
    const res = await fetch(`${EXPLORER}/api/v2/main-page/blocks`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal, cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 429 ? "HTTP 429: rate-limited" : `HTTP ${res.status}`);
    const j = (await res.json()) as { height?: number; timestamp?: string }[];
    const top = Array.isArray(j) ? j[0] : null;
    if (!top?.height || !top.timestamp) throw new Error("No block in the answer");
    return { block: top.height, ts: Date.parse(top.timestamp) / 1000 };
  });
  if (!r.v) return { ...base, level: r.err?.includes("429") ? "warn" : "down", value: "Unavailable", reason: `${r.err}. Funding sources show as unknown until it answers.`, short: "explorer not answering", latencyMs: r.ms };
  const lag = Math.max(0, Date.now() / 1000 - r.v.ts);
  const level: Level = lag < 120 ? "ok" : lag < 900 ? "warn" : "down";
  return {
    ...base,
    level,
    value: `Block ${r.v.block.toLocaleString("en-US")} · ${ago(lag)} behind`,
    reason: level === "ok" ? null : `The explorer's newest indexed block is ${ago(lag)} old: funding data may miss recent wallets.`,
    short: level === "ok" ? null : `explorer ${ago(lag)} behind`,
    latencyMs: r.ms,
    lagSec: lag,
  };
}

function probeIndex(): Probe {
  const ix = earlyIndex() as { generatedAt?: number; windowDays?: number; tokensScanned?: number; snipers?: unknown[]; farms?: unknown[] };
  const base = {
    id: "index" as const,
    name: "Early Index (snipers & farms)",
    affects: "Sniper and farm labels in Line Health, the board's sniper counts",
    detail: "Rebuilt every hour from the chain. Green under 2 hours old, yellow under 6 hours.",
    latencyMs: null,
    local: "hourly file",
  };
  if (!ix.generatedAt) return { ...base, level: "down", value: "Not loaded", reason: "No index in this build: sniper and farm signals show as unknown.", short: "Early Index missing" };
  const age = Math.max(0, Date.now() / 1000 - ix.generatedAt);
  const level: Level = age < INDEX_FRESH_SEC ? "ok" : age < INDEX_STALE_SEC ? "warn" : "down";
  const built = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(ix.generatedAt * 1000);
  const size = `${ix.snipers?.length ?? 0} snipers, ${ix.farms?.length ?? 0} farms from ${(ix.tokensScanned ?? 0).toLocaleString("en-US")} launches (${ix.windowDays ?? "?"} d)`;
  return {
    ...base,
    level,
    value: `Built ${built} UTC · ${ago(age)} old`,
    lagSec: age,
    reason:
      level === "ok"
        ? null
        : level === "warn"
          ? `${size}. The hourly refresh missed a run: the newest sniper wallets are missing.`
          : `${size}. The hourly refresh has stopped: sniper and farm labels miss every wallet since then.`,
    short: level === "ok" ? null : `Early Index ${ago(age)} old`,
  };
}

/** The State of vibe snapshot (/state, the door's +1h moves): built on demand, kept in memory and on disk. */
async function probeState(): Promise<Probe> {
  const base = {
    id: "state" as const,
    name: "State snapshot",
    affects: "State of vibe, the door's +1h moves, the board's time to graduation",
    detail: "Rebuilt from the chain when a reader finds it over 15 min old. Green under 30 min, yellow under 6 hours.",
    latencyMs: null,
    local: "memory + disk",
  };
  const since = stateBuildSince();
  const b = readBeat("state");
  const failed = b && b.failAt > b.okAt ? b : null;
  const building = since ? ` · rebuilding for ${ago((Date.now() - since) / 1000)}` : "";
  let s: Awaited<ReturnType<typeof peekState>> = null;
  let readErr: string | null = null;
  try {
    s = await peekState();
  } catch (e) {
    readErr = String((e as Error)?.message ?? e).slice(0, 120);
  }
  if (!s) {
    const why = readErr
      ? `Snapshot unreadable: ${readErr}.`
      : failed
        ? `The last build failed: ${failed.err}.`
        : since
          ? "The first build is running."
          : "No snapshot in memory or on disk yet: the next /state visit builds one.";
    return {
      ...base,
      level: failed || readErr ? "down" : "warn",
      value: since ? `Building${building}` : "No snapshot",
      reason: `${why} State of vibe shows — until it lands.`,
      short: "State snapshot missing",
      lagSec: null,
    };
  }
  const age = Math.max(0, Date.now() / 1000 - s.builtAt);
  const byAge: Level = age < STATE_FRESH_SEC ? "ok" : age < STATE_STALE_SEC ? "warn" : "down";
  // a failed rebuild after the snapshot means it can only get older: never green
  const level: Level = failed && byAge === "ok" ? "warn" : byAge;
  const why = [
    byAge !== "ok" ? `Built ${ago(age)} ago${since ? "; a rebuild is running" : ": rebuilt on the next /state visit"}. State figures and door moves are that old.` : null,
    failed ? `The last rebuild failed (${failed.err}).` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ...base,
    level,
    value: `Block ${s.headBlock.toLocaleString("en-US")} · ${ago(age)} old${building}`,
    lagSec: age,
    reason: level === "ok" ? null : why || null,
    short: level === "ok" ? null : failed ? "State snapshot rebuild failed" : `State snapshot ${ago(age)} old`,
  };
}

/** The in-process caches pages read first: the $EXIT line and the launch directory. No network. */
function probeCaches(): Probe {
  const base = {
    id: "caches" as const,
    name: "In-memory caches",
    affects: "The $EXIT line, Hall of Exits, launch board and search",
    detail: "Filled on demand by visitors. Green when the last refresh of each worked; yellow while one is cold or a recent copy covers a failed refresh.",
    latencyMs: null,
    local: "in memory",
  };
  const part = (label: string, b: Beat | null, keepMs: number): { level: Level; text: string; why: string | null } => {
    if (!b) return { level: "warn", text: `${label} cold`, why: `${label} not filled since the server started: unknown until the first visitor reads it.` };
    const okAge = b.okAt ? (Date.now() - b.okAt) / 1000 : null;
    const text = okAge === null ? `${label} never filled` : `${label} ${ago(okAge)} old`;
    if (b.failAt <= b.okAt) return { level: "ok", text, why: null };
    // the newest refresh failed: a copy younger than keepMs still serves (labelled), older means unknown on the page
    const serving = okAge !== null && okAge * 1000 < keepMs;
    return {
      level: serving ? "warn" : "down",
      text,
      why: `${label}: the last refresh failed ${ago((Date.now() - b.failAt) / 1000)} ago (${b.err})${serving ? ", a recent copy serves." : ", pages show —."}`,
    };
  };
  const line = part("Line", readBeat("line"), 5 * 60_000); // lib/service.ts SNAPSHOT_MAX_AGE
  const dir = part("Directory", readBeat("directory"), 10 * 60_000);
  const rank = (l: Level) => (l === "down" ? 2 : l === "warn" ? 1 : 0);
  const worst = rank(line.level) >= rank(dir.level) ? line : dir;
  const level = worst.level;
  const label = worst === line ? "line" : "directory";
  return {
    ...base,
    level,
    value: `${line.text} · ${dir.text}`,
    reason: level === "ok" ? null : [line.why, dir.why].filter(Boolean).join(" ") || null,
    short: level === "ok" ? null : level === "down" ? `${label} cache failing` : `${label} cache cold`,
    lagSec: null,
  };
}

/* ---------------- the shared report ---------------- */

let last: StatusReport | null = null;
let running: Promise<StatusReport> | null = null;

/** the /status lead: one sentence for the worst thing a visitor would notice. Pure: unit-checkable. */
export function statusLead(probes: Pick<Probe, "id" | "level" | "lagSec">[]): string {
  const by = (id: Probe["id"]) => probes.find((p) => p.id === id);
  const rpc = by("rpc");
  const vibe = by("vibe");
  const exp = by("explorer");
  const ix = by("index");
  const mins = (sec: number | null | undefined) => (typeof sec === "number" && Number.isFinite(sec) ? ago(sec) : null);
  // answered with an old head (lagSec is a number) is not the same as no answer
  if (rpc && rpc.level === "down" && typeof rpc.lagSec === "number") return `Chain is ${mins(rpc.lagSec)} behind: recent trades may be missing.`;
  if (rpc && rpc.level === "down") return "Chain RPC not answering: affected numbers show —, never 0.";
  if (rpc && rpc.level === "warn") {
    const m = mins(rpc.lagSec);
    return `Chain RPC is lagging${m ? ` ~${m}` : ""}: lines and trades may be behind.`;
  }
  if (vibe && vibe.level !== "ok") {
    const m = mins(vibe.lagSec);
    return vibe.level === "down" && !m
      ? "vibe/vibe API is not answering: launch list and holder data come from cache. Chain reads are live."
      : `vibe/vibe API is slow: launch list and holder data may lag${m ? ` by ~${m}` : ""}. Chain reads are live.`;
  }
  if (exp && exp.level !== "ok") return "The explorer is lagging: funding sources may show as unknown. Everything else is live.";
  if (ix && ix.level !== "ok") return ix.level === "down" ? "The Early Index refresh has stopped: the newest sniper and farm wallets are missing." : "The Early Index is getting old: the newest sniper wallets may be missing.";
  const st = by("state");
  if (st && st.level !== "ok") return "The State of vibe snapshot is old or missing: State figures and door moves may lag.";
  const ca = by("caches");
  if (ca && ca.level !== "ok") return "An in-memory cache is cold or failing: the first read of a page may be slow.";
  if (!probes.length) return "Status unknown: no source has answered yet.";
  return "All sources fresh.";
}

/** the /status banner's reason: the worst source in a few words, or null when all are green */
export function statusShort(probes: Pick<Probe, "id" | "level" | "short">[]): string | null {
  const order: Probe["id"][] = ["rpc", "vibe", "explorer", "index", "state", "caches"];
  const rank = (p: Pick<Probe, "id" | "level">) => (p.level === "down" ? 0 : p.level === "warn" ? 1 : 2) * 10 + order.indexOf(p.id);
  const worst = probes.filter((p) => p.level !== "ok").sort((a, b) => rank(a) - rank(b))[0];
  return worst ? (worst.short ?? null) : null;
}

export async function statusReport(): Promise<StatusReport & { cacheAgeMs: number }> {
  if (last && Date.now() - last.checkedAt < PROBE_TTL_MS) return { ...last, cacheAgeMs: Date.now() - last.checkedAt };
  if (!running) {
    const head = readHead();
    running = Promise.all([head.then(probeRpc), probeVibe(head), probeExplorer(), Promise.resolve(probeIndex()), probeState(), Promise.resolve(probeCaches())])
      .then((probes) => {
        const overall: Level = probes.some((p) => p.level === "down") ? "down" : probes.some((p) => p.level === "warn") ? "warn" : "ok";
        last = { checkedAt: Date.now(), probes, overall };
        return last;
      })
      .finally(() => {
        running = null;
      });
  }
  const r = await running;
  return { ...r, cacheAgeMs: Date.now() - r.checkedAt };
}
