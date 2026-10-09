"use client";
// Graduation watch: the three lines nearest the door as pixel scenes, the rest as a table, the last 24 h of
// graduations, and the lines that stopped near the door (collapsed). Refreshes once a minute, only while visible.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import TokenAvatar from "@/components/TokenAvatar";
import { fmtEth, shortAddr } from "@/lib/format";
import DoorScene from "./DoorScene";
import { splitNear, type DoorSnap, type GradRow, type NearCard } from "./types";
import EmptyState from "@/components/ui/EmptyState";
import k from "../_kit/kit.module.css";
import styles from "./door.module.css";

const POLL_MS = 60_000;
const GRAD_LIMIT = 10;

/* ---------------- words ---------------- */

function dur(h: number): string {
  const m = h * 60;
  if (m < 1) return "<1m";
  if (m < 60) return `${Math.round(m)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  if (h < 24 * 30) return `${Math.round(h / 24)}d`;
  return "30d+";
}
function etaText(lo: number | null, hi: number | null): string | null {
  if (lo === null || hi === null) return null;
  const a = dur(lo);
  const b = dur(hi);
  return a === b ? `~${a}` : `~${a}–${b}`;
}
const pctBps = (bps: number) => `${(bps / 100).toFixed(bps >= 9_990 && bps < 10_000 ? 2 : 1)}%`;
function signed(frac: number | null, digits = 1): string {
  if (frac === null || !Number.isFinite(frac)) return "—";
  const p = frac * 100;
  if (Math.abs(p) < 0.05) return "0.0%";
  const a = Math.abs(p);
  return `${p > 0 ? "+" : "−"}${a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(digits)}%`;
}
const tone = (frac: number | null) => (frac === null || Math.abs(frac) < 0.0005 ? "" : frac > 0 ? k.up : k.down);
function ago(s: number): string {
  const x = Math.max(0, Math.floor(s));
  if (x < 60) return "just now";
  if (x < 3600) return `${Math.floor(x / 60)}m ago`;
  return `${Math.floor(x / 3600)}h ${Math.floor((x % 3600) / 60)}m ago`;
}
const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16) + " UTC";
const eth = (v: number | null) => (v === null ? "—" : v > 0 && v < 0.001 ? "<0.001" : fmtEth(v));
const sym = (s: string | null, token: string) => (s ? `$${s}` : shortAddr(token));

/* ---------------- data ---------------- */

function useDoor(initial: DoorSnap | null) {
  const [snap, setSnap] = useState<DoorSnap | null>(initial);
  const [err, setErr] = useState(false);
  const last = useRef(initial?.builtAt ?? 0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const ctl = new AbortController();
    const tick = async () => {
      if (!alive || running) return;
      if (timer) clearTimeout(timer);
      if (document.visibilityState === "visible") {
        running = true;
        try {
          const r = await fetch("/api/door", { cache: "no-store", signal: ctl.signal });
          if (!r.ok) throw new Error(String(r.status));
          const j = (await r.json()) as DoorSnap;
          last.current = Date.now();
          if (alive) {
            setSnap(j);
            setErr(false);
          }
        } catch {
          if (alive) setErr(true); // the last good snapshot stays on screen
        }
        running = false;
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    const wake = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current > POLL_MS) void tick();
    };
    document.addEventListener("visibilitychange", wake);
    // a server render with data waits a full minute; without one, ask now
    timer = setTimeout(tick, initial ? Math.max(5_000, POLL_MS - (Date.now() - initial.builtAt)) : 0);
    return () => {
      alive = false;
      ctl.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [initial]);
  return { snap, err };
}

/** "now" for relative times: starts at the snapshot's time (same text on server and client), then ticks while visible */
function useNow(start: number) {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/* ---------------- pieces ---------------- */

function Phase({ c }: { c: NearCard }) {
  if (c.phase === "door") return <span className={`${k.st} ${k.stLive}`}>At the door</span>;
  if (c.phase === "walking") return <span className={`${k.st} ${k.stGood}`}>Walking</span>;
  return <span className={k.st}>Pace unknown</span>;
}

/** thin bar on the same 0..100 % scale as the board, a door tick at the end */
function Bar({ bps, open }: { bps: number; open: boolean }) {
  const f = open ? 1 : Math.max(0, Math.min(1, bps / 10_000));
  return (
    <span className={styles.bar} role="img" aria-label={`${pctBps(bps)} of the way to the door`}>
      <span className={styles.barFill} style={{ width: `${(f * 100).toFixed(2)}%` }} />
    </span>
  );
}

/** the top three: a pixel scene in a panel, two lines of facts under it */
function SceneCard({ c }: { c: NearCard }) {
  const e = etaText(c.etaLoH, c.etaHiH);
  return (
    <article className={styles.card}>
      <Link href={`/line/${c.token}`} className={styles.stage} aria-label={`Open the ${sym(c.symbol, c.token)} line`}>
        <DoorScene token={c.token} bps={c.progressBps} holders={c.holders} phase={c.phase} />
      </Link>
      <div className={styles.cardHead}>
        <Link href={`/line/${c.token}`} className={styles.who}>
          <TokenAvatar src={c.image} symbol={c.symbol} size={32} />
          <span className={styles.names}>
            <b>{sym(c.symbol, c.token)}</b>
            <small>{c.name || shortAddr(c.token)}</small>
          </span>
        </Link>
        <span className={`${k.num} ${styles.cardPct}`}>{pctBps(c.progressBps)}</span>
      </div>
      <Bar bps={c.progressBps} open={c.phase === "door"} />
      <dl className={styles.facts}>
        <div>
          <dt className={k.label}>ETA</dt>
          <dd className={k.num}>{c.phase === "door" ? "now" : (e ?? "—")}</dd>
        </div>
        <div>
          <dt className={k.label}>ETH left</dt>
          <dd className={k.num}>{c.phase === "door" ? "0" : eth(c.remainingEth)}</dd>
        </div>
        <div>
          <dt className={k.label}>Price 1h</dt>
          <dd className={`${k.num} ${c.change1hBps === null ? "" : tone(c.change1hBps / 10_000)}`}>{c.change1hBps === null ? "—" : signed(c.change1hBps / 10_000)}</dd>
        </div>
      </dl>
      <p className={k.meta}>
        <Phase c={c} /> <span className={styles.metaSep}>·</span> {eth(c.vol1hEth)} ETH vol 1h · {c.buys1h ?? "—"} buys / {c.sells1h ?? "—"} sells
      </p>
    </article>
  );
}

function NearTable({ rows }: { rows: NearCard[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={`${k.table} ${styles.near}`}>
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">To grad</th>
            <th scope="col" className={k.r}>ETA</th>
            <th scope="col" className={`${k.r} ${styles.hideS}`}>ETH left</th>
            <th scope="col" className={`${k.r} ${styles.hideM}`}>Vol 1h</th>
            <th scope="col" className={`${k.r} ${styles.hideM}`}>B / S 1h</th>
            <th scope="col" className={`${k.r} ${styles.hideS}`}>Price 1h</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const e = etaText(c.etaLoH, c.etaHiH);
            return (
              <tr key={c.token}>
                <td>
                  <Link href={`/line/${c.token}`} className={styles.who} prefetch={false}>
                    <TokenAvatar src={c.image} symbol={c.symbol} size={24} />
                    <span className={styles.names}>
                      <b>{sym(c.symbol, c.token)}</b>
                      <small className={styles.hideS}>{c.name || shortAddr(c.token)}</small>
                    </span>
                  </Link>
                </td>
                <td>
                  <span className={styles.gradCell}>
                    <Bar bps={c.progressBps} open={c.phase === "door"} />
                    <span className={k.num}>{pctBps(c.progressBps)}</span>
                  </span>
                </td>
                <td className={k.n}>{c.phase === "door" ? "now" : (e ?? <span className={k.dim}>{c.phase === "unknown" ? "pace unknown" : "—"}</span>)}</td>
                <td className={`${k.n} ${styles.hideS}`}>{c.phase === "door" ? "0" : eth(c.remainingEth)}</td>
                <td className={`${k.n} ${styles.hideM}`}>{eth(c.vol1hEth)}</td>
                <td className={`${k.n} ${styles.hideM}`}>
                  {c.buys1h ?? "—"} / {c.sells1h ?? "—"}
                </td>
                <td className={`${k.n} ${styles.hideS} ${c.change1hBps === null ? "" : tone(c.change1hBps / 10_000)}`}>{c.change1hBps === null ? "—" : signed(c.change1hBps / 10_000)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Path({ path, fresh }: { path: number[]; fresh: boolean }) {
  if (path.length < 2) return <span className={k.dim}>{fresh ? "too new" : "no candles"}</span>;
  const w = 88;
  const hgt = 24;
  const pts = path.map((y, i) => `${((i / (path.length - 1)) * (w - 2) + 1).toFixed(1)},${(hgt - 2 - (y / 1000) * (hgt - 4)).toFixed(1)}`).join(" ");
  const up = path[path.length - 1] >= path[0];
  return (
    <svg className={styles.path} width={w} height={hgt} viewBox={`0 0 ${w} ${hgt}`} aria-hidden>
      <line x1="1" x2="1" y1="2" y2={hgt - 2} className={styles.pathDoor} />
      <polyline points={pts} fill="none" className={up ? styles.pathUp : styles.pathDown} strokeWidth="1.5" />
    </svg>
  );
}

function GradTable({ rows, now }: { rows: GradRow[]; now: number }) {
  return (
    <table className={`${k.table} ${styles.gradsTable}`}>
      <thead>
        <tr>
          <th scope="col">Token</th>
          <th scope="col" className={styles.hideS}>Since the door</th>
          <th scope="col" className={k.r} title="Pool price 1 h after the door vs its opening price">+1h</th>
          <th scope="col" className={k.r} title="Last 15-min close vs the close the door opened in">Now</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((g) => {
          const age = now / 1000 - g.gradTs;
          return (
            <tr key={g.token}>
              <td>
                <Link href={`/line/${g.token}`} className={styles.who} prefetch={false}>
                  <TokenAvatar src={g.image} symbol={g.symbol ?? "?"} size={24} />
                  <span className={styles.names}>
                    <b>{sym(g.symbol, g.token)}</b>
                    <small>
                      <time dateTime={new Date(g.gradTs * 1000).toISOString()}>{utc(g.gradTs)}</time> · {ago(age)}
                    </small>
                  </span>
                </Link>
              </td>
              <td className={styles.hideS}>
                <Path path={g.path} fresh={age < 1800} />
              </td>
              <td
                className={`${k.n} ${tone(g.ret1h)}`}
                title={g.ret1hSrc === "chain" ? "From the pool's swaps (chain)" : g.ret1hSrc === "candles" ? "From 15-min candles: approximate" : "Under an hour old, or unknown"}
              >
                {g.ret1h === null ? <span className={k.dim}>{age < 3600 ? "soon" : "—"}</span> : `${g.ret1hSrc === "candles" ? "≈" : ""}${signed(g.ret1h)}`}
              </td>
              <td className={`${k.n} ${tone(g.sinceDoor)}`}>{signed(g.sinceDoor)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SmallTable({ rows, note }: { rows: NearCard[]; note: (c: NearCard) => string | null }) {
  return (
    <table className={`${k.table} ${styles.smallTable}`}>
      <thead>
        <tr>
          <th scope="col">Token</th>
          <th scope="col" className={k.r}>To grad</th>
          <th scope="col" className={styles.hideS}>Why</th>
          <th scope="col" className={k.r}>Buys 1h</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.token}>
            <td>
              <Link href={`/line/${c.token}`} className={styles.who} prefetch={false}>
                <TokenAvatar src={c.image} symbol={c.symbol} size={24} />
                <span className={styles.names}>
                  <b>{sym(c.symbol, c.token)}</b>
                </span>
              </Link>
            </td>
            <td className={k.n}>{pctBps(c.progressBps)}</td>
            <td className={`${styles.hideS} ${k.dim}`}>{note(c) ?? ""}</td>
            <td className={k.n}>{c.buys1h ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- page body ---------------- */

const TOP = 3;
const LIMIT = 12;

export default function DoorWatch({ initial }: { initial: DoorSnap | null }) {
  const { snap, err } = useDoor(initial);
  const now = useNow(initial?.builtAt ?? 0);
  const [showAll, setShowAll] = useState(false);
  const [allGrads, setAllGrads] = useState(false);

  if (!snap) {
    return (
      <div className={styles.root}>
        <p className={styles.statLine} role="status">
          <span className={`${k.st} ${k.stLive}`}>Reading the door</span>
          <span className={k.meta}>First read takes a few seconds.</span>
        </p>
        <div className={styles.cards} aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className={styles.card}>
              <div className={`${styles.stage} ${styles.stageSkel}`} />
              <span className={k.skel} style={{ width: "40%" }} />
              <span className={k.skel} style={{ width: "70%" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const split = snap.near ? splitNear(snap.near) : null;
  const walking = split ? split.go.filter((c) => c.phase === "walking").length : null;
  const atDoor = split ? split.go.filter((c) => c.phase === "door").length : null;
  const top = split ? split.go.slice(0, TOP) : [];
  const rest = split ? split.go.slice(TOP) : [];
  const restShown = showAll ? rest : rest.slice(0, LIMIT);
  const nowS = now > 0 ? now : snap.builtAt;
  const ageS = Math.max(0, Math.round((nowS - snap.builtAt) / 1000));
  const n = (v: number | null) => <b className={k.num}>{v === null ? "—" : v.toLocaleString("en-US")}</b>;

  return (
    <div className={styles.root}>
      <p className={styles.statLine}>
        <span className={styles.counts}>
          <span>{n(walking)} walking</span>
          <span>{n(atDoor)} at the door</span>
          <span>{n(split ? split.stalled.length : null)} stalled</span>
          <span>{n(snap.grads ? snap.grads.length : null)} graduated 24h</span>
        </span>
        <span className={styles.updated}>
          {err ? <span className={`${k.st} ${k.stMid}`}>Retrying…</span> : <span className={`${k.st} ${k.stLive}`}>Live</span>}
          <span className={k.meta}>updated {ageS < 60 ? `${ageS}s` : `${Math.floor(ageS / 60)}m`} ago</span>
        </span>
      </p>

      {/* ---------- near the door ---------- */}
      <section className={k.sec} aria-labelledby="near-h">
        <div className={k.secHead}>
          <h2 id="near-h" className={k.h2}>Near the door</h2>
          <p className={k.lead}>85%+ and still moving. Soonest first.</p>
        </div>
        {!split ? (
          <EmptyState boxed={false} title="Unknown right now" skin="doorghost">
            vibe/vibe&apos;s list did not answer. Retrying every minute; nothing here means &ldquo;nobody&rdquo;.
          </EmptyState>
        ) : split.go.length === 0 ? (
          <EmptyState boxed={false} title="Nobody is walking to the door" skin="plain" action={<Link className="btn ghost" href="/">Browse all tokens →</Link>}>
            No line within 15% of the door is moving right now.
          </EmptyState>
        ) : (
          <>
            <div className={styles.cards}>
              {top.map((c) => (
                <SceneCard key={c.token} c={c} />
              ))}
            </div>
            {rest.length > 0 && (
              <>
                <NearTable rows={restShown} />
                {rest.length > LIMIT && (
                  <button type="button" className={k.ghost} onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                    {showAll ? "Show fewer" : `Show all ${split.go.length}`}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </section>

      {/* ---------- just graduated ---------- */}
      <section className={k.sec} aria-labelledby="grad-h">
        <div className={k.secHead}>
          <h2 id="grad-h" className={k.h2}>Just graduated</h2>
          <p className={k.lead}>The last 24 hours, newest first. +1h is the pool price an hour after the door; now is the latest close.</p>
        </div>
        {!snap.grads ? (
          <EmptyState boxed={false} title="Unknown right now" skin="doorghost">
            Graduations did not load. Retrying every minute.
          </EmptyState>
        ) : snap.grads.length === 0 ? (
          <EmptyState boxed={false} title="No graduations in the last 24h" skin="plain" action={<Link className="btn ghost" href="/state">See the week on Market →</Link>}>
            Nothing on vibe/vibe&apos;s list crossed the door today.
          </EmptyState>
        ) : (
          <>
            <GradTable rows={allGrads ? snap.grads : snap.grads.slice(0, GRAD_LIMIT)} now={nowS} />
            {snap.grads.length > GRAD_LIMIT && (
              <button type="button" className={k.ghost} onClick={() => setAllGrads((v) => !v)} aria-expanded={allGrads}>
                {allGrads ? "Show fewer" : `Show all ${snap.grads.length}`}
              </button>
            )}
          </>
        )}
      </section>

      {/* ---------- folds ---------- */}
      <div className={styles.folds}>
        {split && split.stalled.length > 0 && (
          <details className={k.fold}>
            <summary>
              Stalled near the door <span className={`${k.num} ${k.dim}`}>{split.stalled.length}</span>
            </summary>
            <div className={k.foldBody}>
              <p className={k.meta}>85%+ but not getting closer: no buys this hour, a flat or draining day, or a door % that has not moved.</p>
              <SmallTable rows={split.stalled} note={(c) => c.why} />
            </div>
          </details>
        )}
        {snap.unchecked.length > 0 && (
          <details className={k.fold}>
            <summary>
              At 85%+ with buys, pace not read this round <span className={`${k.num} ${k.dim}`}>{snap.unchecked.length}</span>
            </summary>
            <div className={k.foldBody}>
              <SmallTable rows={snap.unchecked} note={() => "pace unknown"} />
            </div>
          </details>
        )}
        <details className={k.fold}>
          <summary>How this is read</summary>
          <div className={k.foldBody}>
            <ul>
              <li>Lines: vibe/vibe&apos;s list at 85%+ (the board&apos;s Door tab). Taxed v6 launches are not in it.</li>
              <li>ETA: the board&apos;s rule. Slow end = remaining ETH at the slower of two paces (the last 24h net inflow and the last hour), fast end = at the faster. No buys this hour, a flat day, or an hour under 10% of the day = stalled, no ETA.</li>
              <li>Door % change: what this site saw over the last hour. A line whose door % has not moved for 30m+ is stalled, whatever the pace says.</li>
              <li>+1h: from the token&apos;s Uniswap V4 pool swaps (State of vibe); ≈ = from 15-min candles. Now: 15-min candles.</li>
              <li>Graduated 24h: launches on vibe/vibe&apos;s list (its newest 100 graduations, plus lines this page saw leave 85%+). Unlisted factories are not counted here; see Market.</li>
              {snap.notes.map((x) => (
                <li key={x}>{x}</li>
              ))}
              <li>Signals, not verdicts. Graduating is not a promise of anything.</li>
            </ul>
          </div>
        </details>
      </div>
    </div>
  );
}
