"use client";

// State of vibe: the board. Data comes from /api/state (one snapshot, rebuilt every ~15 min on the server).
// Layout: head (H1, computed lead, snapshot stamp) → 4 KPIs → sticky section tabs → paired blocks → full-width tables → method.
// No boxes: every block is a title + a meta line (what, source, time) on the page background, separated by hairlines.
// Unknown is "—" with a reason, never 0.
import Link from "next/link";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { DayRow, DevRow, DoorRow, Src, StateSnapshot, VolRow } from "@/lib/state";
import { fmtCompact, fmtEth, fmtInt, shortAddr } from "@/lib/format";
import { fmtDur, fmtShare, stateHeadline } from "./headline";
import PageHead from "@/components/PageHead";
import SectionTabs from "@/components/ui/SectionTabs";
import ShowMore from "@/components/ui/ShowMore";
import Term from "@/components/ui/Term";
import type { GlossaryId } from "@/lib/glossary";
import s from "./state.module.css";

const FRESH_MS = 15 * 60_000;
const STALE_MIN = 40; // the snapshot is rebuilt every ~15 min: older than this is worth saying
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UNKNOWN = "Unknown, not zero.";

const SECTIONS = [
  { id: "activity", label: "Activity" },
  { id: "graduation", label: "Graduation" },
  { id: "snipers", label: "Snipers" },
  { id: "devs", label: "Top devs" },
  { id: "after", label: "After graduation" },
  { id: "volume", label: "Volume" },
  { id: "method", label: "Method" },
];

/* ------------------------------------------------------------------ formatting */

const utcDay = (ts: number) => {
  const d = new Date(ts * 1000);
  return { wd: WD[d.getUTCDay()], md: `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` };
};
const utcTime = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
};
const utcStamp = (ts: number) => `${utcDay(ts).md} · ${utcTime(ts)}`;

function fmtRet(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const p = x * 100;
  if (Math.abs(p) < 0.05) return "0%";
  const sign = p > 0 ? "+" : "−";
  const a = Math.abs(p);
  return `${sign}${a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`;
}
const retClass = (x: number | null | undefined) => (x === null || x === undefined || Math.abs(x) < 0.0005 ? "" : x > 0 ? s.up : s.down);

const ago = (ts: number, now: number) => fmtDur(Math.max(0, now - ts));

/* ------------------------------------------------------------------ pieces */

// The snapshot time is said once, in the page head. A block names only its source, and adds a time
// only when that source answered much earlier than the snapshot (or not at all).
const SnapAt = createContext<number | null>(null);

function srcLine(src: Src, builtAt: number | null): string {
  const name = src.src.toLowerCase();
  if (!src.asOf) return `${name} · no answer`;
  if (builtAt !== null && builtAt - src.asOf > STALE_MIN * 60) return `${name} · as of ${utcStamp(src.asOf)}`;
  return name;
}

function Panel({
  id,
  title,
  term,
  meta,
  src,
  wide,
  children,
  aside,
}: {
  id?: string;
  title: string;
  term?: GlossaryId;
  meta?: string;
  src?: Src;
  wide?: boolean;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const builtAt = useContext(SnapAt);
  return (
    <section id={id} className={`${s.card} ${wide ? s.wide : ""}`} aria-labelledby={id ? `${id}-h` : undefined}>
      <header className={s.head}>
        <h3 id={id ? `${id}-h` : undefined}>
          {title}
          {term && <Term id={term} icon />}
        </h3>
        {aside}
      </header>
      {(meta || src) && (
        <p className={s.headMeta}>
          {[meta, src ? srcLine(src, builtAt) : null].filter(Boolean).join(" · ")}
        </p>
      )}
      <div className={s.body}>{children}</div>
    </section>
  );
}

function Unknown({ why }: { why: string }) {
  return (
    <p className={s.unknown}>
      <b title={UNKNOWN}>—</b> {why}
    </p>
  );
}

function Kpi({ label, value, sub, tone }: { label: React.ReactNode; value: string; sub?: React.ReactNode; tone?: "exit" }) {
  return (
    <div className={s.kpi}>
      <span className={s.kLabel}>{label}</span>
      <b className={`${s.kValue} ${tone === "exit" ? s.tExit : ""}`} title={value === "—" ? UNKNOWN : undefined}>{value}</b>
      {sub && <span className={s.kSub}>{sub}</span>}
    </div>
  );
}

/** 7 columns, LED-segment bars, curve + taxed stacked; today dimmed (counted so far). */
function DayBars({ days, pick, unit }: { days: DayRow[]; pick: (d: DayRow) => { curve: number; taxed: number } | null; unit: string }) {
  const vals = days.map(pick);
  const max = Math.max(1, ...vals.map((v) => (v ? v.curve + v.taxed : 0)));
  const anyTaxed = vals.some((v) => v && v.taxed > 0);
  return (
    <>
      <div className={s.cols} role="img" aria-label={`${unit} per UTC day, last 7 days`}>
        {days.map((d, i) => {
          const v = vals[i];
          const tot = v ? v.curve + v.taxed : null;
          const { wd, md } = utcDay(d.day);
          return (
            <div key={d.day} className={`${s.col} ${d.partial ? s.partial : ""}`}>
              <span className={s.colVal} title={tot === null ? UNKNOWN : undefined}>{tot === null ? "—" : fmtCompact(tot)}</span>
              <div className={s.colTrack}>
                {v && (
                  <div className={s.colStack} style={{ height: `${Math.max(tot ? 2 : 0, ((tot ?? 0) / max) * 100)}%` }}>
                    {v.taxed > 0 && <i className={s.segTaxed} style={{ flexGrow: v.taxed }} title={`taxed v6: ${fmtInt(v.taxed)}`} />}
                    {v.curve > 0 && <i className={s.segCurve} style={{ flexGrow: v.curve }} title={`curve: ${fmtInt(v.curve)}`} />}
                  </div>
                )}
              </div>
              <span className={s.colDay}>
                {d.partial ? "Today" : wd}
                <small>{md}</small>
              </span>
            </div>
          );
        })}
      </div>
      <div className={s.legend}>
        <span><i className={s.segCurve} /> Curve</span>
        {anyTaxed && <span><i className={s.segTaxed} /> Taxed v6</span>}
        <span><i className={s.segToday} /> Today, so far</span>
      </div>
    </>
  );
}

/** horizontal bars with counts and shares */
type Tone = "exit" | "down" | "warn" | "mute";
const FILL: Record<Tone, string> = { exit: "", down: s.fDown, warn: s.fWarn, mute: s.fMute };

function HBars({ rows, total, tone }: { rows: { label: string; n: number | null; tone?: Tone }[]; total?: number | null; tone?: Tone }) {
  const sum = total ?? rows.reduce((a, r) => a + (r.n ?? 0), 0);
  const max = Math.max(1, ...rows.map((r) => r.n ?? 0));
  return (
    <ul className={s.hbars}>
      {rows.map((r) => (
        <li key={r.label}>
          <span className={s.hLabel}>{r.label}</span>
          <span className={s.hTrack}>
            {r.n !== null && <i className={`${s.hFill} ${FILL[r.tone ?? tone ?? "exit"]}`} style={{ width: `${r.n > 0 ? Math.max(1.5, (r.n / max) * 100) : 0}%` }} />}
          </span>
          <span className={s.hNum} title={r.n === null ? UNKNOWN : undefined}>{r.n === null ? "—" : fmtInt(r.n)}</span>
          <span className={s.hPct}>{r.n === null || !sum ? "" : fmtShare(r.n / sum)}</span>
        </li>
      ))}
    </ul>
  );
}

function Big({ value, tone, children }: { value: string; tone?: "down" | "exit"; children: React.ReactNode }) {
  return (
    <div className={s.big}>
      <b className={tone === "down" ? s.tDown : tone === "exit" ? s.tExit : ""} title={value === "—" ? UNKNOWN : undefined}>{value}</b>
      <span>{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ panels */

function Launches({ d }: { d: StateSnapshot }) {
  return (
    <Panel title="Launches per day" meta="7 UTC days" src={d.daysSrc}>
      {d.days && d.days.some((x) => x.launches) ? (
        <DayBars days={d.days} pick={(x) => x.launches} unit="Launches" />
      ) : (
        <Unknown why="Factory logs did not load this round. Retrying on the next build." />
      )}
    </Panel>
  );
}

function Graduations({ d }: { d: StateSnapshot }) {
  const c = d.totals.cohort;
  const a = d.totals.allTime;
  return (
    <Panel title="Graduations per day" meta="7 UTC days" src={d.daysSrc}>
      {d.days && d.days.some((x) => x.grads) ? (
        <DayBars days={d.days} pick={(x) => x.grads} unit="Graduations" />
      ) : (
        <Unknown why="Graduation logs did not load this round." />
      )}
      <dl className={s.facts}>
        <div>
          <dt>This week&apos;s launches, graduated</dt>
          <dd>{c ? <><span className={s.nw}>{fmtInt(c.graduated)} of {fmtInt(c.launched)}</span> <span className={s.nw}>· <b>{fmtShare(c.launched ? c.graduated / c.launched : null)}</b></span></> : "—"}</dd>
        </div>
        <div>
          <dt>All time, every factory</dt>
          <dd>{a ? <><span className={s.nw}>{fmtInt(a.grads)} of {fmtInt(a.launches)}</span> <span className={s.nw}>· <b>{fmtShare(a.launches ? a.grads / a.launches : null)}</b></span></> : "—"}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function TimeToGrad({ d }: { d: StateSnapshot }) {
  const t = d.ttg;
  return (
    <Panel title="Time to graduation" term="graduation" meta="this week's graduations" src={d.ttgSrc}>
      {t ? (
        <>
          <Big value={fmtDur(t.medianS)}>median, launch to graduation · {fmtInt(t.n)} graduations</Big>
          <HBars rows={t.buckets.map((b) => ({ label: b.label, n: b.n }))} />
          <dl className={s.facts}>
            <div>
              <dt>Middle half</dt>
              <dd>{fmtDur(t.p25S)} – {fmtDur(t.p75S)}</dd>
            </div>
            <div>
              <dt>Fastest</dt>
              <dd>{fmtDur(t.fastestS)}</dd>
            </div>
          </dl>
        </>
      ) : (
        <Unknown why={d.totals.grads7d === 0 ? "No graduations this week." : "Graduation or launch logs are incomplete this round."} />
      )}
    </Panel>
  );
}

function Progress({ d }: { d: StateSnapshot }) {
  const p = d.progress;
  const grad = p?.buckets.find((b) => /grad/i.test(b.label));
  const share = grad && grad.count !== null && p?.total ? grad.count / p.total : null;
  // the API sometimes leaves one bucket uncounted: when every other bucket and the total are known, it is the remainder
  const missing = p ? p.buckets.filter((b) => b.count === null) : [];
  const known = p ? p.buckets.reduce((a, b) => a + (b.count ?? 0), 0) : 0;
  const rest = p && p.total !== null && missing.length === 1 && p.total - known >= 0 ? p.total - known : null;
  const rows = p ? p.buckets.map((b) => (b.count === null && rest !== null ? { ...b, label: `${b.label} ≈`, count: rest, derived: true } : { ...b, derived: false })) : [];
  return (
    <Panel title="How far tokens get" term="to-grad" meta="curve progress, all time" src={d.progressSrc}>
      {p ? (
        <>
          <Big value={fmtShare(share)} tone="exit">
            of {p.total === null ? "—" : fmtInt(p.total)} launches vibe lists have graduated
          </Big>
          <HBars rows={rows.map((b) => ({ label: b.label, n: b.count, tone: /grad/i.test(b.label) ? "exit" : "mute" }))} total={p.total} />
          <p className={s.note}>
            {rows.some((b) => b.derived) ? `${rows.find((b) => b.derived)!.label.replace(" ≈", "")} ≈ the total minus the other buckets: vibe's API didn't count it directly. ` : ""}
            Launches from factories vibe doesn&apos;t list are not in these counts.
          </p>
        </>
      ) : (
        <Unknown why="The vibe API did not answer. Counts come back on the next build." />
      )}
    </Panel>
  );
}

function Snipers({ d }: { d: StateSnapshot }) {
  const x = d.snipers;
  return (
    <Panel id="snipers" title="Snipers at the front" term="snipers" meta="first 20 buyers" src={d.snipersSrc} aside={x?.indexStale ? <span className={s.stale}>Index stale</span> : undefined}>
      {x && x.formed > 0 ? (
        <>
          <Big value={fmtShare(x.withFive / x.formed)} tone="down">of formed lines had 5+ known sniper bots among the first 20 buyers</Big>
          {/* clean lines green, a few snipers neutral, 5+ red */}
          <HBars rows={x.dist.map((r) => ({ label: `${r.label} snipers`, n: r.n, tone: r.label === "0" ? "exit" : r.label === "1–4" ? "mute" : "down" }))} total={x.formed} />
          <dl className={s.facts}>
            <div>
              <dt>Sample</dt>
              <dd>{fmtInt(x.sampled)} launches, {fmtInt(x.formed)} formed ({fmtShare(x.formed / Math.max(1, x.sampled))})</dd>
            </div>
            <div>
              <dt>Median snipers in first 20</dt>
              <dd>{x.medianSnipers === null ? "—" : x.medianSnipers.toFixed(x.medianSnipers % 1 ? 1 : 0)}</dd>
            </div>
            <div>
              <dt>3+ wallets of one farm group</dt>
              <dd>{fmtShare(x.withFarm / x.formed)}</dd>
            </div>
          </dl>
          <p className={s.note}>
            Up to 24 curve launches per day, spread through the day. Formed = 5+ buyers in the first hour. Labels from the <Link href="/methodology#index">Early Index</Link> ({fmtInt(x.indexSnipers)} bots, {fmtInt(x.indexFarms)} farm groups, built {utcDay(x.indexBuiltAt).md}).
          </p>
        </>
      ) : x ? (
        <Unknown why={`None of the ${fmtInt(x.sampled)} sampled launches formed a line yet.`} />
      ) : (
        <Unknown why="The first-hour sample did not load this round." />
      )}
    </Panel>
  );
}

function Devs({ d }: { d: StateSnapshot }) {
  const [tab, setTab] = useState<"all" | "week">("all");
  const rows: DevRow[] | null = d.devs ? d.devs[tab] : null;
  return (
    <Panel
      id="devs"
      title="Top devs by graduations"
      src={d.devsSrc}
      aside={
        d.devs ? (
          <div className={s.seg} role="tablist" aria-label="Period">
            <button role="tab" aria-selected={tab === "all"} className={tab === "all" ? s.on : ""} onClick={() => setTab("all")}>All time</button>
            <button role="tab" aria-selected={tab === "week"} className={tab === "week" ? s.on : ""} onClick={() => setTab("week")}>7 days</button>
          </div>
        ) : undefined
      }
    >
      {!rows ? (
        <Unknown why="Factory or graduation logs are incomplete this round." />
      ) : !rows.length ? (
        <Unknown why="No graduations in this period." />
      ) : (
        <div className={s.table}>
          <div className={`${s.tr} ${s.th} ${s.trDev}`}>
            <span>#</span>
            <span>Dev</span>
            <span className={s.r}>{tab === "all" ? "Grads" : "Grads 7d"}</span>
            <span className={`${s.r} ${s.hideS}`}>{tab === "all" ? "7d" : "All"}</span>
            <span className={`${s.r} ${s.hideS}`}>Launches</span>
            <span className={s.r}>Hit rate</span>
            <span className={`${s.r} ${s.hideS}`}>Latest</span>
          </div>
          {rows.map((r, i) => (
            <div key={r.creator} className={`${s.tr} ${s.trDev}`}>
              <span className={s.place}>{i + 1}</span>
              <Link className={s.addr} href={`/dev/${r.creator}`} prefetch={false}>{shortAddr(r.creator)}</Link>
              <span className={`${s.r} ${s.strong}`}>{fmtInt(tab === "all" ? r.grads : r.grads7d)}</span>
              <span className={`${s.r} ${s.hideS}`}>{fmtInt(tab === "all" ? r.grads7d : r.grads)}</span>
              <span className={`${s.r} ${s.hideS}`} title={r.unlisted ? `${fmtInt(r.unlisted)} on factories vibe's lists leave out` : undefined}>
                {fmtInt(r.launches)}
                {r.unlisted ? "*" : ""}
              </span>
              <span className={s.r}>{fmtShare(r.launches ? r.grads / r.launches : null)}</span>
              <span className={`${s.r} ${s.hideS} ${s.latest}`}>
                {r.lastToken ? <Link href={`/line/${r.lastToken}`} prefetch={false}>{r.lastSymbol ? `$${r.lastSymbol}` : shortAddr(r.lastToken)}</Link> : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className={s.note}>
        Hit rate = graduations / launches, all time, from factory logs. A high count can be one team or a farm.
        {rows?.some((r) => r.unlisted) ? " * includes launches on the first or legacy factory, which vibe's lists leave out." : ""}
      </p>
    </Panel>
  );
}

function Volumes({ d }: { d: StateSnapshot }) {
  const v = d.volumes;
  return (
    <Panel id="volume" title="Biggest 24h volume" term="real-volume" meta="top 10, ETH" src={d.volumesSrc} wide>
      {v && v.rows.length ? (
        <>
          <div className={s.table}>
            <div className={`${s.tr} ${s.th} ${s.trVol}`}>
              <span>#</span>
              <span>Token</span>
              <span className={s.r}>24h vol, ETH</span>
              <span className={`${s.r} ${s.hideS}`}>Share</span>
              <span className={s.r}>Status</span>
            </div>
            {v.rows.map((r: VolRow, i) => (
              <Link key={r.token} href={`/line/${r.token}`} prefetch={false} className={`${s.tr} ${s.trVol} ${s.rowLink}`}>
                <span className={s.place}>{i + 1}</span>
                <span className={s.tok}>
                  <b>${r.symbol || shortAddr(r.token)}</b>
                  <small>{r.name}</small>
                </span>
                <span className={`${s.r} ${s.strong}`}>{fmtEth(r.volume24hEth)}</span>
                <span className={`${s.r} ${s.hideS}`}>{fmtShare(v.total ? r.volume24hEth / v.total : null)}</span>
                <span className={`${s.r} ${s.status}`}>
                  {r.taxed && <span className={`${s.word} ${s.pillGap}`}>Taxed</span>}
                  {r.graduated ? <span className={`${s.word} ${s.wordGood}`}>Graduated</span> : r.progressBps === null ? "—" : <>{(r.progressBps / 100).toFixed(0)}%<span className={s.hideS}> to grad</span></>}
                </span>
              </Link>
            ))}
          </div>
          <p className={s.note}>
            Ranked across {fmtInt(v.scanned)} tokens: vibe&apos;s trending, near-graduation and graduated lists, the newest taxed launches (ETH pairs) and this week&apos;s latest graduations. Share = of {fmtEth(v.total)} ETH across them. Not every launch is scanned.
          </p>
        </>
      ) : (
        <Unknown why="The vibe API did not answer. Volumes come back on the next build." />
      )}
    </Panel>
  );
}

function AfterGrad({ d, now }: { d: StateSnapshot; now: number }) {
  const x = d.door;
  // rows with a reading first; "no trade / not yet" rows fold into one line under the table
  const hasData = (r: DoorRow) => r.ret24h !== null || (r.traded1h === true && r.ret1h !== null);
  const full = x ? x.rows.filter(hasData) : [];
  const empty = x ? x.rows.filter((r) => !hasData(r)) : [];
  const emptySpan = empty.length ? Math.max(...empty.map((r) => now - r.gradTs)) : 0;
  return (
    <Panel id="after" title="After graduation" term="graduation" meta="vs the pool's open · 1 per dev and batch" src={d.doorSrc} wide>
      {x ? (
        <>
          <div className={s.kpis4}>
            <Kpi
              label="Median, 1h after"
              value={x.traded1h !== undefined && x.traded1h < 5 ? "—" : fmtRet(x.median1h)}
              sub={x.traded1h === undefined ? `n = ${fmtInt(x.n1h)}` : `n = ${fmtInt(x.traded1h)} traded of ${fmtInt(x.n1h)}`}
            />
            <Kpi label="Median, 24h after" value={fmtRet(x.median24h)} sub={`n = ${fmtInt(x.n24h)} sampled`} />
            <Kpi label="Above open at 24h" value={fmtShare(x.up24h)} tone="exit" sub={`n = ${fmtInt(x.n24h)}`} />
            <Kpi label="No trade in 24h" value={fmtShare(x.dead24h)} sub={`n = ${fmtInt(x.n24h)}`} />
          </div>
          {full.length > 0 && (
            <div className={s.table}>
              <div className={`${s.tr} ${s.th} ${s.trDoor}`}>
                <span>Token</span>
                <span className={s.r}>Graduated</span>
                <span className={s.r}>+1h</span>
                <span className={s.r}>+24h</span>
                <span className={`${s.r} ${s.hideS}`}>Trades 24h</span>
              </div>
              <ShowMore count={full.length} initial={8} label="graduations">
                {(n) =>
                  full.slice(0, n).map((r: DoorRow) => (
                    <Link key={r.token} href={`/line/${r.token}`} prefetch={false} className={`${s.tr} ${s.trDoor} ${s.rowLink}`}>
                      <span className={s.tok}><b>{r.symbol ? `$${r.symbol}` : shortAddr(r.token)}</b></span>
                      <span className={`${s.r} ${s.dim}`}>{ago(r.gradTs, now)} ago</span>
                      <span className={`${s.r} ${r.traded1h === false ? s.dim : retClass(r.ret1h)}`}>{r.traded1h === false ? "no trade" : fmtRet(r.ret1h)}</span>
                      <span className={`${s.r} ${retClass(r.ret24h)}`}>{r.ret24h === null ? <span className={s.dim}>{now - r.gradTs < 86_400 ? "not yet" : "—"}</span> : fmtRet(r.ret24h)}</span>
                      <span className={`${s.r} ${s.hideS}`}>{r.trades24h === null ? "—" : fmtInt(r.trades24h)}</span>
                    </Link>
                  ))
                }
              </ShowMore>
            </div>
          )}
          {empty.length > 0 && (
            <p className={s.emptyRows}>
              {full.length > 0 ? `${fmtInt(empty.length)} more` : fmtInt(empty.length)} graduated in the last {fmtDur(emptySpan)} with no trade yet.
            </p>
          )}
          <p className={s.note}>
            The 1h figure samples the newest graduations at least an hour old ({fmtInt(x.n1h)}); the 24h figures the newest at least a day old ({fmtInt(x.n24h)}{x.raw24h !== undefined && x.raw24h > x.n24h ? ` of ${fmtInt(x.raw24h)} in that span` : ""}).
            Price vs the V4 pool&apos;s opening price; later prices are the last swap before +1h / +24h (no swap = still at the open). One token per dev and per 2-minute batch, so one farm can&apos;t fill the sample. The 1h median shows from 5 traded pools. Taxed v6 not included.
          </p>
        </>
      ) : (
        <Unknown why="Pool swaps did not load, or no graduation is an hour old yet." />
      )}
    </Panel>
  );
}

function Method({ d }: { d: StateSnapshot }) {
  const f = d.totals.factories;
  return (
    <Panel id="method" title="Method and sources" wide aside={<Link className={s.headLink} href="/methodology">Full methodology →</Link>}>
      <div className={s.methodBody}>
        <ul>
          <li><b>Launches</b>: LaunchCreated logs of the four vibe/vibe factories. Days are UTC.</li>
          <li><b>Graduations</b>: graduation logs from curves a vibe factory created (anyone can emit the same event).</li>
          <li><b>Time to graduation</b>: launch block to graduation block, for this week&apos;s graduations.</li>
          <li><b>Snipers</b>: the first 20 distinct buyers in the token&apos;s first hour (dev and protocol left out), matched against the Early Index. A sample, not a census.</li>
          <li><b>After graduation</b>: swaps in the token&apos;s Uniswap V4 pool, price vs the pool&apos;s opening price.</li>
          <li><b>Volumes</b> and <b>progress</b> come from the vibe API, which lists only some factories.</li>
          <li>Rebuilt about every 15 minutes. Unknown shows as —, never 0. Signals, not verdicts. Testnet.</li>
        </ul>
        {f && (
          <div className={s.table}>
            <div className={`${s.tr} ${s.th} ${s.trFac}`}>
              <span>Factory</span>
              <span className={s.r}>Launches</span>
              <span className={s.r}>7d</span>
              <span className={s.r}>Grads</span>
              <span className={s.r}>7d</span>
            </div>
            {f.map((x) => (
              <div key={x.id} className={`${s.tr} ${s.trFac}`}>
                <span className={s.tok}><b>{x.label}</b><small>{shortAddr(x.address)}</small></span>
                <span className={s.r}>{fmtInt(x.launches)}</span>
                <span className={s.r}>{fmtInt(x.launches7d)}</span>
                <span className={s.r}>{fmtInt(x.grads)}</span>
                <span className={s.r}>{fmtInt(x.grads7d)}</span>
              </div>
            ))}
          </div>
        )}
        <p className={s.dim}>Block #{fmtInt(d.headBlock)} · built in {(d.buildMs / 1000).toFixed(0)}s</p>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ board */

type Wire = { status: string; stage?: string; snapshot?: StateSnapshot };

const FALLBACK_LEAD = "Launchpad-wide stats for vibe/vibe, read from the chain: launches, graduations, snipers, top devs and volume.";

export default function StateBoard({ initial }: { initial: StateSnapshot | null }) {
  const [snap, setSnap] = useState<StateSnapshot | null>(initial);
  const [status, setStatus] = useState<"ok" | "warming" | "down">(initial ? "ok" : "warming");
  const [stage, setStage] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let next = 5 * 60_000;
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const j = (await r.json()) as Wire;
        if (!alive) return;
        if (j.snapshot) {
          setSnap((old) => (!old || j.snapshot!.builtAt >= old.builtAt ? j.snapshot! : old));
          setStatus("ok");
          if (j.status === "stale") next = 30_000; // a new build is running: pick it up soon
        } else {
          setStatus(r.status === 202 ? "warming" : "down");
          setStage(j.stage ?? "");
          next = 10_000;
        }
      } catch {
        if (alive) setStatus((x) => (x === "ok" ? x : "down"));
        next = 30_000;
      }
      setNow(Math.floor(Date.now() / 1000));
      if (alive) timer = setTimeout(load, next);
    };
    // the server-rendered snapshot is fresh: wait before the first poll
    const fresh = initial && Date.now() - initial.builtAt * 1000 < FRESH_MS;
    timer = setTimeout(load, fresh ? 5 * 60_000 : 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [initial]);

  const lead = useMemo(() => stateHeadline(snap), [snap]);
  const t = snap?.totals;
  const rate = t?.cohort && t.cohort.launched ? t.cohort.graduated / t.cohort.launched : null;
  const ageMin = snap ? Math.max(0, Math.round((now - snap.builtAt) / 60)) : 0;

  return (
    <div className={s.board}>
      <div className={s.top}>
        <PageHead title="State of vibe">{lead.length ? lead.join(" ") : FALLBACK_LEAD}</PageHead>
        {snap ? (
          <p className={s.stamp}>
            <span>Snapshot {utcStamp(snap.builtAt)}</span>
            <span>block {fmtInt(snap.headBlock)}</span>
            {ageMin >= STALE_MIN ? <span className={s.stale}>Stale · {fmtDur(ageMin * 60)}</span> : <span>{ageMin < 1 ? "just now" : `${ageMin}m ago`}</span>}
          </p>
        ) : (
          <p className={s.stamp}>
            <span className={s.reading}>{status === "down" ? "No answer" : "Reading the chain"}</span>
          </p>
        )}
      </div>

      {!snap ? (
        <div className={s.warming} aria-live="polite">
          <p>{status === "down" ? "Not answering. Retrying shortly." : "Reading every launch factory from the start. About two minutes; the page fills in by itself."}</p>
          {stage && status !== "down" && <small>Step: {stage}</small>}
          {/* named tiles: the layout explains itself while the first build runs */}
          <div className={s.skel} aria-hidden>
            {["Launches 7d", "Graduations 7d", "Grad rate", "Median to grad"].map((k) => (
              <span key={k}>
                <em>{k}</em>
                <i />
              </span>
            ))}
          </div>
          <ul className={s.skelList} aria-hidden>
            {["Launches per day", "Graduations per day", "Time to graduation", "Snipers at the front", "Top devs", "After graduation", "Biggest 24h volume"].map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      ) : (
        <SnapAt.Provider value={snap.builtAt}>
          {snap.notes.length > 0 && (
            <ul className={s.notes}>
              {snap.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}

          <div className={s.kpiBlock}>
            <div className={s.kpis}>
              <Kpi label="Launches 7d" value={t?.launches7d == null ? "—" : fmtInt(t.launches7d)} sub="all four factories" />
              <Kpi label="Graduations 7d" value={t?.grads7d == null ? "—" : fmtInt(t.grads7d)} sub="any launch date" tone="exit" />
              <Kpi label={<><Term id="graduation">Grad rate</Term> · this week&apos;s launches</>} value={fmtShare(rate)} sub={t?.cohort ? `${fmtInt(t.cohort.graduated)} of ${fmtInt(t.cohort.launched)}` : "—"} />
              <Kpi label={<Term id="eta">Median to grad</Term>} value={snap.ttg ? fmtDur(snap.ttg.medianS) : "—"} sub={snap.ttg ? `${fmtInt(snap.ttg.n)} graduations` : "—"} />
            </div>
            <div className={s.captionRow}>
              <p className={s.caption}>
                The week runs from {utcDay(snap.windowStart).md} 00:00 UTC to now. Graduations 7d counts every token that graduated this week, whenever it launched. Grad rate counts only this week&apos;s launches that already graduated (5 ETH reached, trading moved to Uniswap V4).
              </p>
              {/* a plain file link: the PNG is rendered on the server and kept an hour (src/app/state/card/route.tsx) */}
              <a className={s.download} href="/state/card" download={`state-of-vibe-${new Date(snap.windowStart * 1000).toISOString().slice(0, 10)}.png`}>
                Download weekly card ↓
              </a>
            </div>
          </div>

          <SectionTabs items={SECTIONS} className={s.tabs} />

          <div className={s.pair} id="activity">
            <Launches d={snap} />
            <Graduations d={snap} />
          </div>
          <div className={s.pair} id="graduation">
            <TimeToGrad d={snap} />
            <Progress d={snap} />
          </div>
          <div className={s.pair}>
            <Snipers d={snap} />
            <Devs d={snap} />
          </div>
          <AfterGrad d={snap} now={now} />
          <Volumes d={snap} />
          <Method d={snap} />
        </SnapAt.Provider>
      )}
    </div>
  );
}
