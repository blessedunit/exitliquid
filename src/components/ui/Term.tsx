"use client";
// <Term id="snipers">Snipers</Term>: a glossary word with a popover (spec §1.1).
// <Term id="health" icon />: only a small ⓘ after the previous text.
// Desktop: hover or focus opens it. Touch: a tap toggles it. Esc / an outside tap closes it.
// One popover at a time. It lives in a portal with position: fixed and is clamped to the viewport,
// so it never widens the page. The trigger is a span[role=button] and never fires the parent's click.
// Do NOT nest it inside a <button> or <a>: an interactive element inside another one is invalid HTML/ARIA
// (screen readers merge the names, keyboards get two stops for one target). Put it next to the control,
// e.g. <span class="chipWrap"><button>Grade A–B · 12</button><Term id="health" icon /></span>.
import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { gloss, type GlossaryId } from "@/lib/glossary";
import s from "./Term.module.css";

const OPEN_EVT = "el-term-open";
const W = 280;
const PAD = 8;

type Props = { id: GlossaryId; children?: React.ReactNode; icon?: boolean; className?: string };

export default function Term({ id, children, icon = false, className }: Props) {
  const e = gloss(id);
  const uid = useId();
  const tipId = `${uid}-tip`;
  const trigger = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const hideT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false); // opened by tap/click: hover-out doesn't close it
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const show = useCallback((pin = false) => {
    if (hideT.current) clearTimeout(hideT.current);
    window.dispatchEvent(new CustomEvent(OPEN_EVT, { detail: uid }));
    setOpen(true);
    if (pin) setPinned(true);
  }, [uid]);
  const hide = useCallback(() => {
    if (hideT.current) clearTimeout(hideT.current);
    setOpen(false);
    setPinned(false);
  }, []);
  const hideSoon = () => {
    if (pinned) return;
    if (hideT.current) clearTimeout(hideT.current);
    hideT.current = setTimeout(() => setOpen(false), 120);
  };

  // one open at a time
  useEffect(() => {
    const other = (ev: Event) => {
      if ((ev as CustomEvent<string>).detail !== uid) hide();
    };
    window.addEventListener(OPEN_EVT, other);
    return () => window.removeEventListener(OPEN_EVT, other);
  }, [uid, hide]);

  // Esc, outside tap, scroll/resize reposition
  useEffect(() => {
    if (!open) return;
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        hide();
        trigger.current?.focus();
      }
    };
    const down = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (trigger.current?.contains(t) || pop.current?.contains(t)) return;
      hide();
    };
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down);
    };
  }, [open, hide]);

  const place = useCallback(() => {
    const el = trigger.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = Math.min(W, vw - PAD * 2);
    const left = Math.max(PAD, Math.min(r.left + r.width / 2 - w / 2, vw - w - PAD));
    const h = pop.current?.offsetHeight ?? 110;
    const up = r.bottom + 6 + h > vh - PAD && r.top - 6 - h > PAD;
    setPos({ left, top: up ? r.top - 6 - h : r.bottom + 6, up });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // second pass once the popover has its real height
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  const fine = () => typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;

  const toggle = (ev: React.SyntheticEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (open && pinned) hide();
    else show(true);
  };

  return (
    <>
      <span
        ref={trigger}
        role="button"
        tabIndex={0}
        aria-label={icon ? `What is ${e.term}?` : undefined}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={open}
        className={`${icon ? s.icon : s.term} ${className ?? ""}`}
        onClick={toggle}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") toggle(ev);
        }}
        onPointerEnter={() => {
          if (fine()) show();
        }}
        onPointerLeave={() => {
          if (fine()) hideSoon();
        }}
        onFocus={() => show()}
        onBlur={(ev) => {
          if (!pop.current?.contains(ev.relatedTarget as Node | null)) hide();
        }}
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        {icon ? <span aria-hidden>i</span> : (children ?? e.term)}
      </span>
      {mounted && open &&
        createPortal(
          <div
            ref={pop}
            id={tipId}
            role="tooltip"
            className={s.pop}
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: `min(${W}px, calc(100vw - ${PAD * 2}px))` }}
            onPointerEnter={() => {
              if (hideT.current) clearTimeout(hideT.current);
            }}
            onPointerLeave={hideSoon}
            onClick={(ev) => ev.stopPropagation()}
          >
            <b className={s.popTerm}>{e.term}</b>
            <span className={s.popShort}>{e.short}</span>
            {e.more && (
              <Link className={s.popMore} href={e.more} prefetch={false} onClick={hide}>
                More →
              </Link>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
