"use client";
// One /api/analytics/<token> poll per token page, shared by the Signals strip and the analytics cards.
// Every 45 s while the tab is visible: under the CDN's 25+15 s and over the engine's 30 s answer cache, so a
// lone viewer's poll triggers (and usually gets) a fresh build instead of the one the previous poll started.
// Everyone reads the same full answer at /api/analytics/<t> (CDN-cached, no cookie).
import { useEffect, useState } from "react";
import type { Analytics } from "@/lib/analytics/types";
import { useTries, type Failed } from "@/components/useTries";

export type AnalyticsState = {
  a: Analytics | null;
  /** null = fine; "loading" = no answer yet (failed tries ask again quietly); "failed" = gave up after
   *  MAX_TRIES, see `failed`. Never "clean". */
  trouble: "loading" | "failed" | "notvibe" | null;
  /** set with trouble "failed": the time of the last try and "Try again" */
  failed: Failed | null;
  /** an answer is shown but it is old (> 3 min) or the last refresh failed: say so next to the numbers */
  stale: boolean;
};

const REFRESH_MS = 120_000; // the free answer is CDN-cached 2 min (api/analytics): asking more often reads the same build
const RETRY_MS = 30_000;
/** an answer older than this is marked stale even when the poll itself worked */
export const STALE_AFTER_MS = 8 * 60_000; // CDN 2 min + stale-while-revalidate 5 min + one poll

/** retryMissing: a 404 is "not read yet" (a v6 launch whose engine may not answer yet), asked again every minute */
export function useTokenAnalytics(token: string | null, { retryMissing = false }: { retryMissing?: boolean } = {}): AnalyticsState {
  const [got, setGot] = useState<Analytics | null>(null);
  const [notVibe, setNotVibe] = useState(false);
  const [failedSince, setFailedSince] = useState(false);
  const { failed, round, start, fail, ok } = useTries(token);
  useEffect(() => {
    if (!token) return;
    const t = token.toLowerCase();
    let alive = true;
    let have = false; // an answer is on screen: failed refreshes mark it stale and keep asking
    start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const ctl = new AbortController();
    const load = () => {
      if (!first && document.visibilityState !== "visible") {
        timer = setTimeout(load, 5_000);
        return;
      }
      first = false;
      fetch(`/api/analytics/${t}`, { signal: ctl.signal })
        .then(async (r) => {
          if (!alive) return;
          if (!r.ok) {
            const missing = r.status === 404;
            setFailedSince(true);
            if (missing && !retryMissing) return setNotVibe(true); // a final answer
            if (have || fail(token)) timer = setTimeout(load, missing ? 60_000 : RETRY_MS);
            return;
          }
          const j = (await r.json()) as Analytics;
          if (!alive) return;
          // the same answer again (a cached build): no new object, so the page doesn't re-render for nothing
          if (j.token === t) setGot((prev) => (prev && prev.token === j.token && prev.computedAt === j.computedAt ? prev : j));
          have = true;
          ok();
          setNotVibe(false);
          setFailedSince(false);
          timer = setTimeout(load, REFRESH_MS);
        })
        .catch(() => {
          if (!alive) return;
          setFailedSince(true);
          if (have || fail(token)) timer = setTimeout(load, RETRY_MS);
        });
    };
    load();
    return () => {
      alive = false;
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [token, retryMissing, round, start, fail, ok]);
  // an answer for another token (the page switched) is never shown
  const a = got && token && got.token === token.toLowerCase() ? got : null;
  // old numbers stay on screen after a failed refresh, but marked (unknown ≠ fresh); the age is re-checked every 15 s
  const now = useNow(15_000);
  const stale = !!a && (failedSince || (now !== null && now - a.computedAt > STALE_AFTER_MS));
  return { a, trouble: a ? null : notVibe ? "notvibe" : failed ? "failed" : "loading", failed: a ? null : failed, stale };
}

/** The clock, ticking every `ms` (null until mounted: nothing time-relative renders on the server). */
export function useNow(ms: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const t0 = setTimeout(() => setNow(Date.now()), 0);
    const i = setInterval(() => setNow(Date.now()), ms);
    return () => {
      clearTimeout(t0);
      clearInterval(i);
    };
  }, [ms]);
  return now;
}

/** "12s" / "4m" / "2h" */
export function ageShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Scroll to a card and flash its border once (chips and the health letter use it). */
// the signal chips point at the old card ids; the report's sections hold those cards (often folded away)
const ALIAS: Record<string, string> = { "an-bundle": "line", "health-title": "line", "an-supply": "holders", "an-exit": "exit", "an-volume": "volume", "an-clones": "dev" };
export function jumpTo(id: string) {
  const hit = document.getElementById(ALIAS[id] ?? "") ?? document.getElementById(id);
  // a heading id (Line Health) points at its card
  const el = (hit?.closest("section") as HTMLElement | null) ?? hit;
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // clear the whole sticky stack: the site header plus the section tabs (sticky under it), measured, not assumed
  const hdr = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hdr-h")) || 56;
  const tabs = document.querySelector<HTMLElement>('nav[aria-label="Sections"]');
  const tabsH = tabs && getComputedStyle(tabs).position === "sticky" ? tabs.getBoundingClientRect().height : 0;
  el.style.scrollMarginTop = `${Math.round(hdr + tabsH + 12)}px`;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  // inline, so it works on cards this module doesn't style (Line Health)
  const prev = el.style.outline;
  el.style.outline = "1px solid var(--exit)";
  el.style.outlineOffset = "2px";
  window.setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = "";
  }, 1400);
}
