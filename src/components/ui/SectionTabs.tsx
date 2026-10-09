"use client";
// Sticky section tabs for long pages (spec §1.1): <SectionTabs items={[{ id: "risk", label: "Risk" }]} />
// The active tab follows the scroll (IntersectionObserver on the elements with those ids).
// A click scrolls smoothly (instantly under reduced motion) and writes the hash with replaceState.
import { useEffect, useRef, useState } from "react";
import s from "./SectionTabs.module.css";

export type SectionTab = { id: string; label: React.ReactNode };

export default function SectionTabs({ items, className, label = "Sections" }: { items: SectionTab[]; className?: string; label?: string }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");
  const lock = useRef(0); // ignore the observer while a click-scroll is running
  const row = useRef<HTMLDivElement>(null);
  const ids = items.map((i) => i.id).join("|");

  useEffect(() => {
    const els = ids.split("|").map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
    if (!els.length) return;
    const pick = () => {
      if (Date.now() < lock.current) return;
      const hdr = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hdr-h")) || 56;
      const edge = hdr + 64;
      // the last section whose top has passed the edge under the sticky bars
      let cur = els[0].id;
      for (const el of els) if (el.getBoundingClientRect().top - edge <= 1) cur = el.id;
      // at the very bottom the last section wins even if it is short
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = els[els.length - 1].id;
      setActive(cur);
    };
    const io = new IntersectionObserver(pick, { rootMargin: "-40% 0px -50% 0px", threshold: [0, 1] });
    els.forEach((el) => io.observe(el));
    window.addEventListener("scroll", pick, { passive: true });
    pick();
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", pick);
    };
  }, [ids]);

  // keep the active tab visible inside the phone scroller
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>(`[data-sec="${CSS.escape(active)}"]`);
    const box = row.current;
    if (!el || !box || box.scrollWidth <= box.clientWidth) return;
    const l = el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2;
    box.scrollTo({ left: Math.max(0, l), behavior: "smooth" });
  }, [active]);

  const go = (ev: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    ev.preventDefault();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    lock.current = Date.now() + 900;
    setActive(id);
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    try {
      history.replaceState(history.state, "", `#${id}`);
    } catch {
      /* sandboxed */
    }
  };

  return (
    <nav aria-label={label} className={`${s.bar} ${className ?? ""}`}>
      <div ref={row} className={`fadeX ${s.row}`}>
        {items.map((i) => (
          <a
            key={i.id}
            href={`#${i.id}`}
            data-sec={i.id}
            className={s.tab}
            aria-current={active === i.id ? "location" : undefined}
            onClick={(ev) => go(ev, i.id)}
          >
            {i.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
