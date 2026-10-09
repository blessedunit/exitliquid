"use client";
// Wide screens: the cast stands quietly in the page margins and steps in as you scroll past.
import { useEffect, useRef } from "react";
import { SPRITES, spriteSrc, type Skin } from "@/lib/skins";
import styles from "./manifesto.module.css";

// left margin faces right (toward the text), right margin faces left; the dev haunts the end.
// three symmetric pairs, each centred inside a section so nobody stands on a divider
// (sec = which manifesto section, at = where in its height the pair's centre sits)
const CAST: { skin: Skin; side: "left" | "right"; sec: number; at: number }[] = [
  { skin: "suit", side: "left", sec: 0, at: 0.3 },
  { skin: "getaway", side: "right", sec: 0, at: 0.3 },
  { skin: "bag", side: "left", sec: 0, at: 0.76 },
  { skin: "hood", side: "right", sec: 0, at: 0.76 },
  { skin: "plain", side: "left", sec: 1, at: 0.5 },
  { skin: "doorghost", side: "right", sec: 1, at: 0.5 },
];

export default function SideCast() {
  const root = useRef<HTMLDivElement>(null);
  // the cast spans <main> (the manifesto sections), measured from the page, so no wrapper changes the section rules
  useEffect(() => {
    const el = root.current;
    const main = el?.parentElement;
    if (!el || !main) return;
    const fit = () => {
      const r = main.getBoundingClientRect();
      el.style.top = `${r.top + window.scrollY}px`;
      el.style.height = `${r.height}px`;
      const sections = main.querySelectorAll<HTMLElement>(":scope > section");
      // a pair shares one floor line: feet level, the taller one sets it
      const figs = [...el.querySelectorAll<HTMLElement>("[data-sec]")];
      const tallest = new Map<string, number>();
      figs.forEach((f) => { const k = `${f.dataset.sec}:${f.dataset.at}`; tallest.set(k, Math.max(tallest.get(k) ?? 0, f.offsetHeight)); });
      figs.forEach((fig) => {
        const sec = sections[Number(fig.dataset.sec)];
        if (!sec) return;
        const sr = sec.getBoundingClientRect();
        const centre = sr.top - r.top + sr.height * Number(fig.dataset.at);
        const floor = centre + (tallest.get(`${fig.dataset.sec}:${fig.dataset.at}`) ?? fig.offsetHeight) / 2;
        fig.style.top = `${Math.round(floor - fig.offsetHeight)}px`;
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(main);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const figs = root.current?.querySelectorAll<HTMLElement>(`.${styles.sideFig}`);
    if (!figs?.length) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add(styles.sideIn)),
      { rootMargin: "0px 0px -12% 0px" },
    );
    figs.forEach((f) => io.observe(f));
    return () => io.disconnect();
  }, []);
  return (
    <div ref={root} className={styles.sideCast} aria-hidden>
      {CAST.map(({ skin, side, sec, at }) => {
        const s = SPRITES[skin];
        const flip = (side === "left" ? "right" : "left") !== s.faces;
        // the dev ghost is drawn at a larger pixel size: keep it about as tall as the others
        const k = skin === "doorghost" ? 0.62 : 1;
        return (
          <div key={skin} className={`${styles.sideFig} ${side === "left" ? styles.sideLeft : styles.sideRight}`} data-sec={sec} data-at={at}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={spriteSrc(skin, 8)}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
              className="pixelated"
              style={{ width: `calc(${s.w * k}px * var(--cast-s))`, height: `calc(${s.h * k}px * var(--cast-s))`, transform: flip ? "scaleX(-1)" : undefined }}
            />
            <span className={styles.sideName}>{s.name}</span>
          </div>
        );
      })}
    </div>
  );
}
