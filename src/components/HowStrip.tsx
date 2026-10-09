"use client";
// The whole game in one hint line, plus a ghost link that opens the 30-second guide.
// `lead` (optional): extra actions rendered before the hint line.
// variant "link": only the guide link (the page already states the rules, e.g. the home H1 subtitle).
import { useRef, useState, type ReactNode } from "react";
import Guide from "./Guide";
import styles from "./HowStrip.module.css";

export default function HowStrip({ lead, variant = "strip" }: { lead?: ReactNode; variant?: "strip" | "link" }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const button = (
    <button ref={opener} type="button" className={`textBtn ${styles.guideBtn}`} onClick={() => setOpen(true)} aria-haspopup="dialog">
      How it works (30s)
    </button>
  );
  const guide = <Guide open={open} onClose={() => setOpen(false)} returnFocus={opener} />;
  if (variant === "link") return <>{button}{guide}</>;
  return (
    <>
      <div className={styles.strip}>
        {lead ? <div className={styles.lead}>{lead}</div> : null}
        <p className={styles.hint}>
          <span>Buy ≥ 0.0003 ETH <i aria-hidden="true">→</i> get in line</span>
          <span className={styles.sep} aria-hidden="true">·</span>
          <span>each new buyer behind you (≥ 0.003 ETH) = <b>+1 pt</b></span>
          <span className={styles.sep} aria-hidden="true">·</span>
          <span>sell <i aria-hidden="true">→</i> your points go to the line</span>
        </p>
        {button}
      </div>
      {guide}
    </>
  );
}
