// Screener rules: every threshold, penalty and reason text of the token check, in ONE place.
// Pure (no server imports): the screener warm loop (lib/screener.ts) and the token report both call screen()
// on the same /api/analytics answer, so the board and the report always show the same letter and reasons.
//
// Score: 100 minus the penalties below. Letter: lib/health gradeFor (A 85+, B 70+, C 55+, D 40+, F), and any
// "bad" reason caps the letter at C (capGrade). Verdict: A/B clean, C caution, D/F risk.
// No letter ("Too early to grade"): younger than MIN_AGE_MIN or of unknown age, fewer than MIN_TRADES trades,
// fewer than MIN_FRONT first buyers, or the holders / trades could not be read. Unknown inputs are never penalised, never
// shown as 0 and never praised: a green reason needs a minimum sample behind it.
import type { Analytics, VolWindow } from "@/lib/analytics/types";
import { capGrade, gradeFor } from "@/lib/health";
import type { Grade, ReasonLevel, ScreenerMetrics, ScreenerReason, ScreenerRow, Verdict } from "@/lib/screener-types";

/** bump on any rule change: the warm loop re-grades every row graded under another version first */
export const RULES_VERSION = 9;

/** graded under these rules (ScreenerRow.rulesV) */
export const isCurrent = (r: ScreenerRow) => r.rulesV === RULES_VERSION;
/** A row as it may leave the server: one graded under other rules carries no letter, no score and no reasons
 *  (an old letter is not this site's grade any more); it reads "Too early to grade" until the loop re-grades it. */
export const presentRow = (r: ScreenerRow): ScreenerRow => (isCurrent(r) ? r : { ...r, grade: null, score: null, verdict: "unknown", reasons: [] });

export const RULES = {
  MIN_AGE_MIN: 10,
  MIN_TRADES: 10,
  /** also the sample behind "No known snipers": fewer first buyers say nothing */
  MIN_FRONT: 5,
  /** trades of known size in the window behind any volume reason (wash, bots, real): fewer say nothing */
  MIN_VOL_TRADES: 10,
  /** fewer holders than this: nobody is in the token, so never a clean letter (C at best) */
  MIN_HOLDERS: 10,
  /** "Top 10 hold only N%" is praise only with a real crowd behind it */
  TOP10_GOOD_HOLDERS: 30,
  /** reasons shown next to the letter */
  MAX_REASONS: 3,
  /** the Cleanest board only lists lines with real activity */
  CLEAN_MIN_HOLDERS: 10,
  CLEAN_MIN_TRADES24: 10,

  DEV_SOLD_BAD: 50, DEV_SOLD_WARN: 15, DEV_SOLD_SOME: 5,
  /** the dev dumped (most of) the bag: never better than D, whatever else looks fine */
  DEV_DUMPED: 80,
  DEV_HOLDS_BAD: 30, DEV_HOLDS_WARN: 15,
  SNIPERS_BAD: 12, SNIPERS_WARN: 6, SNIPERS_SHARE_BAD: 0.6, SNIPERS_SHARE_WARN: 0.5,
  FARM_BAD: 6, FARM_WARN: 2,
  BUNDLE_BAD: 25, BUNDLE_WARN: 10,
  TOP10_BAD: 60, TOP10_WARN: 35, TOP10_GOOD: 20,
  REAL_BAD: 20, REAL_WARN: 50, REAL_GOOD: 70,
  /** dev track: other launches and graduation rate */
  TRACK_BAD_LAUNCHES: 10, TRACK_BAD_RATE: 0.1, TRACK_WARN_LAUNCHES: 3,
  /** a good graduation rate is praise only over this many other launches */
  TRACK_GOOD_LAUNCHES: 3, TRACK_GOOD_RATE: 0.5,
} as const;

const P = {
  devSoldBad: 30, devSoldWarn: 15, devSoldSome: 5,
  devHoldsBad: 20, devHoldsWarn: 10,
  sniperEach: 3, sniperMax: 36,
  farmBad: 20, farmWarn: 10,
  bundleBad: 20, bundleWarn: 10,
  top10Bad: 20, top10Warn: 10,
  realBad: 20, realWarn: 10,
  trackBad: 15, trackWarn: 8,
};

/** partial = vibe's taxed-v6 list did not answer: the counts are a lower bound (enough to blame, not to praise) */
export type DevTrack = { launches: number; graduated: number; partial?: boolean } | null;

/** what devTrack() reads: lib/devrep DevRep (server) and DevPassport (/api/dev/<creator>/passport) both fit */
export type DevHistory = {
  total: number | null;
  loaded: number;
  graduated: number;
  launches: { token: string; graduated: boolean }[];
  onChain?: { launches: number; grads: number } | null;
  coverage: "full" | "v1-only";
};

/** The creator's OTHER launches and how many of them graduated. The ONE count behind the "dev track" reason:
 *  the warm loop (lib/screener devTrackOf) and the token page both call it. null = unknown. */
export function devTrack(h: DevHistory, self: string): DevTrack {
  const t = self.toLowerCase();
  const listed = h.total ?? h.loaded;
  const selfIn = h.launches.find((l) => l.token.toLowerCase() === t);
  const selfGrad = selfIn?.graduated ? 1 : 0;
  const partial = h.coverage !== "full";
  // the factory history beats vibe's lists when vibe leaves the first / legacy factories out
  if (h.onChain && h.onChain.launches > listed) {
    return { launches: Math.max(0, h.onChain.launches - 1), graduated: Math.max(0, h.onChain.grads - selfGrad), ...(partial ? { partial } : {}) };
  }
  const others = Math.max(0, listed - 1);
  // "no other launches" is a claim: not from a list that misses this very token, or from half of vibe's lists
  if (others === 0 && (!selfIn || partial)) return null;
  return { launches: others, graduated: Math.max(0, h.graduated - selfGrad), ...(partial ? { partial } : {}) };
}

export type ScreenInput = {
  a: Analytics;
  /** minutes since launch; null = unknown */
  ageMin: number | null;
  /** the creator's other launches (this one excluded); null = unknown */
  track: DevTrack;
  /** USD per ETH for ETH-paired lines; null = unknown (USD fields stay null) */
  ethUsd: number | null;
};

export type ScreenResult = {
  grade: Grade | null;
  score: number | null;
  verdict: Verdict;
  reasons: ScreenerReason[];
  metrics: ScreenerMetrics;
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const pctTxt = (v: number) => `${v >= 10 ? Math.round(v) : r1(v)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** trades whose size is known: the sample behind a volume share */
const sized = (w: VolWindow) => w.trades - w.unknownTrades;

/** the 24h window when it has enough sized trades to say anything, else the whole history */
function dayWindow(a: Analytics): VolWindow | null {
  const ws = a.volume.data?.windows ?? [];
  const d = ws.find((w) => w.label === "24h");
  if (d && sized(d) >= RULES.MIN_VOL_TRADES) return d;
  return ws.find((w) => w.label === "all") ?? null;
}

/** Not shown to be inside the wallet index's window (launched before it, or age unknown): sniper / bot labels
 *  don't cover its first buyers, so "no snipers" is unknown there, never clean */
function predatesIndex(inp: ScreenInput): boolean {
  const w = windowOf(inp);
  const age = ageOf(inp);
  return !!w && (age === null || age > w * 1440);
}
/** the wallet index's window in days, as the analytics answer carries it (null = index unusable: labels are null too) */
const windowOf = (inp: ScreenInput) => inp.a.indexWindowDays ?? null;
const ageOf = (inp: ScreenInput) => inp.ageMin ?? (inp.a.ageSec != null ? Math.floor(inp.a.ageSec / 60) : null);

function metricsOf(inp: ScreenInput): ScreenerMetrics & { tradesAll: number | null; volTrades: number } {
  const { a, track, ethUsd } = inp;
  const old = predatesIndex(inp);
  const sup = a.supply.data;
  const bun = a.bundle.data;
  const em = a.exitMath.data;
  const mk = a.market.data;
  const ws = a.volume.data?.windows ?? [];
  const day = ws.find((w) => w.label === "24h") ?? null;
  const all = ws.find((w) => w.label === "all") ?? null;
  const w = dayWindow(a);
  const native = a.unit ? a.unit.native : true;
  const vol = w && w.volumeEth > 0 ? w.volumeEth : null;
  const reserved = a.v6?.gifts?.reservedPct ?? 0;
  // bags with a known cost: the only ones that can be "in profit" or not (a bag with no price is neither)
  const priced = em ? em.exactCost + em.estimatedCost : 0;
  const usd = (v: number | null) => (native && ethUsd !== null && v !== null ? Math.round(v * ethUsd) : null);
  const vol24Pair = day ? day.volumeEth : null;
  return {
    snipers20: old ? null : a.health?.snipers ?? null,
    bundledPct: bun ? r1(bun.boughtPct) : null,
    top10Pct: sup ? r1(sup.top10Pct) : null,
    devHoldsPct: sup?.creatorPct === null || sup?.creatorPct === undefined ? null : r1(Math.max(0, sup.creatorPct - reserved)),
    devSoldPct: sup?.devSoldPct ?? null,
    realVolPct: vol ? r1((w!.realEth / vol) * 100) : null,
    washPct: vol ? r1((w!.washEth / vol) * 100) : null,
    botPct: vol && w!.botEth !== null && !old ? r1((w!.botEth / vol) * 100) : null,
    profitPct: em && priced > 0 ? r1((em.profitHolders / priced) * 100) : null,
    holders: sup ? sup.holders : null,
    mcap: usd(mk?.mcapEth ?? null),
    vol24h: usd(vol24Pair),
    realVol24h: usd(day ? day.realEth : null),
    mcapPair: mk?.mcapEth ?? null,
    vol24hPair: vol24Pair,
    pairUnit: a.unit?.symbol ?? "ETH",
    trades24h: day ? day.trades : null,
    tradesAll: all ? all.trades : null,
    volTrades: w ? sized(w) : 0,
    devLaunches: track ? track.launches : null,
    devGraduated: track ? track.graduated : null,
  };
}

type R = ScreenerReason & { p: number };

/** The check of one token. Pure: same input, same letter, same reasons. */
export function screen(inp: ScreenInput): ScreenResult {
  const { a } = inp;
  const m = metricsOf(inp);
  const { tradesAll, volTrades, ...metrics } = m;
  const out: R[] = [];
  const add = (id: string, text: string, level: ReasonLevel, p: number) => out.push({ id, text, level, p });
  const sup = a.supply.data;

  // ---- dev sold ----
  if (m.devSoldPct !== null) {
    if (m.devSoldPct >= RULES.DEV_SOLD_BAD) add("devSold", `Dev sold ${pctTxt(m.devSoldPct)}`, "bad", P.devSoldBad);
    else if (m.devSoldPct >= RULES.DEV_SOLD_WARN) add("devSold", `Dev sold ${pctTxt(m.devSoldPct)}`, "warn", P.devSoldWarn);
    else if (m.devSoldPct >= RULES.DEV_SOLD_SOME) add("devSold", `Dev sold ${pctTxt(m.devSoldPct)}`, "warn", P.devSoldSome);
    else if (m.devSoldPct === 0 && sup?.devSells === 0 && !sup.devMovedTo) add("devSold", "Dev hasn't sold", "good", 0);
  }
  // dev moved tokens to other wallets (a quiet way to sell later)
  if (sup?.devMovedTo && sup.devMovedTo > 0) add("devMoved", `Dev moved tokens to ${plural(sup.devMovedTo, "wallet")}`, "warn", 5);

  // ---- dev holds ----
  if (m.devHoldsPct !== null) {
    if (m.devHoldsPct >= RULES.DEV_HOLDS_BAD) add("devHolds", `Dev holds ${pctTxt(m.devHoldsPct)}`, "bad", P.devHoldsBad);
    else if (m.devHoldsPct >= RULES.DEV_HOLDS_WARN) add("devHolds", `Dev holds ${pctTxt(m.devHoldsPct)}`, "warn", P.devHoldsWarn);
  }

  // ---- snipers / farms up front ----
  const n = a.health?.firstBuyers ?? 0;
  if (m.snipers20 !== null && n > 0) {
    // known sniper bots are the norm on vibe (median 11 of the first 20, lib/health): the count AND the share
    const s = m.snipers20;
    const share = s / n;
    const p = Math.min(P.sniperMax, P.sniperEach * s);
    const txt = n === 1 ? "First buyer is a sniper" : `${plural(s, "sniper")} in first ${n} buyers`;
    if (s >= RULES.SNIPERS_BAD || (n >= 10 && share >= RULES.SNIPERS_SHARE_BAD)) add("snipers", txt, "bad", p);
    else if (s >= RULES.SNIPERS_WARN || (n >= RULES.MIN_FRONT && share >= RULES.SNIPERS_SHARE_WARN)) add("snipers", txt, "warn", p);
    else if (s > 0) add("snipers", txt, "warn", p);
    else if (n >= RULES.MIN_FRONT) add("snipers", `No known snipers in first ${n} buyers`, "good", 0);
  }
  const farm = predatesIndex(inp) ? null : a.health?.farm ?? null;
  if (farm !== null && n > 0) {
    if (farm >= RULES.FARM_BAD) add("farm", `${farm} of first ${n} are one farm`, "bad", P.farmBad);
    else if (farm >= RULES.FARM_WARN) add("farm", `${farm} of first ${n} are farm wallets`, "warn", P.farmWarn);
  }

  // ---- bundles at launch ----
  if (m.bundledPct !== null) {
    if (m.bundledPct >= RULES.BUNDLE_BAD) add("bundle", `Bundles bought ${pctTxt(m.bundledPct)} of supply`, "bad", P.bundleBad);
    else if (m.bundledPct >= RULES.BUNDLE_WARN) add("bundle", `Bundles bought ${pctTxt(m.bundledPct)} of supply`, "warn", P.bundleWarn);
  }

  // ---- concentration ----
  if (m.top10Pct !== null && (m.holders ?? 0) >= RULES.MIN_HOLDERS) {
    if (m.top10Pct >= RULES.TOP10_BAD) add("top10", `Top 10 hold ${pctTxt(m.top10Pct)}`, "bad", P.top10Bad);
    else if (m.top10Pct >= RULES.TOP10_WARN) add("top10", `Top 10 hold ${pctTxt(m.top10Pct)}`, "warn", P.top10Warn);
    else if (m.top10Pct < RULES.TOP10_GOOD && (m.holders ?? 0) >= RULES.TOP10_GOOD_HOLDERS) add("top10", `Top 10 hold only ${pctTxt(m.top10Pct)}`, "good", 0);
  }

  // ---- real volume ----
  if (m.realVolPct !== null && volTrades >= RULES.MIN_VOL_TRADES) {
    const wash = m.washPct ?? 0;
    const bot = m.botPct ?? 0;
    const fake = wash >= bot ? `${pctTxt(wash)} of volume is wash` : `Bots made ${pctTxt(bot)} of volume`;
    if (m.realVolPct < RULES.REAL_BAD) add("volume", fake, "bad", P.realBad);
    else if (m.realVolPct < RULES.REAL_WARN) add("volume", fake, "warn", P.realWarn);
    // praise only on a full check: bot labels cover the line, and dust was taken out (token pair of unknown scale: not)
    else if (m.realVolPct >= RULES.REAL_GOOD && m.botPct !== null && a.volume.data?.dust !== null) add("volume", `${pctTxt(m.realVolPct)} of volume is real`, "good", 0);
  }

  // ---- dev track record ----
  const t = inp.track;
  if (t) {
    const txt = `Dev: ${plural(t.launches, "other launch", "other launches")}, ${t.graduated} graduated`;
    if (t.launches >= RULES.TRACK_BAD_LAUNCHES && t.graduated / t.launches < RULES.TRACK_BAD_RATE) add("devTrack", txt, "bad", P.trackBad);
    else if (t.launches >= RULES.TRACK_WARN_LAUNCHES && t.graduated === 0) add("devTrack", txt, "warn", P.trackWarn);
    // praise only from the whole history (a partial one may hide the launches that did not graduate)
    else if (t.partial) { /* a lower bound says nothing good */ }
    else if (t.launches >= RULES.TRACK_GOOD_LAUNCHES && t.graduated / t.launches >= RULES.TRACK_GOOD_RATE) add("devTrack", txt, "good", 0);
    else if (t.launches === 0) add("devTrack", "Dev's first launch", "good", 0);
  }

  // ---- nobody home: a token a handful of wallets hold can't be "clean", whatever the other numbers say ----
  const fewHolders = m.holders !== null && m.holders < RULES.MIN_HOLDERS;
  // sniper labels unknown: the line predates the wallet index, or the index is too old / missing
  const old = predatesIndex(inp);
  const snipersUnknown = m.snipers20 === null && n >= RULES.MIN_FRONT;
  // the creator's other launches did not load (or the creator is unknown): not "a first launch", not checked
  const trackUnknown = inp.track === null;
  // ... or only half of vibe's lists answered: the counts are a lower bound
  const trackPartial = !!inp.track?.partial;
  // token pair of unknown scale: dust trades were not taken out, so the wash share is a lower bound
  const dustUnknown = a.volume.data?.dust === null;
  const age = ageOf(inp);

  const rank: Record<ReasonLevel, number> = { bad: 0, warn: 1, good: 2 };
  out.sort((x, y) => rank[x.level] - rank[y.level] || y.p - x.p);
  // the caps explain the letter, so they sit right after the bad facts
  const caps: R[] = [];
  if (fewHolders) caps.push({ id: "holders", text: `Only ${plural(m.holders!, "holder")}`, level: "warn", p: 0 });
  if (snipersUnknown) caps.push({ id: "snipers", text: old && age !== null ? `Snipers not checked (older than ${plural(windowOf(inp) ?? 0, "day")})` : "Snipers not checked", level: "warn", p: 0 });
  if (trackUnknown) caps.push({ id: "devTrack", text: "Dev history not checked", level: "warn", p: 0 });
  // (one reason per id: a partial history / an unchecked volume that already has a bad fact shows that fact)
  if (trackPartial && !out.some((x) => x.id === "devTrack")) caps.push({ id: "devTrack", text: "Dev history partly checked", level: "warn", p: 0 });
  if (dustUnknown && !out.some((x) => x.id === "volume")) caps.push({ id: "volume", text: "Wash trades partly checked", level: "warn", p: 0 });
  const firstSoft = out.findIndex((x) => x.level !== "bad");
  out.splice(firstSoft < 0 ? out.length : firstSoft, 0, ...caps);
  const reasons = out.slice(0, RULES.MAX_REASONS).map(({ p: _p, ...r }) => (void _p, r));

  // ---- no letter: too young (an unknown age is not shown to be past the gate), too few trades / first buyers,
  // or the holders were not read (a letter without them would grade dev bag, dev selling and concentration as
  // "fine" when they are unknown) ----
  const young = age === null || age < RULES.MIN_AGE_MIN;
  const thin = tradesAll === null || tradesAll < RULES.MIN_TRADES;
  const noFront = !a.health || a.health.firstBuyers < RULES.MIN_FRONT;
  if (young || thin || noFront || !sup) return { grade: null, score: null, verdict: "unknown", reasons, metrics };

  const score = Math.max(0, Math.min(100, 100 - out.reduce((s, r) => s + r.p, 0)));
  const bad = out.filter((r) => r.level === "bad").length;
  let grade = capGrade(gradeFor(score), bad);
  // snipers / farms unknown (old line, or no usable wallet index), the dev's record unknown or partial, or dust
  // not taken out of the volume: never a top letter on a partial check
  if ((snipersUnknown || trackUnknown || trackPartial || dustUnknown) && grade === "A") grade = "B";
  // a clean letter next to "9 of first 20 are snipers" reads as a lie: many snipers up front = caution at best.
  // The share counts too: 3 snipers of 5 first buyers is a sniped launch, not a clean one
  const sniped = m.snipers20 !== null && (m.snipers20 >= RULES.SNIPERS_WARN || (n >= RULES.MIN_FRONT && m.snipers20 / n >= RULES.SNIPERS_SHARE_WARN));
  if ((sniped || fewHolders) && (grade === "A" || grade === "B")) grade = "C";
  // the dev dumped the bag: high risk at best
  if (m.devSoldPct !== null && m.devSoldPct >= RULES.DEV_DUMPED && grade !== "F") grade = "D";
  const verdict: Verdict = grade === "A" || grade === "B" ? "clean" : grade === "C" ? "caution" : "risk";
  return { grade, score, verdict, reasons, metrics };
}

/** a "clean" row worth listing on the Cleanest board: real holders and real trading, not an empty token */
export function cleanEligible(m: ScreenerMetrics): boolean {
  // every "Looks clean" token with real activity; the board sorts fully checked lines (snipers known) first
  return (m.holders ?? 0) >= RULES.CLEAN_MIN_HOLDERS && (m.trades24h ?? 0) >= RULES.CLEAN_MIN_TRADES24 && (m.realVolPct ?? 0) > 0;
}
