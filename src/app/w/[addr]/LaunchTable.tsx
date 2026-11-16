"use client";
// Every launch by this wallet: sort by any column, filter by what the dev did. Unknown cells show "—" with a reason.
import Link from "next/link";
import { useMemo, useState } from "react";
import { fmtAge, fmtCompact, pct as pctOf } from "@/lib/format";
import Term from "@/components/ui/Term";
import { eth } from "./fmt";
import styles from "./launches.module.css";

/** sold share: never rounds a real sell down to "0%" or a partial one up to "100%" */
const pct = (bps: number) => (bps > 0 && bps < 100 ? "<1%" : bps < 10_000 && bps >= 9_950 ? ">99%" : `${(bps / 100).toFixed(0)}%`);

export type Row = {
  token: string;
  symbol: string;
  name: string;
  createdAt: number;
  progressBps: number;
  graduated: boolean;
  graduatedAt: number | null;
  hidden: boolean;
  holders: number | null;
  feesEth: number | null;
  /** null = chain read failed */
  dev: {
    received: number; // whole tokens
    moved: number;
    sells: number;
    soldBps: number | null;
    firstSellAfter: number | null; // seconds after launch
    soldBeforeGrad: boolean | null;
  } | null;
};

type SortKey = "new" | "curve" | "holders" | "sold" | "first" | "fees";
type Filter = "all" | "grad" | "sold" | "held" | "nobag";
/** rows shown before "Show all": a serial launcher has dozens */
const FIRST = 10;

const COLS: { key: SortKey | null; label: string; dev?: boolean; fees?: boolean }[] = [
  { key: null, label: "Token" },
  { key: "new", label: "Launched" },
  { key: "curve", label: "Curve" },
  { key: "holders", label: "Holders" },
  { key: null, label: "Dev bag", dev: true },
  { key: "sold", label: "Dev sold", dev: true },
  { key: "first", label: "1st sell", dev: true },
  { key: "fees", label: "Fees ETH", fees: true },
];

/** sort value; null sorts last whatever the direction (unknown is never "smallest") */
function val(r: Row, k: SortKey): number | null {
  switch (k) {
    case "new": return r.createdAt || null;
    case "curve": return r.graduated ? 10_001 : r.progressBps;
    case "holders": return r.holders;
    case "sold": return r.dev ? (r.dev.received > 0 ? (r.dev.soldBps ?? 0) : null) : null;
    case "first": return r.dev?.firstSellAfter ?? null;
    case "fees": return r.feesEth;
  }
}

export default function LaunchTable({ rows, now, chainKnown }: { rows: Row[]; now: number; chainKnown: boolean }) {
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "new", desc: true });
  const [filter, setFilter] = useState<Filter>("all");
  const [all, setAll] = useState(false);

  const counts = useMemo(() => ({
    all: rows.length,
    grad: rows.filter((r) => r.graduated).length,
    sold: chainKnown ? rows.filter((r) => r.dev && r.dev.sells > 0).length : null,
    held: chainKnown ? rows.filter((r) => r.dev && r.dev.received > 0 && r.dev.sells === 0).length : null,
    nobag: chainKnown ? rows.filter((r) => r.dev && r.dev.received === 0).length : null,
  }), [rows, chainKnown]);

  const list = useMemo(() => {
    const f = rows.filter((r) =>
      filter === "all" ? true
      : filter === "grad" ? r.graduated
      : filter === "sold" ? !!r.dev && r.dev.sells > 0
      : filter === "held" ? !!r.dev && r.dev.received > 0 && r.dev.sells === 0
      : !!r.dev && r.dev.received === 0,
    );
    return [...f].sort((a, b) => {
      const x = val(a, sort.k), y = val(b, sort.k);
      if (x === null && y === null) return b.createdAt - a.createdAt;
      if (x === null) return 1;
      if (y === null) return -1;
      return sort.desc ? y - x : x - y;
    });
  }, [rows, filter, sort]);

  const chips: { k: Filter; label: string; n: number | null }[] = [
    { k: "all", label: "All", n: counts.all },
    { k: "grad", label: "Graduated", n: counts.grad },
    { k: "sold", label: "Dev sold", n: counts.sold },
    { k: "held", label: "Dev held", n: counts.held },
    { k: "nobag", label: "No dev bag", n: counts.nobag },
  ];

  // a column with nothing known in it is dropped, not filled with "—"
  const showDev = chainKnown && rows.some((r) => r.dev !== null);
  const showFees = rows.some((r) => r.feesEth !== null);
  const cols = COLS.filter((c) => (!c.dev || showDev) && (!c.fees || showFees));

  // a filter with nothing behind it (0, or unknown when the chain read failed) is left out, not greyed
  const shown = chips.filter((c) => c.k === "all" || (c.n !== null && c.n > 0));

  const onSort = (k: SortKey) => {
    setSort((s) => (s.k === k ? { k, desc: !s.desc } : { k, desc: k !== "first" }));
  };

  return (
    <>
      {shown.length > 1 && <div className={styles.tools} role="group" aria-label="Filter launches">
                {shown.map((c) => (
          <button
            key={c.k}
            type="button"
            className={styles.chip}
            aria-pressed={filter === c.k}
            onClick={() => setFilter(c.k)}
          >
            {c.label} <i>{c.n === null ? "—" : c.n}</i>
          </button>
        ))}
      </div>}
      {list.length === 0 ? (
        <p className={styles.msg}>No launches match this filter.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              {cols.map((c) => {
                const on = c.key !== null && sort.k === c.key;
                return (
                  <th key={c.label} scope="col" aria-sort={on ? (sort.desc ? "descending" : "ascending") : undefined}>
                    {c.key ? (
                      <button type="button" className={`${styles.sortBtn} ${on ? styles.sortOn : ""}`} onClick={() => onSort(c.key!)}>
                        {c.label}{on ? (sort.desc ? " ↓" : " ↑") : ""}
                      </button>
                    ) : c.label === "Dev bag" ? <Term id="dev-bag">Dev bag</Term> : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(all ? list : list.slice(0, FIRST)).map((r) => <LaunchRow key={r.token} r={r} now={now} showDev={showDev} showFees={showFees} />)}
          </tbody>
        </table>
      )}
      {list.length > FIRST && (
        <button type="button" className={styles.more} aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? `Show first ${FIRST}` : `Show all ${list.length}`}
        </button>
      )}
    </>
  );
}

function L({ children }: { children: string }) {
  return <span className={styles.cellLabel}>{children}</span>;
}

function LaunchRow({ r, now, showDev, showFees }: { r: Row; now: number; showDev: boolean; showFees: boolean }) {
  const name = `$${r.symbol || r.token.slice(0, 8)}`;
  const d = r.dev;
  const bag = d ? d.received > 0 : null;
  return (
    <tr>
      <td>
        <span className={styles.tok}>
          {r.hidden ? (
            <span className={styles.sym} title="Hidden by vibe/vibe moderation">{name}</span>
          ) : (
            <Link className={styles.sym} href={`/line/${r.token}`} prefetch={false}>{name}</Link>
          )}
          <span className={styles.name}>{r.hidden ? "hidden by vibe" : r.name || " "}</span>
        </span>
      </td>
      <td className={styles.mAge} title={r.createdAt ? new Date(r.createdAt * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "Launch time unknown"}>
        <L>Launched</L>
        {r.createdAt ? `${fmtAge(now - r.createdAt)} ago` : "—"}
      </td>
      <td className={styles.mCurve}>
        <L>Curve</L>
        {r.graduated ? (
          <span className={styles.gradTxt}>Graduated</span>
        ) : (
          <span className={styles.prog}>
            <span className={styles.track} aria-hidden><span className={styles.fill} style={{ width: `${Math.max(2, r.progressBps / 100)}%` }} /></span>
            {pctOf(r.progressBps / 100)}
          </span>
        )}
      </td>
      <td title={r.holders === null ? "vibe did not report holders" : undefined}>
        <L>Holders</L>
        {r.holders === null ? <span className={styles.dim}>—</span> : fmtCompact(r.holders)}
      </td>
      {showDev && <>
      <td className={bag ? undefined : styles.mQuiet} title={d === null ? "Chain read failed: unknown" : undefined}>
        <L>Dev bag</L>
        {d === null ? <span className={styles.dim}>—</span> : bag ? fmtCompact(d.received) : <span className={styles.dim}>none</span>}
      </td>
      <td className={bag ? undefined : styles.mQuiet} title={d && d.moved > 0 ? `Also moved ${fmtCompact(d.moved)} to other wallets (not a sale)` : undefined}>
        <L>Dev sold</L>
        {d === null ? (
          <span className={styles.dim}>—</span>
        ) : !bag ? (
          <span className={styles.dim} title="No dev bag: nothing to sell.">—</span>
        ) : d.sells > 0 ? (
          <span className={styles.sold}>{d.soldBps === null ? "yes" : pct(d.soldBps)}{d.moved > 0 ? " +moved" : ""}</span>
        ) : (
          <span className={styles.held}>held{d.moved > 0 ? " · moved" : ""}</span>
        )}
      </td>
      <td className={bag && d && d.sells > 0 ? undefined : styles.mQuiet} title={d && d.sells > 0 && d.firstSellAfter === null ? "Sell block time could not be read" : r.graduated && d?.soldBeforeGrad === false ? "First sell came after graduation" : undefined}>
        <L>1st sell</L>
        {d === null || !bag ? (
          <span className={styles.dim} title={d === null ? "Unknown, not zero." : "No dev bag: nothing to sell."}>—</span>
        ) : d.sells === 0 ? (
          <span className={styles.dim}>no sell</span>
        ) : d.firstSellAfter === null ? (
          <span className={styles.dim}>—</span>
        ) : (
          <span className={d.firstSellAfter <= 600 ? styles.sold : undefined}>+{fmtAge(d.firstSellAfter)}</span>
        )}
      </td>
      </>}
      {showFees &&       <td title={r.feesEth === null ? "vibe did not report fees for this token" : "Creator fees accrued: on the curve + sent to the vault + hook"}>
        <L>Fees ETH</L>
        {r.feesEth === null ? <span className={styles.dim}>—</span> : eth(r.feesEth)}
      </td>}
    </tr>
  );
}
