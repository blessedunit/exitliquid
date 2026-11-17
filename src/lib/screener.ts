// The screener: a graded row for every token in the active universe, kept warm by a background loop inside the
// Next server, served from memory (never computed inside a request).
//
// Universe (refreshed every 5 min): the newest ~60 v6 launches + every active line (>= 10 trades or >= 1 ETH in
// 24 h) of the whole v6 list (lib/launches v6Directory: head pages + a 60-page scan re-read every 20 min), ranked
// by 24 h ETH volume and trades in turn, while the planned re-grade load fits the workers' measured time
// (BUDGET_SHARE of CONCURRENCY x 3600 worker-s an hour, grade times measured in stats.gradeS) + the v1 Hot board
// page + $EXIT. Each token: the same /api/analytics answer the token page shows (engine.ts / v6engine.ts, shared
// caches, so the loop also pre-warms token pages) + the creator's track record (devrep, 10 min cache), graded by
// lib/screener-rules.ts. Concurrency 2. Re-grades by age (CADENCE): < 1 h every 5 min, < 3 h 15 min, < 24 h 30 min,
// older 40 min. Every grade that changed (or hourly) goes to the journal (lib/gradeLog.ts) for backtests.
//
// Snapshot: written (debounced, atomic temp + rename) to src/data/screener.json (env SCREENER_PATH) and copied to
// public/screener.json; read back on the first call after a restart, so the first visitor gets rows at once.
// Every row carries the rules version it was graded under (rulesV): a restart under the same rules keeps the
// grades; a row of another version is never served with a grade (presentRow) and is re-graded first.
// Cloudflare copy (EXIT_CF=1, ops/deploy_fallback.py): the loop never runs there (Workers CPU limits); the route
// serves KV key "screener" when the PC pushed one, else the static /screener.json shipped with the deploy.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { analyticsFor, NotVibeError } from "@/lib/analytics/engine";
import { analyticsV6, isKnownV6, v6UnknownFactoryCount } from "@/lib/analytics/v6engine";
import { launchCards, launchPage, v6Directory, type LaunchCard } from "@/lib/launches";
import { gradeLogStats, logGrade } from "@/lib/gradeLog";
import { devReputation } from "@/lib/devrep";
import { ethUsdPrice } from "@/lib/ethPrice";
import { EXIT_TOKEN } from "@/lib/config";
import { cleanEligible, devTrack, isCurrent, presentRow, RULES_VERSION, screen, type DevTrack } from "@/lib/screener-rules";
import type { Analytics } from "@/lib/analytics/types";
import type { ScreenerBoard, ScreenerResponse, ScreenerRow } from "@/lib/screener-types";

export const ON_CF = process.env.EXIT_CF === "1";

/** workers (public RPC is rate-limited: 2 = ~10% failed grades on 17.11); SCREENER_CONCURRENCY raises it, the budget follows */
const CONCURRENCY = Math.max(1, Math.min(6, Math.floor(Number(process.env.SCREENER_CONCURRENCY)) || 2));
const TOKEN_TIMEOUT_MS = 30_000;
const UNIVERSE_MS = 5 * 60_000;
/** hard cap on one universe refresh: a request that never settles must not freeze the supervisor (17.10: 9 h) */
const UNIVERSE_TIMEOUT_MS = 120_000;
const SHRINK_ACCEPT_MS = 3 * 3600_000;
const RANK_MAX_AGE_MS = 3600_000;
/** re-grade cadence by the line's age: young lines move fast, old-but-active ones are re-read within ~30-40 min */
const CADENCE: { underMin: number; everyMs: number }[] = [
  { underMin: 60, everyMs: 5 * 60_000 },
  { underMin: 180, everyMs: 15 * 60_000 },
  { underMin: 24 * 60, everyMs: 30 * 60_000 },
  { underMin: Infinity, everyMs: 40 * 60_000 },
];
const TRACK_RETRY_MS = 3 * 60_000;
const NEWEST = 60;
/** "active" as the audit counted it: >= 10 trades or >= 1 ETH of volume in 24 h; ranked by activity */
const ACTIVE_TRADES = 10;
const ACTIVE_ETH = 1;
/** never more than this, whatever the budget says */
const MAX_UNIVERSE = 700;
/** share of the workers' time the planned re-grades may take (the rest: first grades, retries, timeouts) */
const BUDGET_SHARE = 0.75;
/** one grade's wall time before anything is measured (17.11: 189 grades in 709 s at concurrency 2 = 7.5 s a worker) */
const DEFAULT_GRADE_S = 7.5;
/** rows of tokens that left the universe stay this long (grade cells and a dev's launch list still read them) */
const KEEP_MS = 6 * 3600_000;
const MAX_ROWS = 1200;
const PERSIST_EVERY_MS = 15_000;
const IDLE_MS = 3_000;

const FILE = process.env.SCREENER_PATH || path.join(/* turbopackIgnore: true */ process.cwd(), "src", "data", "screener.json");
const PUBLIC_FILE = path.join(/* turbopackIgnore: true */ process.cwd(), "public", "screener.json");

type Meta = { card: LaunchCard; v6: boolean };
type Stats = { cycles: number; lastCycleMs: number | null; cycleStartedAt: number; doneThisCycle: number; errors: number; lastError: string | null; universe: number; universeAt: number;
  /** since when vibe's lists return less than half of the universe we had (0 = fine): the old universe is kept meanwhile */
  shrunkSince?: number;
  /** grades done / failed since the process started (all attempts, re-grades included) */
  graded?: number; failed?: number;
  /** measured wall time of one grade, s (moving average): a young line, an older one, a first grade */
  gradeS?: { young: number | null; old: number | null; first: number | null };
  /** v6 cards the lists returned / of those active (>= 10 trades or >= 1 ETH 24 h) / active left out by the budget */
  listed?: number; active?: number; activeLeftOut?: number;
  /** planned re-grade load of the universe vs what the workers can do, worker-seconds an hour */
  loadSPerH?: number; budgetSPerH?: number;
  /** the wide v6 scan the universe came from: pages read, ms, age in min, stopped early */
  scan?: { pages: number; ms: number; ageMin: number; partial: boolean } | null };

type State = {
  impl?: { workerStep: () => Promise<boolean>; supervisorStep: () => Promise<void> };
  rows: Map<string, ScreenerRow>;
  universe: Map<string, Meta>;
  inflight: Set<string>;
  failedAt: Map<string, number>;
  asOf: number;
  dirty: boolean;
  persistedAt: number;
  loaded: boolean;
  running: boolean;
  stats: Stats;
};

// one state per server process (survives a dev hot reload)
const G = globalThis as unknown as { __exitScreener?: State };
const S: State = (G.__exitScreener ??= {
  rows: new Map(), universe: new Map(), inflight: new Set(), failedAt: new Map(), asOf: 0, dirty: false,
  persistedAt: 0, loaded: false, running: false,
  stats: { cycles: 0, lastCycleMs: null, cycleStartedAt: 0, doneThisCycle: 0, errors: 0, lastError: null, universe: 0, universeAt: 0 },
});

/* ---------------- snapshot on disk ---------------- */

function loadSnapshot() {
  if (S.loaded) return;
  S.loaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8")) as ScreenerResponse;
    if (!Array.isArray(j.tokens)) return;
    for (const r of j.tokens) if (r && typeof r.token === "string" && !S.rows.has(r.token)) S.rows.set(r.token, r);
    S.asOf = Math.max(S.asOf, Number(j.asOf) || 0);
  } catch {
    /* no snapshot yet: the loop fills one */
  }
}

function writeAtomic(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function persist(force = false) {
  if (!S.dirty || (!force && Date.now() - S.persistedAt < PERSIST_EVERY_MS)) return;
  S.dirty = false;
  S.persistedAt = Date.now();
  try {
    // rows as checked (ages not moved on): loadSnapshot + snapshot() add the time since checkedAt themselves
    const body = JSON.stringify(snapshotAt(null));
    writeAtomic(FILE, body);
    writeAtomic(PUBLIC_FILE, body);
  } catch (e) {
    S.stats.lastError = `persist: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
  }
}

/* ---------------- universe ---------------- */

/** re-grade interval of a line this many minutes old (null = unknown age: an old line) */
function everyMs(ageMin: number | null): number {
  const a = ageMin ?? Infinity;
  return CADENCE.find((c) => a < c.underMin)!.everyMs;
}

const ewma = (prev: number | null | undefined, v: number) => (prev == null ? v : prev * 0.9 + v * 0.1);

/** worker-seconds an hour that re-grading one line of this age costs (measured grade time, default before any) */
function costSPerH(ageMin: number | null): number {
  const g = S.stats.gradeS;
  const young = ageMin !== null && ageMin < CADENCE[1].underMin;
  // an older line before its first measured re-grade: never assumed cheaper than the default
  const s = young ? (g?.young ?? DEFAULT_GRADE_S) : (g?.old ?? Math.max(g?.young ?? 0, DEFAULT_GRADE_S));
  return (3600_000 / everyMs(ageMin)) * s;
}

const trades24 = (c: LaunchCard) => (c.buys24h ?? 0) + (c.sells24h ?? 0);

async function refreshUniverse() {
  // newest pages (30 s memo) + the wide scan of the whole v6 list (~4-5 days, re-read every 20 min in the
  // background): active lines older than the head pages (16 h) stay in the universe while they trade
  let uniq: LaunchCard[] = [];
  try {
    const dir = await v6Directory(true);
    uniq = dir.items.filter((c) => c.v6);
    S.stats.scan = dir.scan ? { pages: dir.scan.pages, ms: dir.scan.ms, ageMin: Math.floor((Date.now() - dir.scan.at) / 60_000), partial: dir.scan.partial } : null;
  } catch {
    /* vibe down: v1 + $EXIT below, and the shrink guard keeps the old universe */
  }
  uniq.sort((a, b) => b.createdAt - a.createdAt);
  const now = Date.now();
  const ageOf = (c: LaunchCard) => (c.createdAt ? Math.max(0, Math.floor((now / 1000 - c.createdAt) / 60)) : null);
  const pick = new Map<string, Meta>();
  // budget: the workers' time an hour, times the share planned re-grades may take
  const budget = CONCURRENCY * 3600 * BUDGET_SHARE;
  let load = 0;
  const add = (c: LaunchCard, v6: boolean) => {
    if (pick.has(c.token)) return;
    pick.set(c.token, { card: c, v6 });
    load += costSPerH(ageOf(c));
  };
  for (const c of uniq.slice(0, NEWEST)) add(c, true);
  // ranked by activity: ETH pairs by 24 h ETH volume and every line by 24 h trades, taken in turn (a token-paired
  // line, VIBEVIBE or a stock token, has no ETH volume); then the rest of the trading lines, while the budget lasts
  const isActive = (c: LaunchCard) => trades24(c) >= ACTIVE_TRADES || (c.volume24hEth ?? 0) >= ACTIVE_ETH;
  const byVol = uniq.filter((c) => (c.volume24hEth ?? 0) > 0).sort((a, b) => (b.volume24hEth ?? 0) - (a.volume24hEth ?? 0));
  const byTrades = uniq.filter((c) => trades24(c) > 0).sort((a, b) => trades24(b) - trades24(a));
  const ranked: LaunchCard[] = [];
  const inRank = new Set<string>();
  for (let i = 0; i < Math.max(byVol.length, byTrades.length); i++) {
    for (const c of [byVol[i], byTrades[i]]) {
      if (!c || inRank.has(c.token)) continue;
      inRank.add(c.token);
      ranked.push(c);
    }
  }
  const active = ranked.filter(isActive);
  const order = [...active, ...ranked.filter((c) => !isActive(c))];
  let leftOut = 0;
  // a slower chain (grades taking longer) trims the universe by at most 40% a refresh: a budget cut is never
  // mistaken for a list outage by the shrink guard below, and the boards don't empty at once
  const floorN = Math.ceil(S.universe.size * 0.6);
  // newcomers (no row yet) are graded first by nextToken: hundreds at once starved the young lines' re-grades for
  // ~20 min (17.11, 209 -> 724). Per refresh at most what the share left outside the budget can first-grade.
  const firstS = S.stats.gradeS?.first ?? DEFAULT_GRADE_S;
  const newMax = Math.max(20, Math.floor(((UNIVERSE_MS / 1000) * CONCURRENCY * (1 - BUDGET_SHARE)) / firstS));
  let newcomers = 0;
  for (const c of order) {
    if (pick.has(c.token)) continue;
    const isNew = !S.universe.has(c.token) && !S.rows.has(c.token);
    if (pick.size >= MAX_UNIVERSE || (load + costSPerH(ageOf(c)) > budget && pick.size >= floorN) || (isNew && newcomers >= newMax)) {
      if (isActive(c)) leftOut++;
      continue;
    }
    if (isNew) newcomers++;
    add(c, true);
  }
  S.stats.listed = uniq.length;
  S.stats.active = active.length;
  S.stats.activeLeftOut = leftOut;
  S.stats.loadSPerH = Math.round(load);
  S.stats.budgetSPerH = Math.round(budget);
  // v1: the Hot board page (the index froze 29.09, these rows are what the board still shows) + our own token
  try {
    const hot = await launchPage("hot", "", null, 24, 60);
    for (const c of hot.items) if (!pick.has(c.token)) pick.set(c.token, { card: c, v6: !!c.v6 });
  } catch { /* unknown now */ }
  if (EXIT_TOKEN && !pick.has(EXIT_TOKEN)) {
    try {
      const r = await launchCards([EXIT_TOKEN], { v6Lookup: false });
      for (const c of r.items) pick.set(c.token, { card: c, v6: false });
    } catch { /* unknown now */ }
  }
  if (!pick.size) return;
  // vibe's v6 list failing mid-way leaves ~25 v1 rows: taking that as the universe dropped every v6 row from the
  // boards. Less than half of what we had = a list outage, not the market: keep the old universe and ask again.
  // A shrink that lasts SHRINK_ACCEPT_MS is real and is accepted.
  if (S.universe.size >= 20 && pick.size < S.universe.size / 2) {
    S.stats.shrunkSince ||= now;
    if (now - S.stats.shrunkSince < SHRINK_ACCEPT_MS) {
      S.stats.lastError = `universe: got ${pick.size} of ${S.universe.size}, kept the old one`;
      S.stats.universeAt = now - UNIVERSE_MS + 60_000; // ask again in a minute
      return;
    }
  }
  S.stats.shrunkSince = 0;
  S.universe = pick;
  S.stats.universe = pick.size;
  S.stats.universeAt = now;
}

/* ---------------- dev track record ---------------- */

/** The creator's OTHER launches and how many of them graduated (vibe lists + the factory count, 10 min cache). */
export async function devTrackOf(creator: string, self: string): Promise<DevTrack> {
  if (!/^0x[0-9a-f]{40}$/.test(creator)) return null;
  try {
    return devTrack(await devReputation(creator), self);
  } catch {
    return null; // unknown, never "first launch"
  }
}

/* ---------------- one token ---------------- */

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function analyticsOf(token: string, v6: boolean): Promise<Analytics> {
  if (v6 || isKnownV6(token)) return analyticsV6(token);
  return analyticsFor(token).catch((e) => {
    if (e instanceof NotVibeError) return analyticsV6(token);
    throw e;
  });
}

/** One graded row. Throws when the chain didn't answer. */
async function gradeToken(token: string, meta: Meta | null): Promise<ScreenerRow> {
  const t = token.toLowerCase();
  const [a, ethUsd] = await Promise.all([timeout(analyticsOf(t, meta?.v6 ?? false), TOKEN_TIMEOUT_MS), ethUsdPrice()]);
  const card = meta?.card ?? null;
  const creator = card?.creator && /^0x[0-9a-f]{40}$/.test(card.creator)
    ? card.creator
    : Object.entries(a.tags).find(([, v]) => v === "dev")?.[0] ?? null;
  const track = creator ? await timeout(devTrackOf(creator, t), 12_000).catch(() => null) : null;
  const ageMin = card?.createdAt ? Math.max(0, Math.floor((Date.now() / 1000 - card.createdAt) / 60)) : null;
  const res = screen({ a, ageMin, track, ethUsd });
  return {
    token: t,
    ticker: card?.symbol || a.symbol || "",
    name: card?.name || a.symbol || "",
    image: card?.image ?? null,
    version: a.v6 ? "v6" : "v1",
    creator,
    grade: res.grade,
    score: res.score,
    verdict: res.verdict,
    reasons: res.reasons,
    metrics: res.metrics,
    ageMin,
    graduated: a.graduated || !!card?.graduated,
    checkedAt: Date.now(),
    rulesV: RULES_VERSION,
  };
}

/* ---------------- the loop ---------------- */

function dueAt(r: ScreenerRow | undefined): number {
  if (!r?.checkedAt) return 0;
  // graded under other rules (served without a grade meanwhile): next in line
  if (!isCurrent(r)) return 1;
  const age = r.ageMin === null ? null : r.ageMin + (Date.now() - r.checkedAt) / 60_000;
  // the creator's record didn't load (vibe blip): retry soon, not in 20 min
  if (r.creator && r.metrics.devLaunches === null) return r.checkedAt + TRACK_RETRY_MS;
  return r.checkedAt + everyMs(age);
}

function nextToken(): string | null {
  const now = Date.now();
  let best: { t: string; at: number; age: number } | null = null;
  for (const [t, m] of S.universe) {
    if (S.inflight.has(t)) continue;
    const f = S.failedAt.get(t);
    if (f && now - f < 5 * 60_000) continue;
    const at = dueAt(S.rows.get(t));
    if (at > now) continue;
    // never-checked first, newest launch first among them; then the most overdue
    const age = m.card.createdAt;
    if (!best || at < best.at || (at === best.at && age > best.age)) best = { t, at, age };
  }
  return best?.t ?? null;
}

function prune() {
  // no universe yet (a restart, vibe's lists down): nothing is known to have left it
  if (!S.universe.size) return;
  const now = Date.now();
  // out of the universe a row is never re-graded: it goes when it is old, or at once when its rules are
  // (it would be served without a grade for hours)
  for (const [t, r] of S.rows) if (!S.universe.has(t) && (!isCurrent(r) || now - (r.checkedAt ?? 0) > KEEP_MS)) S.rows.delete(t);
  for (const t of S.failedAt.keys()) if (!S.universe.has(t)) S.failedAt.delete(t);
  if (S.rows.size > MAX_ROWS) {
    const old = [...S.rows.values()].filter((r) => !S.universe.has(r.token)).sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0));
    for (const r of old.slice(0, S.rows.size - MAX_ROWS)) S.rows.delete(r.token);
  }
}

/** one worker step: grade the most overdue token; false = nothing due */
async function workerStep(): Promise<boolean> {
  const t = nextToken();
  if (!t) return false;
  S.inflight.add(t);
  const t0 = Date.now();
  const before = S.rows.get(t);
  const meta = S.universe.get(t) ?? null;
  // time per grade, by kind (sizes the universe: refreshUniverse's budget)
  const took = () => {
    const s = (Date.now() - t0) / 1000;
    const g = (S.stats.gradeS ??= { young: null, old: null, first: null });
    const ageMin = meta?.card.createdAt ? (Date.now() / 1000 - meta.card.createdAt) / 60 : null;
    if (!before?.checkedAt) g.first = Math.round(ewma(g.first, s) * 100) / 100;
    else if (ageMin !== null && ageMin < CADENCE[1].underMin) g.young = Math.round(ewma(g.young, s) * 100) / 100;
    else g.old = Math.round(ewma(g.old, s) * 100) / 100;
  };
  try {
    const row = await gradeToken(t, meta);
    S.rows.set(t, row);
    S.asOf = Date.now();
    S.dirty = true;
    S.failedAt.delete(t);
    S.stats.doneThisCycle++;
    S.stats.graded = (S.stats.graded ?? 0) + 1;
    took();
    logGrade(row); // queued, written in the background; never throws
  } catch (e) {
    took();
    S.failedAt.set(t, Date.now());
    S.stats.errors++;
    S.stats.failed = (S.stats.failed ?? 0) + 1;
    S.stats.lastError = `${t.slice(0, 10)}: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
  } finally {
    S.inflight.delete(t);
  }
  return true;
}

async function supervisorStep(): Promise<void> {
  if (Date.now() - S.stats.universeAt > UNIVERSE_MS) {
    try {
      await timeout(refreshUniverse(), UNIVERSE_TIMEOUT_MS);
    } catch (e) {
      S.stats.lastError = `universe: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
      S.stats.universeAt = Date.now() - UNIVERSE_MS + 60_000; // the hung read is abandoned; ask again in a minute
    }
  }
  // a cycle = every token of the universe graded (or failed) once since the cycle started
  const all = [...S.universe.keys()];
  const pending = all.filter((t) => (S.rows.get(t)?.checkedAt ?? 0) < S.stats.cycleStartedAt && (S.failedAt.get(t) ?? 0) < S.stats.cycleStartedAt).length;
  if (S.stats.cycleStartedAt === 0) S.stats.cycleStartedAt = Date.now();
  else if (all.length && pending === 0) {
    S.stats.lastCycleMs = Date.now() - S.stats.cycleStartedAt;
    S.stats.cycles++;
    console.log(`screener: cycle ${S.stats.cycles} ${all.length} tokens in ${Math.round(S.stats.lastCycleMs / 1000)} s, errors ${S.stats.errors}`);
    S.stats.cycleStartedAt = Date.now();
    S.stats.doneThisCycle = 0;
  }
  prune();
  persist();
}

// Loops: one set per process, always calling the newest module version's steps (S.impl). A dev hot reload
// re-evaluates this module: it bumps the loop epoch, the running loops exit after their current step and the
// next /api/screener call starts one fresh set. In production the module is evaluated once.
type Loops = { epoch: number; on: boolean };
const L = ((S as unknown as { loops?: Loops }).loops ??= { epoch: 0, on: false });
L.epoch++;
L.on = false;
// the first version of this module ran generation-guarded loops: NaN never equals their generation, they stop
(S as unknown as { gen?: number }).gen = NaN;
S.impl = { workerStep, supervisorStep };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the warm loop once per process (never on the Cloudflare copy). Never awaits anything. */
export function ensureScreener() {
  loadSnapshot();
  if (ON_CF || L.on) return;
  L.on = true;
  S.running = true;
  const my = L.epoch;
  void (async () => {
    while (L.epoch === my) {
      try { await S.impl!.supervisorStep(); } catch (e) { S.stats.lastError = `loop: ${String((e as Error)?.message ?? e).slice(0, 120)}`; }
      await sleep(5_000);
    }
  })();
  for (let i = 0; i < CONCURRENCY; i++) {
    void (async () => {
      while (L.epoch === my) {
        let worked = false;
        try { worked = await S.impl!.workerStep(); } catch { /* counted inside */ }
        if (!worked) await sleep(IDLE_MS);
      }
    })();
  }
}

/* ---------------- reading ---------------- */

/** Every row as it may leave the module: a row graded under other rules leaves without its grade. */
function snapshotAt(now: number | null): ScreenerResponse {
  // ages move on between checks: served as of `now` (null = as checked, for the file)
  const tokens = [...S.rows.values()].map(presentRow).map((r) => (now !== null && r.ageMin !== null && r.checkedAt ? { ...r, ageMin: r.ageMin + Math.floor((now - r.checkedAt) / 60_000) } : r));
  return { asOf: S.asOf, checked: tokens.filter((r) => r.verdict !== "unknown").length, tokens };
}

export const snapshot = (): ScreenerResponse => snapshotAt(Date.now());

export function screenerStats() {
  const staleRules = [...S.rows.values()].filter((r) => !isCurrent(r)).length;
  return { ...S.stats, concurrency: CONCURRENCY, gradeLog: gradeLogStats(), unknownFactory: v6UnknownFactoryCount(), newestGradedAgeMin: newestGradedAgeMin(), rows: S.rows.size, inflight: S.inflight.size, running: S.running, onCf: ON_CF, rulesVersion: RULES_VERSION, staleRules };
}

/** age in minutes of the youngest launch that has a row: grows when new launches stop reaching the boards */
function newestGradedAgeMin(): number | null {
  let best: number | null = null;
  const now = Date.now();
  for (const r of S.rows.values()) {
    if (r.ageMin === null || !r.checkedAt) continue;
    const age = r.ageMin + Math.floor((now - r.checkedAt) / 60_000);
    if (best === null || age < best) best = age;
  }
  return best;
}

const act = (r: ScreenerRow) => r.metrics.vol24h ?? r.metrics.vol24hPair ?? 0;

/** rows for one board, best first */
export function board(all: ScreenerRow[], b: ScreenerBoard): ScreenerRow[] {
  const has = (v: number | null): v is number => v !== null;
  // a ranking is a claim about now: a row not re-checked for an hour (a token that left the universe) is not ranked
  const fresh = Date.now() - RANK_MAX_AGE_MS;
  // ... and a row graded under other rules has no place on a board at all (its metrics are the old rules' too)
  const rows = all.filter((r) => (r.checkedAt ?? 0) >= fresh && isCurrent(r));
  switch (b) {
    case "clean":
      return rows.filter((r) => r.verdict === "clean" && cleanEligible(r.metrics))
        // a full check (snipers known) ranks above a partial one (launched before the wallet index) of the same letter
        .sort((x, y) => (x.grade ?? "Z").localeCompare(y.grade ?? "Z") || Number(x.metrics.snipers20 === null) - Number(y.metrics.snipers20 === null)
          || (y.score ?? 0) - (x.score ?? 0) || (y.metrics.realVol24h ?? 0) - (x.metrics.realVol24h ?? 0));
    case "risk":
      return rows.filter((r) => r.verdict === "risk" && ((r.metrics.trades24h ?? 0) >= 5 || (r.metrics.holders ?? 0) >= 10))
        .sort((x, y) => (x.score ?? 0) - (y.score ?? 0) || act(y) - act(x));
    case "sniped":
      return rows.filter((r) => has(r.metrics.snipers20) && r.metrics.snipers20 > 0)
        .sort((x, y) => y.metrics.snipers20! - x.metrics.snipers20! || act(y) - act(x));
    case "devdump":
      return rows.filter((r) => has(r.metrics.devSoldPct) && r.metrics.devSoldPct >= 1)
        .sort((x, y) => y.metrics.devSoldPct! - x.metrics.devSoldPct! || act(y) - act(x));
    case "realvol":
      return rows.filter((r) => has(r.metrics.realVol24h) && r.metrics.realVol24h > 0)
        .sort((x, y) => y.metrics.realVol24h! - x.metrics.realVol24h!);
    case "whales":
      return rows.filter((r) => has(r.metrics.top10Pct) && (r.metrics.holders ?? 0) >= 20)
        .sort((x, y) => y.metrics.top10Pct! - x.metrics.top10Pct!);
  }
}
