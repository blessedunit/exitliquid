"use client";
// Rankings: two leaderboards from the screener (Clean, Red flags), the same row as the home board. The reason
// each token is where it is sits in its own row, so there is no legend and no per-metric tab.
// Clean = A/B on a Full check with a trade in the last 6 h (lib/screener-rules cleanEligible), lower risk first,
// then the busier line.
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Row, RowSkeleton, type Metric } from "@/components/screener/ScreenerRows";
import { agoText, byRiskThenActivity, useScreener } from "@/components/screener/useScreener";
import type { ScreenerBoard, ScreenerRow } from "@/lib/screener-types";
import sc from "@/components/screener/screener.module.css";
import Loader from "@/components/ui/Loader";
import styles from "./lines.module.css";

const PAGE = 25;
const LIMIT = 50;

type Tab = { id: ScreenerBoard; label: string; col: string; metric: (r: ScreenerRow) => Metric };
const score = (tone: "good" | "bad") => (r: ScreenerRow): Metric => ({ value: r.score === null ? "—" : String(Math.round(r.score)), tone });
const TABS: Tab[] = [
  { id: "clean", label: "Clean", col: "Score / 100", metric: score("good") },
  { id: "risk", label: "Red flags", col: "Score / 100", metric: score("bad") },
];
const isTab = (v: string | null): v is ScreenerBoard => TABS.some((t) => t.id === v);

function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  return now;
}

function Head({ col }: { col: string }) {
  return (
    <div className={`${sc.row} ${sc.wide} ${sc.head}`} role="row">
      <span className={sc.th} role="columnheader">#</span>
      <span className={sc.th} role="columnheader" aria-label="Grade" />
      <span className={sc.th} role="columnheader">Token</span>
      <span className={sc.th} role="columnheader">Why</span>
      <span className={`${sc.th} ${sc.thR}`} role="columnheader">{col}</span>
      <span className={`${sc.th} ${sc.thR} ${sc.thHold}`} role="columnheader">Holders</span>
      <span className={`${sc.th} ${sc.thR}`} role="columnheader">Mcap</span>
      <span className={`${sc.th} ${sc.thR}`} role="columnheader">Vol 24h</span>
    </div>
  );
}

function Board({ tab }: { tab: Tab }) {
  const st = useScreener(tab.id, LIMIT);
  // loaded = the snapshot is in, even with nothing graded yet (a fresh start, new rules): that is said, not spun
  const full = useMemo(() => (st.data ? (tab.id === "clean" ? [...st.data.tokens].sort(byRiskThenActivity) : st.data.tokens) : null), [st.data, tab.id]);
  const [more, setMore] = useState(false);
  const rows = full && !more ? full.slice(0, PAGE) : full;
  return (
    <>
    <div role="table" aria-label={tab.label} className={styles.table}>
      <Head col={tab.col} />
      {rows === null ? (
        st.status === "error" ? (
          <p className={styles.note}>Rankings are unavailable right now. They come back on their own.</p>
        ) : (
          Array.from({ length: 10 }, (_, i) => <RowSkeleton key={i} />)
        )
      ) : rows.length ? (
        rows.map((r, i) => <Row key={r.token} r={r} rank={i + 1} metric={tab.metric(r)} />)
      ) : (
        <p className={styles.note}>{st.data && st.data.checked === 0 ? "No grades yet. Tokens are being checked." : "Nothing on this board right now."}</p>
      )}
    </div>
    {full && !more && full.length > PAGE && (
      <p className={styles.note}><button type="button" className={styles.tab} onClick={() => setMore(true)}>Show more</button></p>
    )}
    </>
  );
}

export default function Rankings() {
  const params = useSearchParams();
  const q = params.get("tab");
  const tab: ScreenerBoard = isTab(q) ? q : "clean";
  const cur = TABS.find((t) => t.id === tab) ?? TABS[0];
  const all = useScreener(cur.id, LIMIT);
  const now = useNow();
  const ago = now !== null ? agoText(all.data?.asOf, now) : null;
  // native replaceState: Next syncs useSearchParams with it at once (no server round trip)
  const pick = (id: ScreenerBoard) => window.history.replaceState(null, "", id === "clean" ? "/lines" : `/lines?tab=${id}`);

  return (
    <>
      <div className={styles.head}>
        <h1 className={styles.h1}>Rankings</h1>
        <p className={styles.meta}>
          {all.data && all.data.checked > 0 ? (
            <>
              <b>{all.data.checked.toLocaleString("en-US")}</b> tokens{ago ? ` · updated ${ago}` : ""}
            </>
          ) : all.data ? (
            "No grades yet"
          ) : all.status === "error" ? (
            "Unavailable right now"
          ) : (
            <Loader size="mini" caption="Loading grades…" />
          )}
        </p>
      </div>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Board"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          const n = TABS[(TABS.findIndex((t) => t.id === tab) + 1) % TABS.length];
          pick(n.id);
          (e.currentTarget.querySelector(`[data-tab="${n.id}"]`) as HTMLButtonElement | null)?.focus();
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-tab={t.id}
            aria-selected={t.id === tab}
            tabIndex={t.id === tab ? 0 : -1}
            className={`${styles.tab} ${t.id === tab ? styles.tabOn : ""} ${t.id === "clean" ? styles.tGood : t.id === "risk" ? styles.tBad : ""}`}
            onClick={() => pick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Board key={cur.id} tab={cur} />
    </>
  );
}
