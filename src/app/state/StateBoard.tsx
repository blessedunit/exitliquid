"use client";

// State of vibe: the board. Data comes from /api/state (one snapshot, rebuilt every ~15 min on the server).
// Layout: head (H1, snapshot stamp) → 4 KPIs → launches, graduations, time to graduation, snipers, top devs, volume.
// No boxes: every block is a title + a meta line (what, source, time) on the page background, separated by hairlines.
// Unknown is "—" with a reason, never 0.
import Link from "next/link";
import { createContext, useContext, useEffect, useState } from "react";
import type { DayRow, DevRow, Src, StateSnapshot, VolRow } from "@/lib/state";
import { fmtCompact, fmtEth, fmtInt, shortAddr } from "@/lib/format";
import { fmtDur, fmtShare } from "./headline";
import PageHead from "@/components/PageHead";
import TokenAvatar from "@/components/TokenAvatar";
import Term from "@/components/ui/Term";
import Unreadable from "@/components/token/Unreadable";
import { useTries } from "@/components/useTries";
import type { GlossaryId } from "@/lib/glossary";
import Loader, { shimmer } from "@/components/ui/Loader";
import s from "./state.module.css";

const FRESH_MS = 15 * 60_000;
const STALE_MIN = 40; // the snapshot is rebuilt every ~15 min: older than this is worth saying
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const UNKNOWN = "Unknown, not zero.";


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
        <Unknown why="Factory logs did not load this round." />
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
            Up to 24 curve launches per day, spread through the day. Formed = 5+ buyers in the first hour. Labels from the <Link href="/methodology#early-index">Early Index</Link> ({fmtInt(x.indexSnipers)} bots, {fmtInt(x.indexFarms)} farm groups, built {utcDay(x.indexBuiltAt).md}).
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
              <Link className={s.addr} href={`/w/${r.creator}#launches`} prefetch={false}>{shortAddr(r.creator)}</Link>
              <span className={`${s.r} ${s.strong}`}>{fmtInt(tab === "all" ? r.grads : r.grads7d)}</span>
              <span className={`${s.r} ${s.hideS}`}>{fmtInt(tab === "all" ? r.grads7d : r.grads)}</span>
              <span className={`${s.r} ${s.hideS}`} title={r.unlisted ? `${fmtInt(r.unlisted)} on factories vibe's lists leave out` : undefined}>
                {fmtInt(r.launches)}
                {r.unlisted ? "*" : ""}
              </span>
              <span className={s.r}>{fmtShare(r.launches ? r.grads / r.launches : null)}</span>
              <span className={`${s.r} ${s.hideS} ${s.latest}`}>
                {r.lastToken ? (
                  <Link className={s.latestLink} href={`/line/${r.lastToken}`} prefetch={false}>
                    <TokenAvatar src={r.lastImage ?? null} symbol={r.lastSymbol ?? ""} size={20} />
                    <span>{r.lastSymbol ? `$${r.lastSymbol}` : shortAddr(r.lastToken)}</span>
                  </Link>
                ) : (
                  "—"
                )}
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
                <span className={s.tokRow}>
                  <TokenAvatar src={r.image ?? null} symbol={r.symbol} size={28} />
                  <span className={s.tok}>
                    <b>${r.symbol || shortAddr(r.token)}</b>
                    <small>{r.name}</small>
                  </span>
                </span>
                <span className={`${s.r} ${s.strong}`}>{r.volume24hEth >= 1000 && r.volume24hEth < 1_000_000 ? Math.round(r.volume24hEth).toLocaleString("en-US") : fmtEth(r.volume24hEth)}</span>
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

/* ------------------------------------------------------------------ board */

type Wire = { status: string; stage?: string; snapshot?: StateSnapshot };

export default function StateBoard({ initial }: { initial: StateSnapshot | null }) {
  const [snap, setSnap] = useState<StateSnapshot | null>(initial);
  const [status, setStatus] = useState<"ok" | "warming" | "down">(initial ? "ok" : "warming");
  const [stage, setStage] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const { failed, round, start, fail, ok } = useTries(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let have = !!initial; // a snapshot is on screen: a failed refresh keeps it (it goes stale) and keeps asking
    start();
    // no snapshot and no answer: ask again while tries are left (the page keeps reading), then stop
    const miss = () => {
      if (have || fail(null)) return true;
      setStatus("down");
      return false;
    };
    const load = async () => {
      let next = 5 * 60_000;
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const j = (await r.json()) as Wire;
        if (!alive) return;
        if (j.snapshot) {
          setSnap((old) => (!old || j.snapshot!.builtAt >= old.builtAt ? j.snapshot! : old));
          setStatus("ok");
          have = true;
          ok();
          if (j.status === "stale") next = 30_000; // a new build is running: pick it up soon
        } else {
          // 202 = the first build is running (about two minutes): waiting, not a failed try
          if (r.status !== 202 && !miss()) return;
          setStatus("warming");
          setStage(j.stage ?? "");
          next = 10_000;
        }
      } catch {
        if (!alive || !miss()) return;
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
  }, [initial, round, start, fail, ok]);

  const t = snap?.totals;
  const rate = t?.cohort && t.cohort.launched ? t.cohort.graduated / t.cohort.launched : null;
  const ageMin = snap ? Math.max(0, Math.round((now - snap.builtAt) / 60)) : 0;

  return (
    <div className={s.board}>
      <div className={s.top}>
        <PageHead title="Market">vibe/vibe this week, read from the chain.</PageHead>
        {snap ? (
          <p className={s.stamp}>
            <span>Snapshot {utcStamp(snap.builtAt)}</span>
            <span>block {fmtInt(snap.headBlock)}</span>
            {ageMin >= STALE_MIN ? <span className={s.stale}>Stale · {fmtDur(ageMin * 60)}</span> : <span>{ageMin < 1 ? "just now" : `${ageMin}m ago`}</span>}
          </p>
        ) : (
          <p className={s.stamp}>
            {status === "down" && failed ? <span>No answer</span> : <Loader size="mini" caption="Reading the chain…" />}
          </p>
        )}
      </div>

      {!snap ? (
        <div className={s.warming} aria-live="polite">
          {status === "down" && failed
            ? <Unreadable failed={failed} what="the chain" />
            : <><Loader /><p>Reading every launch factory from the start. About two minutes; the page fills in by itself.</p></>}
          {stage && status !== "down" && <small>Step: {stage}</small>}
          {/* named tiles: the layout explains itself while the first build runs (not after the read gave up) */}
          {!(status === "down" && failed) && <>
          <div className={s.skel} aria-hidden>
            {["Launches 7d", "Graduations 7d", "Grad rate", "Median to grad"].map((k) => (
              <span key={k}>
                <em>{k}</em>
                <i className={shimmer} />
              </span>
            ))}
          </div>
          <ul className={s.skelList} aria-hidden>
            {["Launches per day", "Graduations per day", "Time to graduation", "Snipers at the front", "Top devs", "Biggest 24h volume"].map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
          </>}
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
              <Kpi label="Launches 7d" value={t?.launches7d == null ? "—" : fmtInt(t.launches7d)} sub="all factories" />
              <Kpi label="Graduations 7d" value={t?.grads7d == null ? "—" : fmtInt(t.grads7d)} sub="any launch date" tone="exit" />
              <Kpi label={<><Term id="graduation">Grad rate</Term> · this week&apos;s launches</>} value={fmtShare(rate)} sub={t?.cohort ? `${fmtInt(t.cohort.graduated)} of ${fmtInt(t.cohort.launched)}` : "—"} />
              <Kpi label={<Term id="eta">Median to grad</Term>} value={snap.ttg ? fmtDur(snap.ttg.medianS) : "—"} sub={snap.ttg ? `${fmtInt(snap.ttg.n)} graduations` : "—"} />
            </div>
            <div className={s.captionRow}>
              {/* a plain file link: the PNG is rendered on the server and kept an hour (src/app/state/card/route.tsx) */}
              <a className={s.download} href="/state/card" download={`state-of-vibe-${new Date(snap.windowStart * 1000).toISOString().slice(0, 10)}.png`}>
                Download weekly card ↓
              </a>
            </div>
          </div>

          <div className={s.pair} id="activity">
            <Launches d={snap} />
            <Graduations d={snap} />
          </div>
          <div className={s.pair} id="graduation">
            <TimeToGrad d={snap} />
            <Snipers d={snap} />
          </div>
          <Devs d={snap} />
          <Volumes d={snap} />
        </SnapAt.Provider>
      )}
    </div>
  );
}
