"use client";
// Who walked out of the $EXIT line (the former /hall page), as a compact block at the bottom of /exit.
// Unknown is said in words: an unread chain is never shown as "nobody left".
import Link from "next/link";
import { useQueue, ago } from "@/lib/useLive";
import { shortAddr } from "@/lib/format";
import ShowMore from "@/components/ui/ShowMore";
import Unreadable from "@/components/token/Unreadable";
import Loader from "@/components/ui/Loader";
import styles from "./home.module.css";

export default function HallList() {
  const { data, failed } = useQueue(20_000, 50);
  const exits = data?.exits ?? [];
  if (!data && failed) return <Unreadable failed={failed} what="the chain" className={styles.hallMsg} />;
  if (!data) return <Loader caption="Reading the chain…" className={styles.hallMsg} />;
  if (exits.length === 0) return <p className={styles.hallMsg}>Nobody has left yet.</p>;
  return (
    <>
      <p className={styles.hallMsg}>
        {data.totals.exited.toLocaleString("en-US")} walked out · {data.totals.inLine.toLocaleString("en-US")} still in line
      </p>
      <ShowMore count={exits.length} initial={10} label="exits" className={styles.hallMore}>
        {(n) => (
          <div className={styles.hall} role="table" aria-label="Wallets that walked out">
            <div className={`${styles.hallRow} ${styles.hallHead}`} role="row">
              <span role="columnheader">Wallet</span>
              <span role="columnheader">Left from</span>
              <span role="columnheader">Moved up</span>
              <span role="columnheader">When</span>
            </div>
            {exits.slice(0, n).map((x, i) => (
              <Link key={`${x.wallet}-${i}`} href={`/t/${x.wallet}`} className={styles.hallRow} role="row" prefetch={false}>
                <span role="cell">{shortAddr(x.wallet)}</span>
                <span role="cell" className={styles.hallPlace}>#{x.exitedAtPlace}</span>
                <span role="cell">{x.behindAtExit.toLocaleString("en-US")} {x.behindAtExit === 1 ? "person" : "people"}</span>
                <span role="cell" className={styles.hallWhen}>{ago(x.exitedTs)}</span>
              </Link>
            ))}
          </div>
        )}
      </ShowMore>
    </>
  );
}
