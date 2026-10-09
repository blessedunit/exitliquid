"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

// The header's two sheets (<details id="site-menu"> burger, <details id="site-search"> phone search):
// close on route change, Escape and a tap outside; opening one closes the other; the search sheet
// focuses its field when it opens.
const IDS = ["site-menu", "site-search"] as const;
const get = (id: string) => document.getElementById(id) as HTMLDetailsElement | null;

// .fadeX strips (tab rows, chip rows): mark them scrolled / at the end so globals.css fades only the
// edge that really hides something (the first label is never cut at rest).
function markFade(el: Element) {
  if (!(el instanceof HTMLElement) || !el.classList.contains("fadeX")) return;
  const x = el.scrollLeft;
  if (x > 2) el.dataset.scrolled = "";
  else delete el.dataset.scrolled;
  if (x + el.clientWidth >= el.scrollWidth - 2) el.dataset.end = "";
  else delete el.dataset.end;
}
const markAllFades = () => document.querySelectorAll(".fadeX").forEach(markFade);

export default function MenuCloser() {
  const pathname = usePathname();
  useEffect(() => {
    IDS.forEach((id) => {
      const d = get(id);
      if (d) d.open = false;
    });
    // strips render with the page and may fill in a moment later (data, fonts)
    markAllFades();
    const t = window.setTimeout(markAllFades, 600);
    return () => window.clearTimeout(t);
  }, [pathname]);
  // home: the header search hides while the hero search (#home-search) is on screen (spec §2 "Merge"),
  // so one page never shows two search boxes at once. visibility only: the header never shifts.
  useEffect(() => {
    const root = document.documentElement;
    let io: IntersectionObserver | null = null;
    const attach = () => {
      const el = document.getElementById("home-search")?.closest("form");
      if (!el || io) return;
      io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) root.dataset.heroSearch = "";
        else delete root.dataset.heroSearch;
      }, { rootMargin: "-56px 0px 0px 0px" });
      io.observe(el);
    };
    attach();
    const t = window.setTimeout(attach, 800);
    return () => {
      window.clearTimeout(t);
      io?.disconnect();
      delete root.dataset.heroSearch;
    };
  }, [pathname]);
  useEffect(() => {
    const onScroll = (e: Event) => markFade(e.target as Element);
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(markAllFades);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const id of IDS) {
        const d = get(id);
        if (!d?.open) continue;
        d.open = false;
        d.querySelector("summary")?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      for (const id of IDS) {
        const d = get(id);
        if (d?.open && !d.contains(e.target as Node)) d.open = false;
      }
    };
    const onToggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.open) return;
      IDS.forEach((id) => {
        const o = get(id);
        if (o && o !== d) o.open = false;
      });
      if (d.id === "site-search") requestAnimationFrame(() => d.querySelector<HTMLInputElement>("input")?.focus());
    };
    const ds = IDS.map(get).filter((x): x is HTMLDetailsElement => !!x);
    ds.forEach((d) => d.addEventListener("toggle", onToggle));
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      ds.forEach((d) => d.removeEventListener("toggle", onToggle));
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, []);
  return null;
}
