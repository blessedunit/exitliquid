"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Portrait } from "@/components/Sprite";
import { useQueue, ago } from "@/lib/useLive";
import { groupFor, short } from "@/lib/queue";
import { fmtTokens } from "@/lib/format";
import { IS_LIVE } from "@/lib/config";
import EmptyState from "@/components/ui/EmptyState";
import styles from "./board.module.css";

const PAGE = 25; // rows per "Show more" click
const PTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 }; // points: always 2 decimals (40.00, 39.89, 35.80)

// The $EXIT line ranked by points (the Exit Run tab was retired).
export default function BoardTabs() {
  const [q, setQ] = useState("");
  const { data, error } = useQueue(20_000, 1000);
  const [shown, setShown] = useState(PAGE);
  const rows = useMemo(() => {
    const l = (data?.line ?? []).filter((entry) => !entry.isCreator);
    l.sort((a, b) => b.lp - a.lp || a.place - b.place);
    const needle = q.trim().toLowerCase();
    const ranked = l.map((entry, index) => ({ entry, rank: index + 1 }));
    return needle ? ranked.filter(({ entry }) => entry.wallet.includes(needle)) : ranked;
  }, [data, q]);
  const visible = rows.slice(0, shown);
  // A column where every row says the same thing adds no information.
  const sameSince = visible.length > 1 && visible.every(({ entry }) => ago(entry.enteredTs) === ago(visible[0].entry.enteredTs));
  const trLine = `${styles.tr} ${sameSince ? styles.noSince : ""}`;

  return (
    <div>
      <div className={styles.bar}>
          <div className={styles.tools}>
            <details className={styles.rule}>
              <summary>How points work</summary>
              <div className={styles.pointsRule}>
                <span>First buy of 0.0003 ETH+ gets a place. A first buy of 0.003 ETH+ gives everyone ahead +1 (not the buyer). Exit within ~1 h revokes that +1. Re-entries earn nothing. On exit, your points split among the people behind.</span>
                <small>Example: you are #2, a new 0.003 ETH buyer enters at #3: you get +1.</small>
              </div>
            </details>
            <input
              className={`input ${styles.find}`}
              type="search"
              placeholder="Find a wallet 0x…"
              aria-label="Find a wallet"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setShown(PAGE);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
      </div>

        <>
          <div className={styles.table} role="table" hidden={!((!data && !error) || visible.length > 0)}>
            <div className={`${trLine} ${styles.th}`} role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">Passenger</span>
              <span role="columnheader">Group</span>
              <span role="columnheader" className={styles.r}>Bag</span>
              <span role="columnheader" className={`${styles.r} ${styles.sorted}`}>Points</span>
              <span role="columnheader" className={styles.r}>In line since</span>
            </div>
            {!data && !error && (
              <div role="status" aria-label="Reading the chain" className={styles.loadingTall}>
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className={styles.skelRow} aria-hidden>
                    <i style={{ width: 20 }} />
                    <i style={{ width: 140 }} />
                    <i style={{ width: 80, marginLeft: "auto" }} />
                  </div>
                ))}
              </div>
            )}
          </div>
          {((!data && error) || data?.unavailable) && (
            <EmptyState boxed={false} title="Retrying…" skin="doorghost" action={<Link className="btn ghost" href="/exit">The $EXIT line →</Link>}>
              The chain isn&apos;t answering right now. The board fills in by itself; nothing here means &ldquo;nobody&rdquo;.
            </EmptyState>
          )}
          {data && !data.unavailable && rows.length === 0 && (
            q ? (
              <EmptyState boxed={false} title="Nobody matches" skin="plain">No wallet in the line starts with that. Paste the full 0x address.</EmptyState>
            ) : (
              <EmptyState boxed={false} title={IS_LIVE ? "Nobody in line yet" : "The line opens at launch"} skin="plain" action={<Link className="btn ghost" href="/exit">How the $EXIT line works →</Link>}>
                {IS_LIVE ? "The first buy of 0.0003 ETH+ takes place #1." : "$EXIT isn't live yet. The board ranks the line by points once it opens."}
              </EmptyState>
            )
          )}
          <div className={styles.table} role="table" aria-label="The line by points">
            {visible.map(({ entry: e, rank }) => (
              <Link key={e.wallet} href={`/t/${e.wallet}`} className={trLine} role="row" prefetch={false}>
                <span role="cell" className={styles.place}>{rank}</span>
                <span role="cell" className={styles.who}>
                  <Portrait skin={e.skin} size={28} className={styles.face} />
                  <span className={styles.mono}>{short(e.wallet)}</span>
                </span>
                <span role="cell" className={styles.group}>
                  {groupFor(e.place)}
                </span>
                <span role="cell" className={`${styles.mono} ${styles.r}`}>{fmtTokens(e.balance)}</span>
                <span role="cell" className={`${styles.mono} ${styles.r} ${styles.pts}`}>{e.lp.toLocaleString("en-US", PTS)}</span>
                <span role="cell" className={`${styles.since} ${styles.r}`}>{ago(e.enteredTs)}</span>
              </Link>
            ))}
          </div>
          {rows.length > shown && (
            <button type="button" className={styles.more} onClick={() => setShown((n) => n + PAGE)}>
              Show {PAGE} more
            </button>
          )}
          {data?.lineTruncated && <p className={styles.note}>First 1,000 of {data.totals.inLine.toLocaleString("en-US")} shown. Use My Lines for anyone further back.</p>}
        </>
    </div>
  );
}
