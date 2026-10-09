"use client";
// "New here?" explainer: five short slides, opened from the 3-step strip. Esc / backdrop / × close it.
// A real modal: focus moves inside, Tab stays inside, the page behind doesn't scroll, and on close
// focus goes back to the button that opened it.
import { useEffect, useRef, useState, type RefObject } from "react";
import Sprite from "./Sprite";
import CtaLink from "./CtaLink";
import type { Skin } from "@/lib/skins";
import styles from "./Guide.module.css";

const SLIDES: { title: string; text: string; cast: Skin[] }[] = [
  {
    title: "This is a line",
    text: "$EXIT is a meme token on the vibe/vibe testnet. Every holder stands in one line in front of a door marked EXIT.",
    cast: ["suit", "getaway", "bag", "hood", "plain"],
  },
  {
    title: "Buy = get in line",
    text: "Buy 0.0003 ETH+ of $EXIT and you join the back. Earlier buyers stand closer to the door.",
    cast: ["hood"],
  },
  {
    title: "New buyers pay you points",
    text: "Every new buyer with 0.003 ETH+ gives +1 point to everyone ahead of them.",
    cast: ["plain", "bag", "getaway"],
  },
  {
    title: "Sell = walk out",
    text: "Sell your bag and you walk out. Your points go to everyone behind you, and they move up.",
    cast: ["ghost"],
  },
  {
    title: "The door opens at 100%",
    text: "When the bonding curve fills, $EXIT graduates to a DEX pool and the door opens.",
    cast: ["doorghost"],
  },
];

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Guide({ open, onClose, returnFocus }: { open: boolean; onClose: () => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const [i, setI] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // the parent re-renders every few seconds (live data): keep onClose in a ref so the slide never resets by itself
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setI(0), 0); // a fresh open starts at slide 1
    const opener = (returnFocus?.current ?? document.activeElement) as HTMLElement | null;
    // focus into the dialog: the primary "Next" button (the last button in the box)
    const f = requestAnimationFrame(() => {
      const box = boxRef.current;
      const primary = box?.querySelector<HTMLElement>("[data-guide-primary]");
      (primary ?? box)?.focus();
    });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key === "ArrowRight") setI((v) => Math.min(SLIDES.length - 1, v + 1));
      if (e.key === "ArrowLeft") setI((v) => Math.max(0, v - 1));
      if (e.key === "Tab") {
        const box = boxRef.current;
        if (!box) return;
        const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!items.length) { e.preventDefault(); box.focus(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !box.contains(active))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !box.contains(active))) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(f);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, returnFocus]);
  // "Next" unmounts on the last slide: keep focus inside the dialog, not on <body>
  useEffect(() => {
    if (!open) return;
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) box.focus();
  }, [open, i]);
  if (!open) return null;
  const s = SLIDES[i];
  const last = i === SLIDES.length - 1;
  return (
    <div className={styles.backdrop} onClick={onClose} role="dialog" aria-modal="true" aria-label="How $EXIT works">
      <div className={styles.box} ref={boxRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className={styles.bar}>
          <span>How $EXIT works <span className={styles.step}>{i + 1}/{SLIDES.length}</span></span>
          <button type="button" onClick={onClose} aria-label="Close guide">×</button>
        </div>
        <div className={styles.stage} aria-hidden>
          {s.cast.map((k, n) => (
            <Sprite key={`${i}-${k}-${n}`} skin={k} scale={k === "doorghost" ? 0.8 : 1} face="right" className={styles.sprite} />
          ))}
          {i === 0 || last ? <span className={styles.door}><b>EXIT</b></span> : null}
        </div>
        <h3 className={styles.title}>{s.title}</h3>
        <p className={styles.text}>{s.text}</p>
        <div className={styles.dots}>
          {SLIDES.map((_, n) => (
            <button key={n} type="button" className={n === i ? styles.dotOn : ""} onClick={() => setI(n)} aria-label={`Step ${n + 1}`} aria-current={n === i ? "step" : undefined} />
          ))}
        </div>
        <div className={styles.nav}>
          <button type="button" className="btn ghost" onClick={() => setI((v) => Math.max(0, v - 1))} disabled={i === 0}>Back</button>
          {last ? <CtaLink className="btn start" /> : <button type="button" className="btn start" data-guide-primary onClick={() => setI((v) => v + 1)}>Next</button>}
        </div>
      </div>
    </div>
  );
}
