"use client";
// One client store for the screener snapshot (/api/screener, static copy /screener.json as the fallback).
// Every component asking for the same URL shares one request and one poll; a failed refresh keeps the last
// good snapshot on screen (unknown stays unknown, never an empty "nothing found").
import { useCallback, useSyncExternalStore } from "react";
import { cleanEligible } from "@/lib/screener-rules";
import type { ScreenerBoard, ScreenerResponse, ScreenerRow } from "@/lib/screener-types";

export type ScreenerState = { data: ScreenerResponse | null; status: "loading" | "ok" | "error" };

const POLL_MS = 60_000;
type Entry = { state: ScreenerState; subs: Set<() => void>; timer: ReturnType<typeof setTimeout> | null; inflight: boolean };
const store = new Map<string, Entry>();
const INIT: ScreenerState = { data: null, status: "loading" };

function entry(url: string): Entry {
  let e = store.get(url);
  if (!e) {
    e = { state: INIT, subs: new Set(), timer: null, inflight: false };
    store.set(url, e);
  }
  return e;
}

const valid = (j: unknown): j is ScreenerResponse => !!j && typeof j === "object" && Array.isArray((j as ScreenerResponse).tokens);

async function get(url: string): Promise<ScreenerResponse | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) return null;
    const j: unknown = await r.json();
    return valid(j) ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function boardOf(url: string): { board: string | null; limit: number | null } {
  const u = new URL(url, "http://x");
  const l = Number(u.searchParams.get("limit"));
  return { board: u.searchParams.get("board"), limit: Number.isFinite(l) && l > 0 ? l : null };
}

async function load(url: string) {
  const e = entry(url);
  if (e.inflight) return;
  e.inflight = true;
  let j = await get(url);
  // the live route is down (or this is a static copy): read the snapshot file and cut the board here
  if (!j) {
    const all = await get("/screener.json");
    if (all) {
      const { board, limit } = boardOf(url);
      j = board ? { ...all, board: board as ScreenerBoard, tokens: localBoard(all.tokens, board as ScreenerBoard).slice(0, limit ?? 50) } : all;
    }
  }
  e.inflight = false;
  e.state = j ? { data: j, status: "ok" } : { data: e.state.data, status: e.state.data ? "ok" : "error" };
  e.subs.forEach((f) => f());
  if (e.subs.size) {
    if (e.timer) clearTimeout(e.timer);
    // nothing yet (the engine is still warming): ask again sooner
    e.timer = setTimeout(() => void load(url), j && j.tokens.length ? POLL_MS : 15_000);
  }
}

/** the Clean board's order: the lower risk first (letter, then score), then the busier line (trades, real holders) */
export function byRiskThenActivity(a: ScreenerRow, b: ScreenerRow): number {
  return (a.grade ?? "Z").localeCompare(b.grade ?? "Z") || (b.score ?? -1) - (a.score ?? -1)
    || (b.metrics.trades24h ?? -1) - (a.metrics.trades24h ?? -1) || (b.metrics.holders ?? -1) - (a.metrics.holders ?? -1);
}

/** the board cut the server makes (lib/screener board(), same filters), for the static fallback only */
function localBoard(rows: ScreenerRow[], board: ScreenerBoard): ScreenerRow[] {
  const m = (r: ScreenerRow) => r.metrics;
  const desc = (f: (r: ScreenerRow) => number | null) => (a: ScreenerRow, b: ScreenerRow) => (f(b) ?? -1) - (f(a) ?? -1);
  switch (board) {
    case "clean":
      return rows.filter((r) => r.verdict === "clean" && cleanEligible(m(r))).sort(byRiskThenActivity);
    case "risk":
      return rows.filter((r) => r.verdict === "risk" && ((m(r).trades24h ?? 0) >= 5 || (m(r).holders ?? 0) >= 10)).sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
    case "sniped":
      return rows.filter((r) => (m(r).snipers20 ?? 0) > 0).sort(desc((r) => m(r).snipers20));
    case "devdump":
      return rows.filter((r) => (m(r).devSoldPct ?? 0) >= 1).sort(desc((r) => m(r).devSoldPct));
    case "realvol":
      return rows.filter((r) => (m(r).realVol24h ?? 0) > 0).sort(desc((r) => m(r).realVol24h));
    case "whales":
      return rows.filter((r) => m(r).top10Pct !== null && (m(r).holders ?? 0) >= 20).sort(desc((r) => m(r).top10Pct));
  }
}

function screenerUrl(board?: ScreenerBoard, limit?: number): string {
  const q = new URLSearchParams();
  if (board) q.set("board", board);
  if (limit) q.set("limit", String(limit));
  const s = q.toString();
  return `/api/screener${s ? `?${s}` : ""}`;
}

export function useScreener(board?: ScreenerBoard, limit?: number): ScreenerState {
  const url = screenerUrl(board, limit);
  // a stable subscribe: an inline one is a new function on every render, so React would unsubscribe and
  // subscribe again each time, and the unsubscribe of the only reader clears the poll timer for good
  const subscribe = useCallback(
    (f: () => void) => {
      const e = entry(url);
      e.subs.add(f);
      if (!e.timer && !e.inflight) void load(url);
      return () => {
        e.subs.delete(f);
        if (!e.subs.size && e.timer) {
          clearTimeout(e.timer);
          e.timer = null;
        }
      };
    },
    [url],
  );
  return useSyncExternalStore(subscribe, () => entry(url).state, () => INIT);
}

/** "3 min ago" */
export function agoText(ms: number | null | undefined, now: number): string | null {
  if (!ms) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
