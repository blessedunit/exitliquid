"use client";
// The token page's answer at the top: the Line Health letter, one reading line (lib/analytics/summary), six KPIs
// and the signal chips in words. No panel, no cell borders: the grade square is the only outlined element (spec 3.2).
// One KPI set for every line (with or without analytics). Unknown is "—" with a title, never 0.
// Signals, not verdicts: a chip is a reason to look closer; a click scrolls to the block that explains it.
import { memo, useState, type ReactNode } from "react";
import Term from "@/components/ui/Term";
import type { GlossaryId } from "@/lib/glossary";
import type { Chip } from "@/lib/analytics/types";
import { summaryLine } from "@/lib/analytics/summary";
import { fmtEth, fmtInt } from "@/lib/format";
import { ageShort, jumpTo, useNow, type AnalyticsState } from "./useTokenAnalytics";
import s from "./summary.module.css";

export type SummaryKpis = {
  mcapEth: number | null;
  mcapTitle?: string;
  change1hBps: number | null;
  vol24Eth: number | null;
  /** "vibe" = vibe/vibe's own 24 h figure (the tape didn't cover the day) */
  vol24Src: "tape" | "vibe" | null;
  /** real share of 24 h volume (wash and bots out), % ; null = unknown */
  realPct: number | null;
  buys1h: number | null;
  sells1h: number | null;
  bsTitle?: string;
  holders: number | null;
  /** where the holders count comes from: the chain (same as the Supply card) or vibe/vibe */
  holdersSrc?: "chain" | "vibe" | null;
  inLine: number | null;
  /** curve progress 0-100; null = unknown */
  gradPct: number | null;
  graduated: boolean;
  targetEth: number;
  etaHours: number | null;
  etaStalled: boolean;
};

const UNKNOWN = "Unknown, not zero.";
/** chips shown before "+N" (spec 1.6) */
const CHIPS_SHOWN = 3;
const TONE: Record<Chip["level"], string> = { high: s.high, mid: s.mid, low: s.low, info: s.info };
const LEVEL_TEXT: Record<Chip["level"], string> = { high: "strong signal", mid: "signal", low: "weak signal", info: "info" };
const GRADE_TONE: Record<string, string> = { A: s.gGood, B: s.gGood, C: s.gMid, D: s.gBad, F: s.gBad };

/** the board's ETA wording: ~<1h, ~6h, ~3d, ~30d+ */
export function etaText(h: number): string {
  if (h < 1) return "~<1h";
  if (h < 48) return `~${Math.round(h)}h`;
  if (h < 24 * 30) return `~${Math.round(h / 24)}d`;
  return "~30d+";
}
/** price change in bps as the board prints it (under 0.05% is flat, never a red "-0.0%") */
function chgText(bps: number): string {
  if (Math.abs(bps) < 5) return "0.0%";
  const a = Math.abs(bps / 100);
  const body = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(1);
  return `${bps > 0 ? "+" : "−"}${body}%`;
}

const Dash = ({ why = UNKNOWN }: { why?: string }) => <span className={s.dim} title={why}>—</span>;

function Kpi({ label, term, title, sub, children }: { label: string; term?: GlossaryId; title?: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.kpi} title={title}>
      {/* a column label: the glossary underline shows only on hover / focus (spec: labels must not read as links) */}
      <dt>{term ? <Term id={term} className={s.labelTerm}>{label}</Term> : label}</dt>
      <dd>{children}</dd>
      {sub ? <dd className={s.sub}>{sub}</dd> : null}
    </div>
  );
}

type Props = {
  /** null: this line has no analytics (/exit before launch): KPIs only */
  state: AnalyticsState | null;
  kpis: SummaryKpis;
  /** live line data is late (rate-limited or not answering): said in the meta line, never a loud plate */
  retrying?: boolean;
};

function SummaryBar({ state, kpis: k, retrying = false }: Props) {
  const now = useNow(10_000);
  const [allChips, setAllChips] = useState(false);
  const a = state?.a ?? null;
  const h = a?.health ?? null;
  const chips = a ? a.chips.filter((c) => !c.quiet) : [];
  const shown = allChips ? chips : chips.slice(0, CHIPS_SHOWN);
  const age = a && now !== null ? ageShort(Math.max(0, now - a.computedAt)) : null;
  const grad = k.graduated || (k.gradPct !== null && k.gradPct >= 100);
  const busy = retrying || (!!state && (state.trouble === "rate" || state.trouble === "down"));

  return (
    <section className={s.bar} aria-label="Summary">
      {state && (
        <div className={s.top}>
          {h ? (
            <button
              type="button"
              className={`${s.grade} ${GRADE_TONE[h.grade] ?? ""}`}
              onClick={() => jumpTo("health-title")}
              title={`Line health ${h.grade}, ${h.score}/100${h.high ? `. ${h.high} high-severity reason${h.high === 1 ? "" : "s"} caps the grade at C` : ""}${h.partial ? ". Partial: some inputs couldn't be read" : ""}. Show the reasons.`}
              aria-label={`Line health ${h.grade}, ${h.score} of 100. Show the reasons.`}
            >
              <b aria-hidden>{h.grade}</b>
            </button>
          ) : (
            <span className={`${s.grade} ${s.gNone} ${state.trouble === "loading" ? s.pulse : ""}`} title={state.trouble === "loading" ? "Reading the first buyers…" : "Line health unknown right now. Unknown, not clean."}>
              <b aria-hidden>{state.trouble === "loading" ? "" : "?"}</b>
            </span>
          )}
          <div className={s.read}>
            <p className={s.line} role="status">{summaryLine(state)}</p>
            <p className={s.meta}>
              {h && <span className={s.score}>{h.score}/100{h.partial && <> · <Term id="partial">partial</Term></>}</span>}
              <span>Signals, not verdicts</span>
              {busy ? (
                <span className={s.retry} role="status">Retrying…</span>
              ) : a ? (
                <span>chain{age !== null && <> · {state.stale ? <b className={s.stale}>stale {age}</b> : `${age} ago`}</>}</span>
              ) : null}
              <span><Term id="health">How it&apos;s graded</Term></span>
            </p>
          </div>
        </div>
      )}

      <dl className={s.kpis}>
        <Kpi label="MCAP" title={k.mcapTitle}>{k.mcapEth === null ? <Dash why={k.mcapTitle ?? UNKNOWN} /> : <>{fmtEth(k.mcapEth)}<span className={s.unit}> ETH</span></>}</Kpi>
        <Kpi label="1H" title={k.change1hBps === null ? "vibe/vibe didn't report a 1h price change" : "Price change over the last hour (vibe/vibe)"}>
          {k.change1hBps === null ? <Dash /> : <span className={Math.abs(k.change1hBps) < 5 ? undefined : k.change1hBps > 0 ? s.up : s.down}>{chgText(k.change1hBps)}</span>}
        </Kpi>
        <Kpi
          label="Vol 24H"
          title={k.vol24Src === "vibe" ? "24 h volume in ETH, as vibe/vibe counts it" : "24 h volume in ETH"}
          sub={k.vol24Eth !== null && k.realPct !== null ? <Term id="real-volume" className={s.subTerm}>{Math.round(k.realPct)}% real</Term> : k.vol24Eth !== null && k.vol24Src === "vibe" ? "as vibe/vibe counts it" : null}
        >
          {k.vol24Eth === null ? <Dash /> : <>{fmtEth(k.vol24Eth)}<span className={s.unit}> ETH</span></>}
        </Kpi>
        <Kpi label="B / S 1H" term="b-s" title={k.bsTitle}>
          {k.buys1h === null || k.sells1h === null ? <Dash /> : <>{fmtInt(k.buys1h)}<span className={s.dim}> / </span>{fmtInt(k.sells1h)}</>}
        </Kpi>
        <Kpi
          label="Holders"
          title={`Holders: every wallet holding the token${k.holdersSrc === "vibe" ? ", as vibe/vibe counts it" : ", read from the chain"}. In line: wallets that bought 0.0003 ETH+ and still hold. Bags that came by transfer hold but have no place.`}
          sub={k.inLine !== null ? <Term id="line" className={s.subTerm}>{fmtInt(k.inLine)} in line</Term> : null}
        >
          {k.holders === null ? <Dash /> : fmtInt(k.holders)}
        </Kpi>
        <Kpi
          label="To grad"
          term="to-grad"
          title={k.gradPct === null ? UNKNOWN : `Curve ${k.gradPct.toFixed(1)}% of ${k.targetEth} ETH. At 100% trading moves to the V4 pool.`}
          sub={!grad && k.gradPct !== null ? (k.etaHours !== null ? <Term id="eta" className={s.subTerm}>ETA {etaText(k.etaHours)}</Term> : k.etaStalled ? <Term id="stalled" className={s.subTerm}>Stalled</Term> : null) : grad ? "trading on the V4 pool" : null}
        >
          {grad ? (
            <span className={s.up}>Graduated</span>
          ) : k.gradPct === null ? (
            <Dash />
          ) : (
            <span className={s.grad}>
              {k.gradPct.toFixed(1)}%
              <span className={s.track} aria-hidden><i style={{ width: `${Math.min(100, Math.max(0, k.gradPct))}%` }} /></span>
            </span>
          )}
        </Kpi>
      </dl>

      {state && (
        a ? (
          chips.length > 0 && (
            <div className={s.chips} role="group" aria-label="Signals">
              {shown.map((c, i) => (
                <button
                  key={`${c.id}-${i}`}
                  type="button"
                  className={`${s.chip} ${TONE[c.level]}`}
                  title={c.hint}
                  aria-label={`${c.label}: ${c.hint} (${LEVEL_TEXT[c.level]}). Show details.`}
                  onClick={() => jumpTo(c.target)}
                >
                  {c.label}
                </button>
              ))}
              {chips.length > CHIPS_SHOWN && (
                <button type="button" className={s.moreChips} onClick={() => setAllChips((v) => !v)} aria-expanded={allChips}>
                  {allChips ? "Less" : `+${chips.length - CHIPS_SHOWN}`}
                </button>
              )}
            </div>
          )
        ) : state.trouble === "loading" ? (
          <div className={s.chips} aria-hidden><i className={s.ghost} /><i className={s.ghost} /><i className={s.ghost} /></div>
        ) : null
      )}
    </section>
  );
}

// re-renders when its inputs change, not on every queue poll of the page around it
export default memo(SummaryBar);
