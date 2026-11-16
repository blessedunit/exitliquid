"use client";
// The token page as an analytics report, shared by v1 (LiveHero) and v6 (V6Line) lines. Three levels:
//   1. Verdict: the grade, the verdict word, the reasons (from screen(): one grade on the whole site).
//   2. The line (drawn by the page): the front's sniper / farm / bundled marks come from readFront(), the one
//      caption under it is FrontCaption.
//   3. Figures: one row of key numbers. Then ReportSections: Dev, Holders, Volume, Profit, each = a title, one
//      short line and its chart, and one "All details" fold for the whole page.
// Everything reads the shared Analytics contract (/api/analytics) + Line health (/api/health); unknown is "—",
// never a zero and never a good sign.
import { memo, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { AnalyticsState } from "@/components/analytics/useTokenAnalytics";
import type { HealthRead } from "@/components/HealthCard";
import Unreadable from "./Unreadable";
import type { Analytics } from "@/lib/analytics/types";
import { VERDICT_LABEL, type Verdict as VerdictWord } from "@/lib/screener-types";
import { RULES } from "@/lib/screener-rules";
import { readVerdict } from "./verdict";
import { trackRecord, type PassportState, type TrackRecord } from "./useDevPassport";
import { fmtAge, fmtEth, fmtInt, pct, shortAddr } from "@/lib/format";
import Hourglass from "@/components/screener/Hourglass";
import Loader, { shimmer } from "@/components/ui/Loader";
import r from "./Report.module.css";

/* ---------------- shared bits ---------------- */

export type MarketItem = { label: string; value: ReactNode; sub?: ReactNode; title?: string };

/** v6 before the chain read lands: what vibe/vibe's own indexer reports (holders by bag), labelled as such */
export type Fallback = {
  holders: { wallet: string; pct: number | null; isCreator: boolean }[];
  /** every holder is in the list */
  complete: boolean;
  count: number | null;
  /** 24 h volume as text in pair units ("3.4K VIBEVIBE"); null = unknown */
  vol24: string | null;
};

export type SecId = "dev" | "holders" | "volume" | "exit";

const plural = (n: number, w: string, many = `${w}s`) => `${fmtInt(n)} ${n === 1 ? w : many}`;

/** snipers / farms among the first buyers. null = not checked: no usable wallet index, or the token launched
 *  before the index window (its first buyers predate the labels). Never drawn as a clean 0. */
function frontCount(a: Analytics | null) {
  const h = a?.health;
  if (!a || !h || h.snipers === null || h.farm === null) return null;
  if (a.indexWindowDays && a.ageSec != null && a.ageSec > a.indexWindowDays * 86_400) return null;
  return { snipers: h.snipers, farm: h.farm, of: h.firstBuyers };
}

/** the top-10 read: the chain's supply section, else vibe/vibe's holders by bag (v6) */
function topTen(a: Analytics | null, fb: Fallback | null | undefined) {
  const s = a?.supply.data;
  if (s) return { ofHeld: s.top10OfCirculatingPct, total: s.top10Pct, src: "chain" as const };
  if (!fb || !fb.holders.length || fb.holders.some((h) => h.pct === null)) return null;
  const top = fb.holders.slice(0, 10).reduce((x, h) => x + (h.pct ?? 0), 0);
  const all = fb.holders.reduce((x, h) => x + (h.pct ?? 0), 0);
  return { ofHeld: fb.complete && all > 0 ? (top / all) * 100 : null, total: top, src: "vibe" as const };
}
function devPct(a: Analytics | null, fb: Fallback | null | undefined): number | null {
  const c = a?.supply.data?.creatorPct;
  // the v6 gift reserve sits in the creator's wallet but isn't his bag (same as the grade: screener-rules metricsOf)
  if (c != null) return Math.max(0, c - (a?.v6?.gifts?.reservedPct ?? 0));
  if (!fb) return null;
  const d = fb.holders.find((h) => h.isCreator);
  return d ? d.pct : fb.complete ? 0 : null;
}

/* ---------------- the front of the line: marks for the corridor ---------------- */

/** what a person at the front carries over the head: known sniper, farm wallet, bought in a same-block group */
export type Mark = { sn: boolean; fa: boolean; bu: boolean };
export type FrontRead = {
  /** wallet (lower case) -> its marks; only wallets with at least one mark */
  marks: Map<string, Mark>;
  /** the first buyers in buy order (creator excluded), lower case */
  buyers: { wallet: string; gone: boolean }[];
  /** sniper / farm labels were checked for this token (false: said in words, never a "0") */
  labels: boolean;
  /** bundles were read */
  bundles: boolean;
};

/** null = no first-buyer list yet (loading, failed, not a launch) */
export function readFront(a: Analytics | null, health: HealthRead): FrontRead | null {
  const fb = health.res?.firstBuyers;
  if (!fb) return null;
  const labels = frontCount(a) !== null;
  const b = a?.bundle.data ?? null;
  const bundled = new Set((b?.groups ?? []).flatMap((g) => g.wallets.map((w) => w.toLowerCase())));
  const marks = new Map<string, Mark>();
  for (const x of fb) {
    const w = x.wallet.toLowerCase();
    const m = { sn: labels && x.tag === "sniper", fa: labels && !!x.tag?.startsWith("farm:"), bu: bundled.has(w) };
    if (m.sn || m.fa || m.bu) marks.set(w, m);
  }
  // a bundled wallet further back in the line carries its mark too
  for (const w of bundled) if (!marks.has(w)) marks.set(w, { sn: false, fa: false, bu: true });
  return { marks, buyers: fb.map((x) => ({ wallet: x.wallet.toLowerCase(), gone: !x.stillHolds })), labels, bundles: !!b };
}

/** The one line under the corridor: "11 of first 14 still hold · 8 snipers · 2 bundled". `faded` = the corridor
 *  draws the first buyers who sold everything as faded people (v1); a by-bag line (v6) has no such people. */
export function FrontCaption({ front, health, faded = false, active = true, children }: { front: FrontRead | null; health: HealthRead; faded?: boolean; /** false: no first-buyer read belongs to this line (/exit before launch) */ active?: boolean; children?: ReactNode }) {
  let body: ReactNode = null;
  if (front && front.buyers.length) {
    const n = front.buyers.length;
    const gone = front.buyers.filter((x) => x.gone).length;
    const first = new Set(front.buyers.map((x) => x.wallet));
    let sn = 0, fa = 0, bu = 0;
    for (const [w, m] of front.marks) {
      if (!first.has(w)) continue;
      if (m.sn) sn++;
      if (m.fa) fa++;
      if (m.bu) bu++;
    }
    const parts: ReactNode[] = [];
    if (!front.labels) parts.push(<span key="nl" className={r.dim}>snipers not checked</span>);
    else if (sn + fa === 0) { if (n >= RULES.MIN_FRONT) parts.push(<span key="nk">no known snipers</span>); }
    else {
      if (sn) parts.push(<span key="sn"><i className={`${r.dot} ${r.mSn}`} aria-hidden />{plural(sn, "sniper")}</span>);
      if (fa) parts.push(<span key="fa"><i className={`${r.dot} ${r.mFa}`} aria-hidden />{plural(fa, "farm wallet")}</span>);
    }
    if (bu) parts.push(<span key="bu"><i className={`${r.dot} ${r.mBu}`} aria-hidden />{fmtInt(bu)} bundled</span>);
    if (faded && gone) parts.push(<span key="gone"><i className={`${r.dot} ${r.lGone}`} aria-hidden />faded = sold everything</span>);
    body = <><span><b>{fmtInt(n - gone)}</b> of first {fmtInt(n)} still hold</span>{parts}</>;
  } else if (!active) {
    body = null;
  } else if (front) {
    body = <span>No buyers yet</span>;
  } else if (health.trouble === "failed") {
    body = <span className={r.dim}>First buyers unknown right now</span>;
  }
  return (
    <div className={r.caption}>
      <p className={r.capText}>{body}</p>
      {children}
    </div>
  );
}

/* ---------------- verdict ---------------- */

type VerdictProps = {
  state: AnalyticsState;
  health: HealthRead;
  /** the creator's passport (one read per page, shared with the Dev section) */
  passport?: PassportState;
  token?: string | null;
  /** unix seconds; null = unknown */
  createdAt?: number | null;
};

const VERDICT_TONE: Record<VerdictWord, string> = { clean: r.vClean, caution: r.vCaution, risk: r.vRisk, unknown: r.vUnknown };

function useNow(every = 60_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now() / 1000), 0);
    const iv = setInterval(() => setNow(Date.now() / 1000), every);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [every]);
  return now;
}

function VerdictImpl({ state, health, passport, token = null, createdAt = null }: VerdictProps) {
  const a = state.a;
  const reading = state.trouble === "loading" && !health.res;
  const track = trackRecord(passport?.p ?? null, token);
  const now = useNow();
  const ageSec = createdAt && now !== null ? Math.max(0, now - createdAt) : null;
  // the dev's record is part of the grade: until its read lands (or fails) there is no letter to show,
  // else the page flashes B + "Dev history not checked" and then settles on another letter
  const hold = !!a && !!passport?.loading;
  const v = readVerdict(hold ? null : a, track, ageSec);
  const reasons = v.reasons;
  const word = v.verdict;
  const g = v.grade ? { grade: v.grade, score: v.score } : null;
  const graded = !!a && !hold;
  const thin = graded && !v.grade;
  // no letter yet and the read is still on its way: the loader in the square, the caption once in the word
  const loading = reading || hold || (!graded && state.trouble !== "failed" && state.trouble !== "notvibe");
  const wordText = graded ? VERDICT_LABEL[word] : state.trouble === "notvibe" ? "Not a vibe/vibe launch" : "Reading the chain…";

  return (
    <section className={r.verdict} aria-label="Verdict">
      <div className={r.head}>
        {g ? (
          <span className={`${r.grade} ${VERDICT_TONE[word]}`} title={`Grade ${g.grade}, ${g.score}/100`} aria-label={`Grade ${g.grade}, ${g.score} of 100`}>
            <b aria-hidden>{g.grade}</b>
          </span>
        ) : (
          <span className={`${r.grade} ${r.gNone}`} title={loading ? "Reading the chain" : state.trouble === "failed" ? "Unknown" : "Too early to grade"}>
            {loading ? <Loader size="mini" /> : <Hourglass size={34} className={r.hourglass} />}
          </span>
        )}
        <div className={r.read}>
          {state.trouble === "failed"
            ? <Unreadable failed={state.failed} className={r.fail} />
            : <p className={`${r.word} ${graded ? "" : r.wordWait} ${VERDICT_TONE[word]}`} role="status">{wordText}</p>}
          <p className={r.meta}>
            {g && g.score !== null && <span className={r.num}>{g.score}/100</span>}
            {thin && ageSec !== null && ageSec < 600 && <span>launched {Math.max(1, Math.round(ageSec / 60))} min ago</span>}
            {state.stale && <span className={r.stale}>stale</span>}
          </p>
        </div>
      </div>
      {reasons.length > 0 ? (
        <ol className={r.reasons} aria-label="Why">
          {reasons.map((x) => (
            <li key={x.id} className={x.level === "bad" ? r.rBad : x.level === "warn" ? r.rWarn : r.rGood}>{x.text}</li>
          ))}
        </ol>
      ) : graded ? <p className={r.noReasons}>No facts read yet.</p> : <span />}
    </section>
  );
}
export const Verdict = memo(VerdictImpl);

/* ---------------- figures: one row of key numbers ---------------- */

type FiguresProps = {
  state: AnalyticsState;
  fallback?: Fallback | null;
  /** the page's own market numbers (MCap with the 1 h change, 24 h volume, holder count, the curve) */
  mcap: MarketItem;
  vol: MarketItem;
  holders: MarketItem;
  curve: MarketItem;
};

function FiguresImpl({ state, fallback, mcap, vol, holders, curve }: FiguresProps) {
  const a = state.a;
  const b = a?.bundle.data ?? null;
  const top = topTen(a, fallback);
  const dev = devPct(a, fallback);
  const sup = a?.supply.data ?? null;
  const day = a?.volume.data?.windows.find((w) => w.label === "24h") ?? null;
  const realPct = day && day.volumeEth > 0 ? (day.realEth / day.volumeEth) * 100 : null;
  // red only with a sample behind it (the same minimum as the grade's volume reasons)
  const volChecked = !!day && day.trades - day.unknownTrades >= RULES.MIN_VOL_TRADES;
  const cells: (MarketItem & { bad?: boolean })[] = [
    mcap,
    { ...vol, sub: realPct !== null ? `${pct(realPct)} real` : vol.sub, bad: volChecked && realPct !== null && realPct < 70, title: vol.title ?? "24 h volume; real = minus wash and known-bot trades" },
    {
      ...holders,
      sub: top ? `top 10: ${pct(top.total)}` : holders.sub,
      bad: !!top && (sup?.holders ?? 10) >= 10 && top.total >= 60,
      title: top?.src === "vibe" ? "Top 10 holders, from vibe/vibe's holder list" : "Top 10 holders' share of total supply",
    },
    {
      label: "Dev holds", value: dev === null ? "—" : pct(dev),
      sub: sup?.devSells == null ? (dev === null ? undefined : "of supply") : sup.devSells > 0 ? `sold ${plural(sup.devSells, "time")}` : "never sold",
      bad: !!sup?.devSells || (dev !== null && dev >= 10),
      title: "The creator's bag, % of total supply",
    },
    {
      label: "Bundled", value: b ? pct(b.boughtPct) : "—", sub: b ? "of supply" : undefined,
      bad: !!b && b.boughtPct >= 10,
      title: "Supply bought by wallets in the same tx or block, first 100 buys",
    },
    curve,
  ];
  return (
    <dl className={r.figs} aria-label="Key figures">
      {cells.map((c) => (
        <div key={c.label} className={`${r.fig} ${c.bad ? r.fBad : ""}`} title={c.title}>
          <dt className={r.lab}>{c.label}</dt>
          <dd className={`${r.fv} ${c.value === "—" ? r.dim : ""}`}>{c.value}</dd>
          <dd className={r.fsub}>{c.sub ?? " "}</dd>
        </div>
      ))}
    </dl>
  );
}
export const Figures = memo(FiguresImpl);

/* ---------------- charts ---------------- */

type Seg = { key: string; w: number; cls: string; title?: string };
/** one 10 px bar of segments (widths in %, of 100) */
function Stack({ segs, label }: { segs: Seg[]; label: string }) {
  return (
    <div className={r.stack} role="img" aria-label={label}>
      {segs.filter((s) => s.w > 0).map((s) => (
        <i key={s.key} className={s.cls} style={{ flexGrow: s.w }} title={s.title} />
      ))}
    </div>
  );
}
function Legend({ items }: { items: { cls: string; text: ReactNode }[] }) {
  return (
    <ul className={r.legend}>
      {items.map((x, i) => (
        <li key={i}><i className={x.cls} aria-hidden />{x.text}</li>
      ))}
    </ul>
  );
}
/** the read is on its way: one quiet shimmer bar, no caption (the verdict says "Reading the chain…" once) */
const Wait = () => <div className={`${r.wait} ${shimmer}`} aria-hidden />;

/** The dev's other launches: how many, how many graduated, how many the dev dumped, the last three. */
function TrackRecordView({ track, loading, creator }: { track: TrackRecord | null; loading: boolean; creator: string | null }) {
  const now = useNow(600_000);
  if (!creator) return <p className={r.say}>Creator unknown.</p>;
  if (!track) return loading ? <Wait /> : <p className={r.say}>Dev history unknown right now.</p>;
  const t = track;
  const recent = t.recent.slice(0, 3);
  const sold = recent.some((l) => l.soldPct !== null);
  return (
    <div className={r.track}>
      <dl className={r.trackNums}>
        <div><dt className={r.lab}>Other launches</dt><dd>{fmtInt(t.others)}{t.more ? "+" : ""}</dd></div>
        <div><dt className={r.lab}>Graduated</dt><dd className={t.graduated === 0 && t.others >= 3 ? r.bad : undefined}>{fmtInt(t.graduated)}</dd></div>
        <div title="Launches where the dev sold half or more of his bag">
          <dt className={r.lab}>Dumped</dt>
          <dd className={t.dumped ? r.bad : t.dumped === null ? r.dim : undefined}>{t.dumped === null ? "—" : <>{fmtInt(t.dumped)}<small> / {fmtInt(t.dumpChecked)}</small></>}</dd>
        </div>
      </dl>
      {t.others > 0 && recent.length > 0 && (
        <ul className={`${r.trackList} ${sold ? "" : r.noSold}`}>
          {recent.map((l) => (
            <li key={l.token}>
              <Link href={`/line/${l.token}`} prefetch={false} className={r.tkr}>${l.symbol || "?"}</Link>
              <span className={r.dim}>{now !== null && l.createdAt ? fmtAge(now - l.createdAt) : ""}</span>
              <span>{l.graduated ? "Graduated" : `${(l.progressBps / 100).toFixed(0)}% curve`}</span>
              {sold && <span className={l.soldPct !== null && l.soldPct >= 50 ? r.bad : r.dim}>{l.soldPct === null ? "—" : l.soldPct < 0.5 ? "dev held" : `dev sold ${pct(l.soldPct)}`}</span>}
            </li>
          ))}
        </ul>
      )}
      <Link className={r.passLink} href={`/w/${creator}#launches`} prefetch={false}>All launches by this dev →</Link>
    </div>
  );
}

/* ---------------- sections ---------------- */

// One section = a title, one short line, one chart. Its headline number lives in the figures row.
function Section({ id, title, say, chart }: { id: SecId; title: string; say: ReactNode; chart: ReactNode }) {
  return (
    <section id={id} className={r.sec} aria-labelledby={`${id}-h`}>
      <div className={r.secText}>
        <h2 id={`${id}-h`} className={r.lab}>{title}</h2>
        {say ? <p className={r.say}>{say}</p> : null}
      </div>
      <div className={r.chart}>{chart}</div>
    </section>
  );
}

type SectionsProps = {
  state: AnalyticsState;
  creator: string | null;
  unit?: string;
  fallback?: Fallback | null;
  /** every full card, under one "All details" fold at the end */
  details?: ReactNode;
  passport?: PassportState;
  token?: string | null;
};

function SectionsImpl({ state, creator, unit: unitIn = "ETH", fallback, details, passport, token = null }: SectionsProps) {
  const a = state.a;
  const loading = state.trouble === "loading";
  // the verdict says it once ("Reading the chain…", or the failed line with "Try again"): sections stay quiet
  const quiet = (reason: string | null | undefined) => (loading ? null : state.trouble === "failed" ? "—" : reason || "Not enough data yet.");
  // every "Eth" amount of the answer is in its own unit (a v6 line paired with a token: that token)
  const unit = a?.unit?.symbol ?? unitIn;
  const c = creator?.toLowerCase() ?? null;
  const unknownBar = loading ? <Wait /> : <Stack segs={[]} label="Unknown" />;

  /* -- dev -- */
  const sup = a?.supply.data ?? null;
  const dev = devPct(a, fallback);
  const devSay = sup?.devSells != null
    ? sup.devSells === 0 && !sup.devMovedTo
      ? "Hasn't sold or moved a token."
      : `Sold ${plural(sup.devSells, "time")}${sup.devMovedTo ? `, moved tokens to ${plural(sup.devMovedTo, "wallet")}` : ""}.`
    : dev !== null ? "Sells not read yet." : quiet(a?.supply.reason);
  const track = trackRecord(passport?.p ?? null, token);

  /* -- holders -- */
  const top = topTen(a, fallback);
  const pool = a?.graduated ? "pool" : "curve";
  let holdSay: ReactNode = quiet(a?.supply.reason);
  let holdChart: ReactNode = unknownBar;
  if (sup) {
    const clustered = sup.top10.filter((x) => x.flags.includes("cluster")).length;
    holdSay = clustered >= 2
      ? `${clustered} of the top 10 share one funder.`
      : sup.freshTop10
        ? `${plural(sup.freshTop10, "top-10 holder")} ${sup.freshTop10 === 1 ? "is a" : "are"} fresh wallet${sup.freshTop10 === 1 ? "" : "s"}.`
        : `${pct(sup.marketPct)} still in the ${pool}.`;
    const flagged = (f: string[]) => f.some((x) => x === "cluster" || x === "fresh" || x === "sniper" || x === "farm");
    const segs: Seg[] = sup.top10.map((row, i) => ({
      key: row.wallet, w: row.pct,
      cls: row.flags.includes("creator") ? r.sDev : flagged(row.flags) ? r.sFlag : i % 2 ? r.sTop2 : r.sTop,
      title: `#${i + 1} ${shortAddr(row.wallet)} · ${pct(row.pct)}${row.flags.length ? ` · ${row.flags.join(", ")}` : ""}`,
    }));
    const rest = Math.max(0, sup.circulatingPct - sup.top10Pct);
    segs.push({ key: "rest", w: rest, cls: r.sRest, title: `Everyone else · ${pct(rest)}` });
    segs.push({ key: "mkt", w: sup.marketPct, cls: r.sMkt, title: `${a?.graduated ? "Pool" : "Curve"} · ${pct(sup.marketPct)}` });
    const flaggedPct = sup.top10.filter((x) => !x.flags.includes("creator") && flagged(x.flags)).reduce((s, x) => s + x.pct, 0);
    const devTop = sup.top10.filter((x) => x.flags.includes("creator")).reduce((s, x) => s + x.pct, 0);
    holdChart = (
      <>
        <Stack segs={segs} label={`Top 10 hold ${pct(sup.top10Pct)} of supply, everyone else ${pct(rest)}, the ${pool} ${pct(sup.marketPct)}`} />
        <Legend items={[
          ...(sup.top10Pct - flaggedPct - devTop > 0.05 ? [{ cls: r.sTop, text: <>top 10 <b>{pct(sup.top10Pct - flaggedPct - devTop)}</b></> }] : []),
          ...(flaggedPct > 0 ? [{ cls: r.sFlag, text: <>flagged <b>{pct(flaggedPct)}</b></> }] : []),
          ...(devTop > 0 ? [{ cls: r.sDev, text: <>dev <b>{pct(devTop)}</b></> }] : []),
          { cls: r.sRest, text: <>everyone else <b>{pct(rest)}</b></> },
          { cls: r.sMkt, text: <>{pool} <b>{pct(sup.marketPct)}</b></> },
        ]} />
      </>
    );
  } else if (fallback && top) {
    holdSay = "From vibe/vibe's holder list.";
    const segs: Seg[] = fallback.holders.slice(0, 10).map((h, i) => ({ key: h.wallet, w: h.pct ?? 0, cls: h.isCreator ? r.sDev : i % 2 ? r.sTop2 : r.sTop, title: `#${i + 1} ${shortAddr(h.wallet)} · ${pct(h.pct)}` }));
    const rest = fallback.holders.slice(10).reduce((s, h) => s + (h.pct ?? 0), 0);
    if (rest > 0) segs.push({ key: "rest", w: rest, cls: r.sRest });
    const other = fallback.complete ? Math.max(0, 100 - top.total - rest) : null;
    if (other) segs.push({ key: "mkt", w: other, cls: r.sMkt });
    holdChart = (
      <>
        <Stack segs={segs} label={`Top 10 hold ${pct(top.total)} of supply`} />
        <Legend items={[
          { cls: r.sTop, text: <>top 10 <b>{pct(top.total)}</b></> },
          ...(dev ? [{ cls: r.sDev, text: <>dev <b>{pct(dev)}</b></> }] : []),
          ...(rest > 0 ? [{ cls: r.sRest, text: <>everyone else <b>{pct(rest)}</b></> }] : []),
          ...(other ? [{ cls: r.sMkt, text: <>curve &amp; not held <b>{pct(other)}</b></> }] : []),
        ]} />
      </>
    );
  }

  /* -- volume -- */
  const vol = a?.volume.data ?? null;
  const day = vol?.windows.find((w) => w.label === "24h") ?? null;
  const volSay = day
    ? `${fmtInt(day.buys)} buys · ${fmtInt(day.sells)} sells · ${plural(day.buyers, "buyer")} in 24h.`
    : fallback?.vol24 ? "From vibe/vibe's own count." : quiet(a?.volume.reason);
  const volChart = vol ? (
    <>
      <ul className={r.rows}>
        {vol.windows.map((w) => {
          const v = w.volumeEth;
          const bot = Math.max(0, w.botEth ?? 0);
          return (
            <li key={w.label}>
              <span className={r.lab}>{w.label}</span>
              <Stack label={`${w.label}: ${fmtEth(w.realEth)} real of ${fmtEth(v)} ${unit}`} segs={v > 0 ? [
                { key: "real", w: (w.realEth / v) * 100, cls: r.sReal, title: `Real ${fmtEth(w.realEth)} ${unit}` },
                { key: "wash", w: (w.washEth / v) * 100, cls: r.sWash, title: `Wash ${fmtEth(w.washEth)} ${unit}` },
                { key: "bot", w: (bot / v) * 100, cls: r.sBot, title: `Bots ${fmtEth(bot)} ${unit}` },
              ] : []} />
              <span className={r.rv}>{fmtEth(v)} <small>{unit}</small></span>
            </li>
          );
        })}
      </ul>
      <Legend items={[{ cls: r.sReal, text: "real" }, { cls: r.sWash, text: "wash" }, { cls: r.sBot, text: "known bots" }]} />
    </>
  ) : unknownBar;

  /* -- profit / exit pressure -- */
  const ex = a?.exitMath.data ?? null;
  const exSay = ex && ex.exactCost + ex.estimatedCost === 0
    ? "Cost unknown for every holder."
    : ex && ex.profitHolders === 0
      ? "No holder is in profit."
      : ex
        ? `${ex.profitSupplyPct !== null ? `${pct(ex.profitSupplyPct)} of supply` : plural(ex.profitHolders, "holder")} in profit${ex.dumpPricePct !== null ? ` · if sold: price ${pct(ex.dumpPricePct)}` : ""}.`
        : quiet(a?.exitMath.reason);
  const BUCKET: Record<string, string> = { loss: r.sLoss, x1: r.sX1, x2: r.sX2, x3: r.sX3 };
  const exChart = ex ? (
    <>
      <Stack label="Line by profit multiple" segs={ex.buckets.map((k2) => ({ key: k2.id, w: k2.linePct, cls: BUCKET[k2.id], title: `${k2.label}: ${plural(k2.holders, "holder")}, ${pct(k2.linePct)} of the line's tokens` }))} />
      <Legend items={ex.buckets.map((k2) => ({ cls: BUCKET[k2.id], text: <>{k2.label} <b>{pct(k2.linePct)}</b></> }))} />
    </>
  ) : unknownBar;

  return (
    <div className={r.sections}>
      <Section id="dev" title="Dev" say={devSay} chart={<TrackRecordView track={track} loading={!!passport?.loading} creator={c} />} />
      <Section id="holders" title="Holders" say={holdSay} chart={holdChart} />
      <Section id="volume" title="Volume" say={volSay} chart={volChart} />
      <Section id="exit" title="Profit" say={exSay} chart={exChart} />
      {details && !loading && (
        <details className={r.more}>
          <summary>All details</summary>
          <div className={r.moreBody}>{details}</div>
        </details>
      )}
    </div>
  );
}
export const ReportSections = memo(SectionsImpl);
