// The screener: a graded row for every token in the active universe, kept warm by a background loop inside the
// Next server, served from memory (never computed inside a request).
//
// Universe (refreshed every 5 min): the newest ~60 v6 launches + the top ~60 by 24 h volume among the last
// ~400 v6 launches (vibe's /v6/launches has no sort, so 8 pages of 50 are read) + the v1 Hot board page + $EXIT.
// Each token: the same /api/analytics answer the token page shows (engine.ts / v6engine.ts, shared caches, so the
// loop also pre-warms token pages) + the creator's track record (devrep, 10 min cache), graded by
// lib/screener-rules.ts. Concurrency 2. Young lines (< 3 h) every 5 min, the rest every 20 min.
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
import { launchCards, launchPage, type LaunchCard } from "@/lib/launches";
import { devReputation } from "@/lib/devrep";
import { ethUsdPrice } from "@/lib/ethPrice";
import { EXIT_TOKEN } from "@/lib/config";
import { cleanEligible, devTrack, isCurrent, presentRow, RULES_VERSION, screen, type DevTrack } from "@/lib/screener-rules";
import type { Analytics } from "@/lib/analytics/types";
import type { ScreenerBoard, ScreenerResponse, ScreenerRow } from "@/lib/screener-types";

export const ON_CF = process.env.EXIT_CF === "1";

const CONCURRENCY = 2;
const TOKEN_TIMEOUT_MS = 30_000;
const UNIVERSE_MS = 5 * 60_000;
/** hard cap on one universe refresh: a request that never settles must not freeze the supervisor (17.10: 9 h) */
const UNIVERSE_TIMEOUT_MS = 120_000;
const SHRINK_ACCEPT_MS = 3 * 3600_000;
const RANK_MAX_AGE_MS = 3600_000;
const YOUNG_MIN = 180;
const YOUNG_EVERY_MS = 5 * 60_000;
const OLD_EVERY_MS = 20 * 60_000;
const TRACK_RETRY_MS = 3 * 60_000;
const NEWEST = 60;
const TOP_VOL = 60;
const V6_PAGES = 8;
/** rows of tokens that left the universe stay this long (grade cells and a dev's launch list still read them) */
const KEEP_MS = 6 * 3600_000;
const MAX_ROWS = 600;
const PERSIST_EVERY_MS = 15_000;
const IDLE_MS = 3_000;

const FILE = process.env.SCREENER_PATH || path.join(/* turbopackIgnore: true */ process.cwd(), "src", "data", "screener.json");
const PUBLIC_FILE = path.join(/* turbopackIgnore: true */ process.cwd(), "public", "screener.json");

type Meta = { card: LaunchCard; v6: boolean };
type Stats = { cycles: number; lastCycleMs: number | null; cycleStartedAt: number; doneThisCycle: number; errors: number; lastError: string | null; universe: number; universeAt: number;
  /** since when vibe's lists return less than half of the universe we had (0 = fine): the old universe is kept meanwhile */
  shrunkSince?: number };

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

async function refreshUniverse() {
  const v6: LaunchCard[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < V6_PAGES; p++) {
    try {
      const page = await launchPage("new", "", cursor, 50, 60);
      v6.push(...page.items.filter((c) => c.v6));
      cursor = page.next;
      if (!cursor) break;
    } catch {
      break; // vibe slow: what we have is the universe until the next refresh
    }
  }
  const pick = new Map<string, Meta>();
  const seen = new Set<string>();
  const uniq = v6.filter((c) => (seen.has(c.token) ? false : (seen.add(c.token), true)));
  for (const c of uniq.slice(0, NEWEST)) pick.set(c.token, { card: c, v6: true });
  // 24 h volume: ETH pairs by ETH volume; token-paired lines (VIBEVIBE, stock tokens) by trade count
  const byVol = uniq.filter((c) => (c.volume24hEth ?? 0) > 0).sort((a, b) => (b.volume24hEth ?? 0) - (a.volume24hEth ?? 0));
  for (const c of byVol.slice(0, TOP_VOL)) pick.set(c.token, { card: c, v6: true });
  const byTrades = uniq.filter((c) => c.volume24hEth === null && (c.buys24h ?? 0) + (c.sells24h ?? 0) > 0)
    .sort((a, b) => (b.buys24h ?? 0) + (b.sells24h ?? 0) - ((a.buys24h ?? 0) + (a.sells24h ?? 0)));
  for (const c of byTrades.slice(0, 10)) pick.set(c.token, { card: c, v6: true });
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
  const now = Date.now();
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
  const young = r.ageMin !== null && r.ageMin + (Date.now() - r.checkedAt) / 60_000 < YOUNG_MIN;
  // the creator's record didn't load (vibe blip): retry soon, not in 20 min
  if (r.creator && r.metrics.devLaunches === null) return r.checkedAt + TRACK_RETRY_MS;
  return r.checkedAt + (young ? YOUNG_EVERY_MS : OLD_EVERY_MS);
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
  try {
    const row = await gradeToken(t, S.universe.get(t) ?? null);
    S.rows.set(t, row);
    S.asOf = Date.now();
    S.dirty = true;
    S.failedAt.delete(t);
    S.stats.doneThisCycle++;
  } catch (e) {
    S.failedAt.set(t, Date.now());
    S.stats.errors++;
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
  return { ...S.stats, unknownFactory: v6UnknownFactoryCount(), newestGradedAgeMin: newestGradedAgeMin(), rows: S.rows.size, inflight: S.inflight.size, running: S.running, onCf: ON_CF, rulesVersion: RULES_VERSION, staleRules };
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
