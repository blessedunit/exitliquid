"use client";
// "Since your last visit" for the Watchlist: one small snapshot per pinned token in localStorage
// ("exit.watch.seen": {token: {t, holders, doorBps, price, g?, st?}}, at most 50, newest kept).
// Storage can be missing or throw: then there is simply no "last visit" (nothing is invented).
import { useSyncExternalStore } from "react";
import type { LaunchCard as Card } from "@/lib/launches";

export type Seen = {
  /** when this was seen (ms) */
  t: number;
  holders: number | null;
  doorBps: number;
  /** ETH per token; null = unknown (v6, no trade yet) */
  price: number | null;
  /** graduated at that time */
  g?: boolean;
  /** stalled at that time */
  st?: boolean;
};
export type SeenMap = Readonly<Record<string, Seen>>;

const KEY = "exit.watch.seen";
const MAX = 50;
const EMPTY: SeenMap = {};
const listeners = new Set<() => void>();
let cache: SeenMap | null = null;

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function read(): SeenMap {
  if (cache) return cache;
  const out: Record<string, Seen> = {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!/^0x[0-9a-f]{40}$/.test(k) || !x || typeof x !== "object") continue;
        const o = x as Record<string, unknown>;
        const t = n(o.t);
        const door = n(o.doorBps);
        if (t === null || door === null) continue;
        out[k] = { t, holders: n(o.holders), doorBps: door, price: n(o.price), g: o.g === true, st: o.st === true };
      }
    }
  } catch {
    /* blocked or broken storage: no last visit */
  }
  cache = out;
  return cache;
}

function write(next: Record<string, Seen>) {
  // keep the 50 most recently seen
  const kept = Object.entries(next).sort((a, b) => b[1].t - a[1].t).slice(0, MAX);
  cache = Object.fromEntries(kept);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked: the deltas still work for this visit */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSeen(): SeenMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** read once (for a frozen baseline) */
export const readSeen = (): SeenMap => read();

const snap = (c: Card, t: number): Seen => ({
  t,
  holders: c.holders,
  doorBps: c.graduated ? 10_000 : c.progressBps,
  price: c.priceEth,
  g: c.graduated,
  st: c.etaStalled,
});

/** the user has now seen these cards: they become the next "last visit" */
export function markSeen(cards: Card[]) {
  if (!cards.length) return;
  const t = Date.now();
  const next: Record<string, Seen> = { ...read() };
  for (const c of cards) next[c.token] = snap(c, t);
  write(next);
}

/** a fresh pin starts its history now (never overwrites an older snapshot) */
export function seedSeen(c: Card) {
  const cur = read();
  if (cur[c.token]) return;
  write({ ...cur, [c.token]: snap(c, Date.now()) });
}

/* ---------------- deltas ---------------- */

export type Delta = {
  since: number;
  /** null = unknown on either side (never shown as 0) */
  holders: number | null;
  doorBps: number;
  /** relative price change in bps; null = unknown */
  priceBps: number | null;
  graduated: boolean;
  stalled: boolean;
};

export function deltaOf(c: Card, s: Seen | undefined): Delta | null {
  if (!s) return null;
  const nowDoor = c.graduated ? 10_000 : c.progressBps;
  return {
    since: s.t,
    holders: c.holders !== null && s.holders !== null ? c.holders - s.holders : null,
    doorBps: nowDoor - s.doorBps,
    priceBps: c.priceEth !== null && s.price !== null && s.price > 0 ? Math.round((c.priceEth / s.price - 1) * 10_000) : null,
    graduated: c.graduated && !s.g,
    stalled: c.etaStalled && !s.st && !c.graduated,
  };
}

/** worth a "new" on the tab: anything a trader would want to look at */
export function moved(d: Delta | null): boolean {
  if (!d) return false;
  return d.graduated || d.stalled || (d.holders !== null && d.holders !== 0) || Math.abs(d.doorBps) >= 10 || (d.priceBps !== null && Math.abs(d.priceBps) >= 100);
}
