"use client";
import { useEffect, useState } from "react";
import type { MoodResponse, QueueResponse } from "./types";
import { takePrimed } from "./prime";

// Polls the line every `ms` while the tab is visible.
export function useQueue(ms = 20_000, limit = 200, token: string | null = null) {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let last = 0; // when the last answer came in (focus / tab-back only refetches a line older than 5 s)
    let good = false; // a real line is on screen: an "unavailable" answer must not wipe it
    const ctl = new AbortController();
    const tick = async () => {
      if (!alive || running) return;
      running = true;
      if (document.visibilityState === "visible") {
        try {
          const url = token ? `/api/queue/${token}?limit=${limit}` : `/api/queue?limit=${limit}`;
          // the board warmed this line on hover: take that answer instead of asking again
          const warm = last === 0 ? await takePrimed(url)?.catch(() => null) : null;
          const r = warm ?? (await fetch(url, { cache: "no-store", signal: ctl.signal }));
          if (r.status === 404) {
            // not a vibe/vibe token: a final answer, stop asking
            if (alive) setError("not_vibe");
            running = false;
            return;
          }
          if (!r.ok) throw new Error(String(r.status));
          const j = (await r.json()) as QueueResponse;
          last = Date.now();
          if (alive) {
            if (j.unavailable && good) {
              // stale-while-revalidate: the last good line stays on screen, "Reconnecting…" shows over it
              setError("unavailable");
            } else {
              setData(j);
              setError(null);
              good = !j.unavailable;
            }
          }
        } catch (e) {
          if (alive) setError(String(e));
        }
      }
      running = false;
      if (alive) timer = setTimeout(tick, ms);
    };
    const wake = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 5_000) return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    tick();
    return () => {
      alive = false;
      ctl.abort(); // leaving the page: an old request can't land on the next one
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, [ms, limit, token]);
  return { data, error };
}

export function useMood() {
  const [mood, setMood] = useState<MoodResponse | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/mood")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && setMood(j))
      .catch(() => alive && setMood(null));
    return () => {
      alive = false;
    };
  }, []);
  return mood;
}

export function ago(ts: number) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
