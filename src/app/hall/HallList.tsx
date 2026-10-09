"use client";
import Link from "next/link";
import { useQueue, ago } from "@/lib/useLive";
import { short } from "@/lib/queue";
import EmptyState from "@/components/ui/EmptyState";
import styles from "../board/board.module.css";

export default function HallList() {
  const { data, error } = useQueue(20_000, 50);
  const exits = data?.exits ?? [];
  if ((!data && error) || data?.unavailable) {
    return (
      <EmptyState boxed={false} title="Retrying…" skin="doorghost" action={<Link className="btn ghost" href="/exit">The $EXIT line →</Link>}>
        The chain isn&apos;t answering right now. The hall fills in by itself; nothing here means &ldquo;nobody left&rdquo;.
      </EmptyState>
    );
  }
  if (data && exits.length === 0) {
    return (
      <EmptyState boxed={false} title="Nobody has left. Yet." skin="ghost" action={<Link className="btn ghost" href="/board">See who is in line →</Link>}>
        When someone sells 95% of their bag, they walk out and land here. Everyone behind them moves up.
      </EmptyState>
    );
  }
  return (
    <div className={styles.table} role="table">
      <div className={`${styles.tr} ${styles.trHall} ${styles.th}`} role="row">
        <span role="columnheader">Passenger</span>
        <span role="columnheader">Exited at</span>
        <span role="columnheader">Moved up</span>
        <span role="columnheader">Points handed back</span>
        <span role="columnheader">When</span>
      </div>
      {!data && (
        <div role="status" aria-label="Reading the chain">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={styles.skelRow} aria-hidden>
              <i style={{ width: 120 }} />
              <i style={{ width: 60 }} />
              <i style={{ width: 80, marginLeft: "auto" }} />
            </div>
          ))}
        </div>
      )}
      {exits.map((x, i) => (
        <Link
          key={`${x.wallet}-${i}`}
          href={`/t/${x.wallet}`}
          className={`${styles.tr} ${styles.trHall}`}
          role="row"
          prefetch={false}
        >
          <span role="cell" className={styles.mono}>{short(x.wallet)}</span>
          <span role="cell" className={`${styles.place} ${styles.exitPlace}`}>
            #{x.exitedAtPlace}
          </span>
          <span role="cell" className={styles.mono}>
            {x.behindAtExit.toLocaleString("en-US")} {x.behindAtExit === 1 ? "person" : "people"}
          </span>
          <span role="cell" className={styles.mono}>{x.lpReleased.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {x.lpReleased === 1 ? "pt" : "pts"}</span>
          <span role="cell" className={styles.since}>{ago(x.exitedTs)}</span>
        </Link>
      ))}
    </div>
  );
}
