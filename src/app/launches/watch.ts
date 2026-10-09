"use client";
// Watchlist: starred token addresses in localStorage ("exit.watch"), newest first, max 50.
// Storage can be missing or throw (private mode, blocked site data): then the list is simply empty.
import { useSyncExternalStore } from "react";

const KEY = "exit.watch";
const MAX = 50;
const EMPTY: string[] = [];
const listeners = new Set<() => void>();
let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^0x[0-9a-f]{40}$/.test(x)).slice(0, MAX) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: string[]) {
  cache = next.slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked: the star still works for this visit */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null; // another tab changed it
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useWatchlist(): string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function toggleWatch(token: string) {
  const t = token.toLowerCase();
  const cur = read();
  write(cur.includes(t) ? cur.filter((x) => x !== t) : [t, ...cur]);
}
