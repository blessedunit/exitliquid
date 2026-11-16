"use client";
// One screener row (Rankings): grade badge, token, verdict word, the reasons as plain facts with a coloured dot,
// the score, holders, market cap and 24h volume. The whole row opens the report.
import Link from "next/link";
import TokenAvatar from "@/components/TokenAvatar";
import { fmtCompact } from "@/lib/format";
import { VERDICT_LABEL, type ScreenerRow } from "@/lib/screener-types";
import { GradeBadge, levelTone, toneClass, VerdictWord, type Tone } from "./Grade";
import { shimmer } from "@/components/ui/Loader";
import s from "./screener.module.css";

export type Metric = { value: string; sub?: string; tone?: Tone };

function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a < 1) return a === 0 ? "$0" : "<$1";
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `$${v.toFixed(0)}`;
}

/** USD when the pair is ETH; otherwise the amount in the pair's own unit (unit returned apart); "—" when unknown */
function money(r: ScreenerRow, k: "mcap" | "vol"): { v: string; unit: string | null } {
  const m = r.metrics;
  const v = k === "mcap" ? m.mcap : m.vol24h;
  if (v !== null && v !== undefined) return { v: usd(v), unit: null };
  const p = k === "mcap" ? m.mcapPair : m.vol24hPair;
  if (p === null || p === undefined || !Number.isFinite(p)) return { v: "—", unit: null };
  return { v: fmtCompact(p), unit: m.pairUnit ?? null };
}

function Money({ r, k }: { r: ScreenerRow; k: "mcap" | "vol" }) {
  const { v, unit } = money(r, k);
  return (
    <>
      <b title={unit ? `${v} ${unit}` : undefined}>{v}</b>
      {unit && <small>{unit.slice(0, 8)}</small>}
    </>
  );
}

const age = (m: number | null) => (m === null ? null : m < 60 ? `${Math.max(1, Math.round(m))}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`);

export function Row({ r, rank, metric }: { r: ScreenerRow; rank: number; metric: Metric }) {
  const why = r.reasons.slice(0, 3);
  const a = age(r.ageMin);
  const ticker = `$${(r.ticker || "???").replace(/^\$/, "")}`;
  return (
    <Link href={`/line/${r.token}`} prefetch={false} className={`${s.row} ${s.wide}`} role="row" aria-label={`${ticker}: ${r.grade ? `grade ${r.grade}` : VERDICT_LABEL.unknown}. ${why.map((x) => x.text).join(". ")}`}>
      <span className={s.cRank} role="cell">{rank}</span>
      <span className={s.cGrade} role="cell">
        <GradeBadge grade={r.grade} />
      </span>
      <span className={s.cTok} role="cell">
        <TokenAvatar src={r.image} symbol={r.ticker} size={28} />
        <span className={s.names}>
          <span className={s.tickLine}>
            <b className={s.tick}>{ticker}</b>
            <VerdictWord verdict={r.verdict} />
          </span>
          <span className={s.name}>
            {r.name}
            {a ? ` · ${a}` : ""}
            {r.graduated ? " · graduated" : ""}
          </span>
        </span>
      </span>
      <span className={s.cWhy} role="cell">
        {why.length ? (
          why.map((x) => (
            <span key={x.id} className={`${s.reason} ${toneClass(levelTone(x.level))}`}>
              <i aria-hidden />
              <span>{x.text}</span>
            </span>
          ))
        ) : (
          // not graded: the verdict word next to the ticker already says so
          r.verdict !== "unknown" && <span className={s.reasonNone}>No flags</span>
        )}
      </span>
      <span className={`${s.cMetric} ${metric.tone ? toneClass(metric.tone) : ""}`} role="cell">
        <b>{metric.value}</b>
        {metric.sub && <small>{metric.sub}</small>}
      </span>
      <span className={`${s.cNum} ${s.cHold}`} role="cell">
        {r.metrics.holders === null ? "—" : r.metrics.holders.toLocaleString("en-US")}
      </span>
      <span className={`${s.cNum} ${s.cMc}`} role="cell">
        <Money r={r} k="mcap" />
      </span>
      <span className={`${s.cNum} ${s.cVol}`} role="cell">
        <Money r={r} k="vol" />
      </span>
    </Link>
  );
}

export function RowSkeleton() {
  return (
    <div className={`${s.row} ${s.wide} ${s.skel}`} aria-hidden>
      <span className={s.cRank} />
      <span className={s.cGrade}>
        <span className={`${s.skBadge} ${shimmer}`} />
      </span>
      <span className={s.cTok}>
        <span className={`${s.skAv} ${shimmer}`} />
        <span className={s.names}>
          <span className={`${s.skBar} ${shimmer}`} style={{ width: 72 }} />
          <span className={`${s.skBar} ${shimmer}`} style={{ width: 120, height: 8 }} />
        </span>
      </span>
      <span className={s.cWhy}>
        <span className={`${s.skBar} ${shimmer}`} style={{ width: "70%", height: 8 }} />
      </span>
      <span className={s.cMetric} />
      <span className={`${s.cNum} ${s.cHold}`} />
      <span className={`${s.cNum} ${s.cMc}`}>
        <span className={`${s.skBar} ${shimmer}`} style={{ width: 44, marginLeft: "auto" }} />
      </span>
      <span className={`${s.cNum} ${s.cVol}`}>
        <span className={`${s.skBar} ${shimmer}`} style={{ width: 44, marginLeft: "auto" }} />
      </span>
    </div>
  );
}
