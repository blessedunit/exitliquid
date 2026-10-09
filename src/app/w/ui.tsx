"use client";
// TagTip: a badge (wallet tag, dev fact) whose own detail opens in a popover on hover / focus / tap.
// The shared <Term> (components/ui/Term) only takes glossary ids; these details are per-wallet, so they live here.
// Same behaviour as Term: one popover at a time, Esc / outside tap closes, kept inside the viewport.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import u from "./ui.module.css";

/* ---------------- TagTip ---------------- */

const OPEN_EVT = "el-tagtip-open";

export type Tip = { term: string; short: string; more?: string };

export function TagTip({ tip, children }: { tip: Tip; children: React.ReactNode }) {
  const g = tip;
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);

  // one popover at a time
  useEffect(() => {
    const other = (e: Event) => { if ((e as CustomEvent).detail !== tipId) setOpen(false); };
    window.addEventListener(OPEN_EVT, other);
    return () => window.removeEventListener(OPEN_EVT, other);
  }, [tipId]);
  const show = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_EVT, { detail: tipId }));
    setOpen(true);
  }, [tipId]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const out = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", out);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", out);
    };
  }, [open]);

  // keep the popover inside the viewport (never a sideways scroll)
  useLayoutEffect(() => {
    if (!open || !pop.current) return setShift(0);
    const r = pop.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const over = r.right - shift - (vw - 8);
    const under = 8 - (r.left - shift);
    setShift(over > 0 ? -over : under > 0 ? under : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <span
      ref={wrap}
      className={u.term}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onClick={stop}
    >
      <span
        className={u.termPlain}
        tabIndex={0}
        role="button"
        aria-describedby={open ? tipId : undefined}
        onFocus={show}
        onBlur={(e) => { if (!wrap.current?.contains(e.relatedTarget as Node)) setOpen(false); }}
        onClick={(e) => { stop(e); if (open) setOpen(false); else show(); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stop(e); if (open) setOpen(false); else show(); } }}
      >
        {children}
      </span>
      {open && (
        <span ref={pop} id={tipId} role="tooltip" className={u.pop} style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
          <b>{g.term}</b>
          <span>{g.short}</span>
          {g.more && <a href={g.more}>More →</a>}
        </span>
      )}
    </span>
  );
}
