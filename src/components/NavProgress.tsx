"use client";
// A thin bar at the very top while the next page loads (the nprogress pattern, no library):
// starts on a click on any same-site link to another page, finishes when the new path is on screen.
// A fast page never shows it (the bar only fades in after 100 ms).
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type S = "idle" | "run" | "done";

export default function NavProgress() {
  const path = usePathname();
  const [state, setState] = useState<S>("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const running = useRef(false);

  useEffect(() => {
    const clear = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
    const start = () => {
      clear();
      running.current = true;
      setState("idle");
      // next frame: from 0 to "almost there" (a reset first, so it never runs backwards)
      requestAnimationFrame(() => requestAnimationFrame(() => running.current && setState("run")));
      timers.current.push(setTimeout(() => finish(), 15_000)); // never stuck on screen
    };
    const finish = () => {
      if (!running.current) return;
      running.current = false;
      clear();
      setState("done");
      timers.current.push(setTimeout(() => setState("idle"), 450));
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      let u: URL;
      try {
        u = new URL(a.href, location.href);
      } catch {
        return;
      }
      // same page (a #hash or only the query of this board) is not a page load
      if (u.origin !== location.origin || u.pathname === location.pathname) return;
      start();
    };
    const onDone = () => finish();
    // capture: runs before Next's own Link handler, which calls preventDefault
    document.addEventListener("click", onClick, true);
    window.addEventListener("exit-nav-done", onDone);
    window.addEventListener("popstate", onDone);
    return () => {
      clear();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("exit-nav-done", onDone);
      window.removeEventListener("popstate", onDone);
    };
  }, []);

  // the new page is on screen
  useEffect(() => {
    window.dispatchEvent(new Event("exit-nav-done"));
  }, [path]);

  return <div className="navProgress" data-state={state} aria-hidden />;
}
