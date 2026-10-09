// 24 h price sparkline, 56x16 (spec §3.1): one polyline on a 0..1000 grid (see Spark in lib/launches).
// Green when the last close is above the first in the window, red below, grey when flat or unknown.
// undefined = still loading, null = unknown right now, empty = no trade in the last 24 h.
import styles from "./Sparkline.module.css";

export type SparkData = { x: number[]; y: number[]; chgBps: number | null };

const W = 56;
const H = 16;
const PAD = 2; // keeps a 1.5 px stroke inside the box at the extremes

function pctText(bps: number) {
  const p = Math.abs(bps / 100);
  return `${p >= 1000 ? `${(p / 1000).toFixed(1)}k` : p >= 100 ? p.toFixed(0) : p.toFixed(1)}%`;
}

export default function Sparkline({ data, className }: { data: SparkData | null | undefined; className?: string }) {
  const cls = `${styles.sp} ${className ?? ""}`;
  if (data === undefined) {
    return <svg className={`${cls} ${styles.wait}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="24 h price chart loading"><rect className={styles.base} x="0" y={H / 2} width={W} height="1" /></svg>;
  }
  if (data === null) {
    return (
      <svg className={cls} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="24 h price chart unknown right now">
        <title>24 h price chart unknown right now</title>
        <rect className={styles.base} x={W / 2 - 6} y={H / 2} width="12" height="1" />
      </svg>
    );
  }
  if (!data.x.length) {
    return (
      <svg className={cls} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="No trades in the last 24 h">
        <title>No trades in the last 24 h</title>
        <rect className={styles.none} x="0" y={H / 2} width={W} height="1" />
      </svg>
    );
  }
  const c = data.chgBps;
  const dir = c === null || c === 0 ? "flat" : c > 0 ? "up" : "down";
  const pts = data.x
    .map((x, i) => {
      const px = PAD + ((W - 2 * PAD) * x) / 1000;
      const py = H - PAD - ((H - 2 * PAD) * (data.y[i] ?? 500)) / 1000;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
  const label =
    dir === "flat" ? "24 h price: flat" : `24 h price: ${dir} ${pctText(c ?? 0)} from the first to the last trade of the day`;
  return (
    <svg className={`${cls} ${styles[dir]}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <title>{label}</title>
      <polyline points={pts} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
