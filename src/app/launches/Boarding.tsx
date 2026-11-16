"use client";
// The wait for a list (minimal spec §1.8): skeleton rows the height of real rows, bars the size of the real
// text, one soft left-to-right sweep (Loader's shimmer). Never grey squares that could read as empty data.
import { shimmer } from "@/components/ui/Loader";
import styles from "./launches.module.css";

export default function BoardingRows({ count }: { count: number }) {
  return (
    <div className={styles.boarding} aria-hidden>
      {Array.from({ length: count }, (_, r) => (
        <div key={r} className={`${styles.row} ${styles.ghost}`} role="row" style={{ animationDelay: `${(r % 8) * 0.06}s` }}>
          <div className={styles.cRank}><span className={`${styles.gBar} ${shimmer}`} style={{ width: 12 }} /></div>
          <div className={`${styles.cTok} ${styles.gTok}`}>
            <span className={`${styles.gAv} ${shimmer}`} />
            <span className={styles.gNames}>
              <span className={`${styles.gBar} ${shimmer}`} style={{ width: `${40 + ((r * 37) % 30)}%` }} />
              <span className={`${styles.gBar} ${styles.gSmall} ${shimmer}`} style={{ width: `${55 + ((r * 23) % 30)}%` }} />
            </span>
          </div>
          <div className={styles.cSpark}><span className={`${styles.gBar} ${styles.gNum} ${shimmer}`} /></div>
          <div className={styles.cDoor}><span className={`${styles.gBar} ${shimmer}`} style={{ width: "100%" }} /></div>
          <div className={styles.cIn}><span className={`${styles.gBar} ${styles.gNum} ${shimmer}`} /></div>
          <div className={styles.cVol}><span className={`${styles.gBar} ${styles.gNum} ${shimmer}`} /></div>
          <div className={styles.cBs}><span className={`${styles.gBar} ${styles.gNum} ${shimmer}`} /></div>
          <div className={styles.cStar} />
        </div>
      ))}
    </div>
  );
}
