// Screener rules v11: every threshold, penalty and reason text of the token check, in ONE place.
// Pure (no server imports): the screener warm loop (lib/screener.ts) and the token report both call screen()
// on the same /api/analytics answer, so the board and the report always show the same letter and reasons.
//
// The letter is the risk of becoming someone's exit liquidity (A "No red flags found" .. F "Likely exit liquidity"),
// and a separate coverage marker says how much of it was read ("Full check" / "Partial: <what wasn't checked>").
// Why v11 (audit 17.11, backtest of v9/v10 against what happened next): the old letter did not predict outcomes.
// Most live A were graduation pumps (one fresh wallet bought the curve out and dumped it into the pool within
// seconds, top wallet 55-88% of volume, ~10 holders); snipers and dev sells went WITH demand, not against it;
// what separates outcomes is activity (real holders, trades) and how far the price already ran above launch.
//
//   score   100 minus the penalties, counted by family (Dev, Volume, Concentration, Front, Price, Activity): inside
//           a family the biggest penalty + 25% of the rest, capped at FAMILY_CAP. Letter by score (lib/health gradeFor).
//   caps    a critical fact or two red facts: F (and only they: a low score alone is D). One red fact: D at best.
//           A hard gate: C at best (no A/B).
//           A needs a Full check and no flag at all; anything less is B at best.
//   gates   one wallet made 50%+ of the volume; a wallet bought 20%+ of supply and sold 80%+ of it; a graduated line
//           with a dead pool; fewer than 20 real holders or 25 trades in 24 h. A/B also need every gate input READ.
//   no letter  "Too new" (under 10 min or age unknown), "Not enough trading yet" (under 10 real holders, 10 trades
//           or 5 first buyers), "Couldn't read" (holders / trades / first buyers unread). A red fact grades anyway.
// Unknown inputs are never penalised as facts, never shown as 0, never praised, and never open a gate.
import type { Analytics, VolWindow } from "@/lib/analytics/types";
import { gradeFor } from "@/lib/health";
import type { Grade, NoGrade, ReasonLevel, ScreenerMetrics, ScreenerReason, ScreenerRow, Verdict } from "@/lib/screener-types";

/** bump on any rule change: the warm loop re-grades every row graded under another version first */
export const RULES_VERSION = 11;

/** graded under these rules (ScreenerRow.rulesV) */
export const isCurrent = (r: ScreenerRow) => r.rulesV === RULES_VERSION;
/** A row as it may leave the server: one graded under other rules carries no letter, no score and no reasons
 *  (an old letter is not this site's grade any more); it reads "Checking…" until the loop re-grades it. */
export const presentRow = (r: ScreenerRow): ScreenerRow =>
  isCurrent(r) ? r : { ...r, grade: null, score: null, verdict: "unknown", reasons: [], metrics: { ...r.metrics, noGrade: "pending", coverage: undefined } };

export const RULES = {
  MIN_AGE_MIN: 10,
  /** thin: under any of these there is no letter (unless a red fact) */
  THIN_HOLDERS: 10,
  THIN_TRADES: 10,
  MIN_FRONT: 5,
  /** trades of known size in the window behind any volume reason: fewer say nothing */
  MIN_VOL_TRADES: 10,
  /** reasons shown next to the letter */
  MAX_REASONS: 3,

  // ---- hard gates: no A/B ----
  /** one wallet made this % of the window's volume */
  GATE_TOP1: 50,
  /** activity: fewer real holders / trades in 24 h */
  GATE_HOLDERS: 20,
  GATE_TRADES24: 25,
  /** pump: one wallet bought this % of supply (peak position) and sold this % of what it bought */
  PUMP_BOUGHT: 20,
  PUMP_SOLD: 80,
  /** graduated line, dead pool: pair side under this, no trade in 24 h, or fewer real holders than this */
  POOL_MIN_ETH: 1,
  POOL_MIN_HOLDERS: 30,

  // ---- Dev family ----
  DEV_HOLDS_CRIT: 40,
  DEV_HOLDS_BAD: 20,
  DEV_HOLDS_WARN: 10,
  /** dev sold this % of TOTAL supply: a warning on its own */
  DEV_SOLD_WARN: 10,
  /** ... red only with this much ETH taken out over what it put in (ETH pairs) */
  DEV_ETH_OUT_BAD: 1,

  // ---- Volume family ----
  TOP1_WARN: 35,
  REAL_BAD: 20,
  REAL_WARN: 40,
  REAL_GOOD: 70,

  // ---- Concentration family ----
  /** one holder (not the dev, not the curve / pool) holds this % of supply */
  WHALE_BAD: 20,
  /** top 10 hold this % of what people hold (with GATE_HOLDERS+ real holders) */
  TOP10_CIRC_WARN: 80,

  // ---- Front family: snipers / bundles are information, a penalty only while they still hold a lot ----
  SNIPERS_HOLD_WARN: 15,
  BUNDLE_HELD_WARN: 25,

  // ---- Price family ----
  /** "Late entry": market cap this many times the launch market cap (audit A: a 20%+ drop was 76-87% likely at
   *  1.6-3 ETH against a 1.25 ETH launch, 3-15% under 1.6) */
  LATE_X: 1.3,

  FAMILY_CAP: 40,
  FAMILY_REST: 0.25,
  /** Rankings "Clean": a trade within this many hours */
  CLEAN_RECENT_H: 6,
} as const;

/** points off per finding (the /methodology table reads them) */
export const POINTS = {
  devHoldsCrit: 40, devHoldsBad: 25, devHoldsWarn: 10,
  devPump: 40, devSoldBad: 25, devSoldWarn: 10, devMoved: 5,
  pump: 25, top1Gate: 15, top1Warn: 8, realBad: 20, realWarn: 8,
  whale: 25, top10Circ: 10,
  snipersHold: 10, bundleHeld: 10,
  late: 15,
  deadPool: 15, thinActivity: 10,
};

const P = POINTS;

type Family = "dev" | "volume" | "conc" | "front" | "price" | "activity";

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
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const dur = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} d`);
const numTxt = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));

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

/** real holders: the engine's count (bought on the market, non-dust bag); an older answer without it: every holder
 *  minus the airdrop-only wallets (an upper bound: dust is still in, said by the coverage marker) */
function realHoldersOf(a: Analytics): { n: number | null; exact: boolean } {
  const sup = a.supply.data;
  if (!sup) return { n: null, exact: false };
  if (typeof sup.realHolders === "number") return { n: sup.realHolders, exact: true };
  return { n: Math.max(0, sup.holders - (a.v6?.gifts?.onlyGiftHolders ?? 0)), exact: false };
}

type Extra = { tradesAll: number | null; volTrades: number; win: VolWindow | null; top1VolPct: number | null; launchX: number | null; poolEth: number | null; lastTradeAt: number | null };

function metricsOf(inp: ScreenInput): ScreenerMetrics & Extra {
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
  const pu = sup?.pusher ?? null;
  const conc = w?.concentration ?? null;
  const launch = mk?.launchMcapEth ?? null;
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
    holders: realHoldersOf(a).n,
    holdersAll: sup ? sup.holders : null,
    mcap: usd(mk?.mcapEth ?? null),
    vol24h: usd(vol24Pair),
    realVol24h: usd(day ? day.realEth : null),
    mcapPair: mk?.mcapEth ?? null,
    vol24hPair: vol24Pair,
    pairUnit: a.unit?.symbol ?? "ETH",
    trades24h: day ? day.trades : null,
    devLaunches: track ? track.launches : null,
    devGraduated: track ? track.graduated : null,
    top1VolPct: conc ? r1(conc.top1Pct) : null,
    pusherBoughtPct: pu ? r1(pu.boughtPct) : null,
    pusherSoldPct: pu ? r1(pu.soldPctOfBought) : null,
    pusherIsDev: pu ? pu.isDev : null,
    poolEth: mk?.poolEth ?? null,
    lastTradeAt: mk?.lastTradeAt ?? null,
    launchX: mk?.mcapEth != null && launch && launch > 0 ? Math.round((mk.mcapEth / launch) * 100) / 100 : null,
    tradesAll: all ? all.trades : null,
    volTrades: w ? sized(w) : 0,
    win: w,
  };
}

/** p = points off, s = sort weight among reasons of one level (the gate reasons explain the letter: shown first) */
type R = ScreenerReason & { p: number; f: Family | null; s: number; critical: boolean };

/** The check of one token. Pure: same input, same letter, same reasons. */
export function screen(inp: ScreenInput): ScreenResult {
  const { a } = inp;
  const m = metricsOf(inp);
  const { tradesAll, volTrades, win, ...metrics } = m;
  const out: R[] = [];
  const add = (id: string, text: string, level: ReasonLevel, f: Family | null, p: number, s = p, critical = false) =>
    out.push({ id, text, level, p, f, s, critical });
  const sup = a.supply.data;
  const vd = a.volume.data;
  const native = a.unit ? a.unit.native : true;
  const unit = a.unit?.symbol ?? "ETH";
  const nowSec = Math.floor((a.computedAt || Date.now()) / 1000);
  const age = ageOf(inp);
  const realH = realHoldersOf(a);
  const gifted = a.v6?.gifts?.onlyGiftHolders ?? 0;
  /** what the check could not read: any item = Partial (A needs none) */
  const coverage: string[] = [];
  /** a gate input that was not read: no gate is shown to be passed, so no A/B */
  let gateUnknown = false;
  let gate = false;

  // ---- pump: one wallet bought a big share of supply and sold it back (the graduation pump of audit 17.11) ----
  const pu = sup?.pusher ?? null;
  if (sup && !pu) { coverage.push("big sellers not read"); gateUnknown = true; }
  const pump = !!pu && pu.boughtPct >= RULES.PUMP_BOUGHT && pu.soldPctOfBought >= RULES.PUMP_SOLD;
  if (pu && pump) {
    gate = true;
    const fast = pu.firstBuyAt !== null && pu.lastSellAt !== null && pu.lastSellAt >= pu.firstBuyAt ? ` within ${dur(pu.lastSellAt - pu.firstBuyAt)}` : "";
    const what = `bought ${pctTxt(pu.boughtPct)} of supply and sold ${pctTxt(pu.soldPctOfBought)} of it${fast}`;
    // the dev pumping his own line: likely exit liquidity. Creator unknown: the wallet's pump, no more
    // a third-party flip on a line nobody else is in (bots flip most fresh curves): a fact, not a lure. It turns
    // red once the line has a crowd it could have pulled in; the dev doing it is always red
    const crowdless = realH.n !== null && tradesAll !== null && (realH.n < RULES.THIN_HOLDERS || tradesAll < RULES.THIN_TRADES);
    if (pu.isDev === true) add("pump", `Dev ${what}`, "bad", "dev", P.devPump, 100, true);
    else if (crowdless) add("pump", `One wallet ${what}`, "warn", "volume", P.top1Gate, 60);
    else add("pump", `One wallet ${what}`, "bad", "volume", P.pump, 100);
  }

  // ---- dev ----
  if (m.devHoldsPct !== null) {
    const t = `Dev holds ${pctTxt(m.devHoldsPct)} of supply`;
    if (m.devHoldsPct >= RULES.DEV_HOLDS_CRIT) add("devHolds", t, "bad", "dev", P.devHoldsCrit, 90, true);
    else if (m.devHoldsPct >= RULES.DEV_HOLDS_BAD) add("devHolds", t, "bad", "dev", P.devHoldsBad);
    else if (m.devHoldsPct >= RULES.DEV_HOLDS_WARN) add("devHolds", t, "warn", "dev", P.devHoldsWarn);
  }
  const soldSup = sup?.devSoldSupplyPct ?? null;
  if (sup && (soldSup === null || m.devHoldsPct === null)) coverage.push("dev wallet not read");
  // a dev pump already says it (and grades F): no second reason for the same sells
  if (soldSup !== null && soldSup >= RULES.DEV_SOLD_WARN && !(pump && pu?.isDev === true)) {
    const net = native && sup!.devEthOut != null ? sup!.devEthOut - (sup!.devEthIn ?? 0) : null;
    // the ETH side unread on an ETH pair: the sells can't be shown to be small, so not a full check
    if (native && net === null) coverage.push("dev ETH not read");
    if (net !== null && net >= RULES.DEV_ETH_OUT_BAD) add("devSold", `Dev sold ${pctTxt(soldSup)} of supply, ${numTxt(net)} ${unit} more out than in`, "bad", "dev", P.devSoldBad);
    else add("devSold", `Dev sold ${pctTxt(soldSup)} of supply`, "warn", "dev", P.devSoldWarn);
  }
  if (sup?.devMovedTo && sup.devMovedTo > 0) add("devMoved", `Dev moved tokens to ${plural(sup.devMovedTo, "wallet")}`, "warn", "dev", P.devMoved);

  // ---- volume: who makes it, and how much of it is real ----
  if (!vd || !win) gateUnknown = true;
  else if (m.top1VolPct === null) { coverage.push("volume split not read"); gateUnknown = true; }
  if (m.top1VolPct !== null) {
    const t = `${win?.concentration?.topIsDev === true ? "Dev" : "One wallet"} made ${pctTxt(m.top1VolPct)} of ${win?.label === "24h" ? "24h " : ""}volume`;
    if (m.top1VolPct >= RULES.GATE_TOP1) { gate = true; add("top1", t, "warn", "volume", P.top1Gate, 60); }
    else if (m.top1VolPct >= RULES.TOP1_WARN) add("top1", t, "warn", "volume", P.top1Warn);
  }
  const washKnown = !!vd && vd.dust !== null && typeof vd.washWindowSec === "number" && !vd.washWindowUnknown;
  if (vd && !washKnown) coverage.push("wash partly checked");
  // a pump's own round trip IS the wash: the pump reason already says it (one fact, one reason, one red)
  if (m.realVolPct !== null && volTrades >= RULES.MIN_VOL_TRADES && !pump) {
    const wash = m.washPct ?? 0;
    const bot = m.botPct ?? 0;
    const fake = wash >= bot ? `${pctTxt(wash)} of volume is wash` : `Bots made ${pctTxt(bot)} of volume`;
    if (m.realVolPct < RULES.REAL_BAD && m.top1VolPct !== null && m.top1VolPct >= RULES.TOP1_WARN) add("volume", `Only ${pctTxt(m.realVolPct)} of volume is real`, "bad", "volume", P.realBad);
    else if (m.realVolPct < RULES.REAL_WARN) add("volume", fake, "warn", "volume", P.realWarn);
    // praise only on a full read: one wallet is not the volume, wash timed, dust out, bot labels cover the line
    else if (m.realVolPct >= RULES.REAL_GOOD && m.top1VolPct !== null && m.top1VolPct < RULES.TOP1_WARN && washKnown && m.botPct !== null)
      add("volume", `${pctTxt(m.realVolPct)} of volume is real`, "good", null, 0);
  }

  // ---- concentration ----
  if (sup) {
    const whale = sup.top10.filter((x) => !x.flags.includes("creator")).reduce((b, x) => (x.pct > b ? x.pct : b), 0);
    if (whale >= RULES.WHALE_BAD) add("whale", `One holder has ${pctTxt(whale)} of supply`, "bad", "conc", P.whale);
    if (realH.n !== null && realH.n >= RULES.GATE_HOLDERS && sup.top10OfCirculatingPct >= RULES.TOP10_CIRC_WARN)
      add("top10", `Top 10 hold ${pctTxt(sup.top10OfCirculatingPct)} of what holders hold`, "warn", "conc", P.top10Circ);
    if (!realH.exact) coverage.push("dust holders not separated");
  }

  // ---- front: snipers / farms / bundles are information; a penalty only while they still hold a lot ----
  const old = predatesIndex(inp);
  const n = a.health?.firstBuyers ?? 0;
  if (sup && m.snipers20 !== null) {
    // the top 10 only: a lower bound of what labelled wallets hold (enough to blame, never to clear)
    const held = sup.top10.filter((x) => x.flags.includes("sniper") || x.flags.includes("farm")).reduce((t, x) => t + x.pct, 0);
    if (held >= RULES.SNIPERS_HOLD_WARN) add("snipers", `Snipers and farm wallets hold ${pctTxt(held)} of supply`, "warn", "front", P.snipersHold);
  }
  if (m.snipers20 === null && n >= RULES.MIN_FRONT) coverage.push(old && age !== null ? `snipers not checked (older than ${plural(windowOf(inp) ?? 0, "day")})` : "snipers not checked");
  const bun = a.bundle.data;
  if (!bun) coverage.push("bundles not read");
  if (bun && bun.heldPct >= RULES.BUNDLE_HELD_WARN) add("bundle", `Bundled wallets still hold ${pctTxt(bun.heldPct)} of supply`, "warn", "front", P.bundleHeld);

  // ---- dev history: information only (the Dev section shows it), but part of a full check ----
  if (inp.track === null) coverage.push("dev history not checked");
  else if (inp.track.partial) coverage.push("dev history partly checked");

  // ---- price: late entry (an unknown profit share is not "nobody in profit") ----
  if (m.launchX === null) coverage.push("launch price not read");
  else if (m.launchX >= RULES.LATE_X && (m.profitPct === null || m.profitPct > 0)) {
    add("late", `Late entry: price ${m.launchX >= 10 ? Math.round(m.launchX) : m.launchX.toFixed(1)}× launch${m.profitPct !== null ? `, ${pctTxt(m.profitPct)} of holders in profit` : ""}`, "warn", "price", P.late);
  }

  // ---- activity: real holders and trades (the strongest separator of outcomes in the audit) ----
  const tr24 = m.trades24h;
  if (realH.n === null || tr24 === null) gateUnknown = true;
  if (tr24 === null && tradesAll !== null) coverage.push("24h trades not read");
  if (a.market.data && (m.lastTradeAt === null || m.lastTradeAt === undefined)) coverage.push("last trade time not read");
  const lowAct = (realH.n !== null && realH.n < RULES.GATE_HOLDERS) || (tr24 !== null && tr24 < RULES.GATE_TRADES24);
  const actTxt = `${realH.n === null ? "—" : plural(realH.n, "real holder")}${gifted > 0 ? ` (+${gifted.toLocaleString("en-US")} airdropped)` : ""} · ${tr24 === null ? "—" : plural(tr24, "trade")} 24h`;
  if (a.graduated) {
    const last = m.lastTradeAt ?? null;
    const quiet = tr24 === 0 || (last !== null && nowSec - last > 86_400);
    // POOL_MIN_ETH is ETH: a token-paired pool (VIBEVIBE, a stock, USDG) can't be sized against it, so its size is
    // an unread gate input (never "not empty": 136 USDG passed the 1-unit bar)
    const poolKnown = native && m.poolEth !== null && m.poolEth !== undefined;
    const emptyPool = poolKnown && m.poolEth! < RULES.POOL_MIN_ETH;
    const fewH = realH.n !== null && realH.n < RULES.POOL_MIN_HOLDERS;
    if (m.poolEth === null || m.poolEth === undefined) coverage.push("pool not read");
    else if (!native) coverage.push(`pool size in ${unit}, not ETH`);
    // a dead pool can't be ruled out: no gate is shown to be passed (A/B need every gate input read)
    if (!poolKnown) gateUnknown = true;
    if (last === null && tr24 === null) gateUnknown = true;
    if (emptyPool || quiet || fewH) {
      gate = true;
      const why = emptyPool ? `pool holds ${numTxt(m.poolEth!)} ${unit}` : quiet ? "no trade in 24h" : `only ${plural(realH.n!, "real holder")}`;
      add("pool", `Graduated, ${why}`, "warn", "activity", P.deadPool, 70);
    }
  }
  if (lowAct) { gate = true; add("activity", `Only ${actTxt}`, "warn", "activity", P.thinActivity, 50); }
  else if (realH.n !== null && tr24 !== null) add("activity", actTxt, "info", null, 0);

  // ---- score: by family, the biggest penalty + a quarter of the rest, capped ----
  const reds = out.filter((r) => r.level === "bad").length;
  const critical = out.some((r) => r.critical);
  const warns = out.filter((r) => r.level === "warn").length;
  const fams = new Map<Family, number[]>();
  for (const r of out) if (r.f && r.p > 0) fams.set(r.f, [...(fams.get(r.f) ?? []), r.p]);
  let lost = 0;
  for (const ps of fams.values()) {
    const max = Math.max(...ps);
    const rest = ps.reduce((t, x) => t + x, 0) - max;
    lost += Math.min(RULES.FAMILY_CAP, max + RULES.FAMILY_REST * rest);
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - lost)));

  const rank: Record<ReasonLevel, number> = { bad: 0, warn: 1, info: 2, good: 3 };
  out.sort((x, y) => rank[x.level] - rank[y.level] || y.s - x.s);
  const reasons: ScreenerReason[] = out.slice(0, RULES.MAX_REASONS).map(({ id, text, level }) => ({ id, text, level }));

  // ---- no letter: unread, too young or too thin; a red fact grades anyway (facts need no sample) ----
  const young = age === null || age < RULES.MIN_AGE_MIN;
  const unread = tradesAll === null || !a.health || !sup || realH.n === null;
  const thin = !unread && (realH.n! < RULES.THIN_HOLDERS || tradesAll! < RULES.THIN_TRADES || a.health!.firstBuyers < RULES.MIN_FRONT);
  const noGrade: NoGrade | null = unread ? "unread" : young ? "young" : thin ? "thin" : null;
  if (noGrade && reds === 0) return { grade: null, score: null, verdict: "unknown", reasons, metrics: { ...metrics, coverage, noGrade } };

  // ---- the letter ----
  const worse = (g: Grade, cap: Grade): Grade => (g > cap ? g : cap);
  let grade: Grade = gradeFor(score);
  // F means a critical fact or two red ones, never points alone: a low score without them is D
  if (critical || reds >= 2) grade = "F";
  else if (grade === "F") grade = "D";
  if (reds === 1) grade = worse(grade, "D");
  if (gate || gateUnknown || noGrade) grade = worse(grade, "C");
  if (grade === "A" && (warns > 0 || coverage.length > 0)) grade = "B";
  const verdict: Verdict = grade === "A" || grade === "B" ? "clean" : grade === "C" ? "caution" : "risk";
  return { grade, score, verdict, reasons, metrics: { ...metrics, coverage, noGrade: null } };
}

/** A row worth listing on the Rankings Clean board (the caller keeps A/B only): a Full check, a trade in the last
 *  CLEAN_RECENT_H hours and the activity gates passed. Unknown (an older row) is never eligible. */
export function cleanEligible(m: ScreenerMetrics, nowMs: number = Date.now()): boolean {
  if (!m.coverage || m.coverage.length > 0) return false;
  if (m.lastTradeAt === null || m.lastTradeAt === undefined || nowMs / 1000 - m.lastTradeAt > RULES.CLEAN_RECENT_H * 3600) return false;
  return (m.holders ?? 0) >= RULES.GATE_HOLDERS && (m.trades24h ?? 0) >= RULES.GATE_TRADES24;
}
