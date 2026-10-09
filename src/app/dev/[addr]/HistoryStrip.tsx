"use client";
// Launch history: one bar per launch, oldest left. Height = curve progress now on a sqrt scale (most
// launches sit under 5%, a linear scale draws them as flat dashes), green = graduated,
// a red tick under the baseline = the dev sold on that launch. When no launch passed 10% the chart
// collapses to a one-line strip of cells (grey = on the curve, red = dev sold). Hover (or tap) a bar for its numbers.
// The launch table below is the accessible, complete view of the same data.
import { useRef, useState } from "react";
import { fmtAge, pct as pctOf } from "@/lib/format";
import type { Row } from "./LaunchTable";
import styles from "./dev.module.css";

/** sold share: never rounds a real sell down to "0%" or a partial one up to "100%" */
export const pct = (bps: number) => (bps > 0 && bps < 100 ? "<1%" : bps < 10_000 && bps >= 9_950 ? ">99%" : `${(bps / 100).toFixed(0)}%`);

const BAR = 6; // viewBox units per launch (bar 4 + gap 2)
const H = 100;
const TICK = 10;
const FLAT_BPS = 1_000; // 10%: below this for every launch, bars carry no shape worth 132px
const FLAT_H = 12;

export default function HistoryStrip({ rows, now, from = null }: { rows: Row[]; now: number; from?: string | null }) {
  const ordered = [...rows].reverse(); // oldest first
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number; wBox: number } | null>(null);
  const n = ordered.length;
  const w = Math.max(n * BAR, 60);
  const sold = ordered.filter((r) => r.dev && r.dev.sells > 0).length;
  const grad = ordered.filter((r) => r.graduated).length;
  const flat = !ordered.some((r) => r.graduated || r.progressBps >= FLAT_BPS);
  const vh = flat ? FLAT_H : H + TICK + 2;

  const pick = (clientX: number, clientY: number) => {
    const el = box.current;
    if (!el || !n) return;
    const r = el.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * (w / BAR))));
    if (i >= n) return setHover(null);
    setHover({ i, x: ((i + 0.5) * BAR * r.width) / w, y: Math.max(16, clientY - r.top), wBox: r.width });
  };

  const h = hover ? ordered[hover.i] : null;
  const first = ordered[0];
  const last = ordered[n - 1];
  const fi = from ? ordered.findIndex((r) => r.token === from) : -1; // the token page that linked here

  return (
    <>
      <div className={`${styles.stripWrap} ${flat ? "" : styles.withAxis}`}>
        {!flat && (
          <div className={styles.yAxis} aria-hidden>
            <span style={{ top: 0 }}>grad</span>
            <span style={{ top: `${((H / 2) / vh) * 100}%` }}>25%</span>
            <span style={{ top: `${(H / vh) * 100}%` }}>0%</span>
          </div>
        )}
        <div
          ref={box}
          className={styles.stripBox}
          onPointerMove={(e) => pick(e.clientX, e.clientY)}
          onPointerDown={(e) => pick(e.clientX, e.clientY)}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            className={flat ? styles.stripFlat : styles.strip}
            viewBox={`0 0 ${w} ${vh}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${n} launches, oldest to newest: ${grad} graduated, dev sold on ${sold}${flat ? ", none past 10% of the curve" : ""}.`}
          >
            {flat ? ordered.map((r, i) => (
              <rect
                key={r.token}
                className={r.dev && r.dev.sells > 0 ? styles.soldMark : i === fi ? styles.barFrom : styles.bar}
                opacity={hover && hover.i !== i ? 0.55 : 1}
                x={i * BAR + 1} y={0} width={BAR - 2} height={FLAT_H}
              />
            )) : <>
            <line className={styles.grid} x1={0} x2={w} y1={H + 0.5} y2={H + 0.5} vectorEffect="non-scaling-stroke" />
            <line className={styles.grid} x1={0} x2={w} y1={H / 2} y2={H / 2} vectorEffect="non-scaling-stroke" strokeDasharray="2 4" />
            {ordered.map((r, i) => {
              // sqrt scale with a 2-unit floor: 1% stands 10 units tall, 25% half the box
              const ph = r.graduated ? H : Math.max(2, Math.sqrt(Math.min(1, Math.max(0, r.progressBps / 10_000))) * H);
              const on = hover?.i === i;
              return (
                <g key={r.token} opacity={hover && !on ? 0.55 : 1}>
                  <rect className={r.graduated ? styles.barGrad : i === fi ? styles.barFrom : styles.bar} x={i * BAR + 1} y={H - ph} width={BAR - 2} height={ph} />
                  {r.dev && r.dev.sells > 0 && <rect className={styles.soldMark} x={i * BAR + 1} y={H + 3} width={BAR - 2} height={TICK - 3} />}
                </g>
              );
            })}
            </>}
          </svg>
          {fi >= 0 && (
            <span className={styles.fromMark} style={{ left: `${((fi + 0.5) * BAR / w) * 100}%`, transform: `translateX(${(fi + 0.5) / n > 0.85 ? "-100%" : (fi + 0.5) / n < 0.15 ? "0" : "-50%"})` }}>
              this token
            </span>
          )}
          {h && hover && (
            <div className={styles.tip} style={{
                left: hover.x,
                top: hover.y,
                // near an edge the tip opens inward instead of spilling off the card
                transform: `translate(${hover.x < 140 ? "-8px" : hover.x > hover.wBox - 140 ? "calc(-100% + 8px)" : "-50%"}, calc(-100% - 8px))`,
              }} role="status">
              ${h.symbol || h.token.slice(0, 8)} · {h.createdAt ? `${fmtAge(now - h.createdAt)} ago` : "date —"} · {h.graduated ? "graduated" : `curve ${pctOf(h.progressBps / 100)}`}
              {h.dev ? (h.dev.sells > 0 ? ` · dev sold${h.dev.soldBps !== null ? ` ${pct(h.dev.soldBps)}` : ""}` : h.dev.received > 0 ? " · dev held" : " · no dev bag") : " · dev —"}
            </div>
          )}
        </div>
        <div className={styles.xAxis} aria-hidden>
          <span>{first?.createdAt ? `first · ${fmtAge(now - first.createdAt)} ago` : "first"}</span>
          <span className={styles.xMid}>launch date →</span>
          <span>{last?.createdAt ? `latest · ${fmtAge(now - last.createdAt)} ago` : "latest"}</span>
        </div>
      </div>
      <ul className={styles.legend}>
        <li><i className={`${styles.sw} ${styles.swDoor}`} aria-hidden />On the curve{flat ? ": none past 10%" : ""}</li>
        {grad > 0 && <li><i className={`${styles.sw} ${styles.swGrad}`} aria-hidden />Graduated ({grad})</li>}
        <li><i className={`${styles.sw} ${flat ? styles.swSoldCell : styles.swSold}`} aria-hidden />Dev sold ({sold})</li>
        {fi >= 0 && <li><i className={`${styles.sw} ${styles.swFrom}`} aria-hidden />The token you came from</li>}
        {!flat && <li>Height: curve progress, sqrt scale</li>}
      </ul>
    </>
  );
}
