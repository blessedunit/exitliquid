"use client";
// Board signals on the client: the lazy loader for /api/signals, the chips a row shows, and the filters.
// The list never waits for signals: they load after it, for the first 60 rows on screen (2 calls of 30),
// and fade into their cells. Unknown is never "clean": a row without signals never passes a filter that
// needs proof (Clean start, Dev holding) and is never hidden by one that needs a red flag (snipers-heavy).
import { useEffect, useRef, useState } from "react";
import type { LaunchCard as Card } from "@/lib/launches";
import type { TokenSignal } from "@/lib/signals";
import { healthChips } from "@/lib/healthChips";
import { SNIPERS_MEDIUM } from "@/lib/health";
import type { FilterId } from "./state";

export type { TokenSignal, FilterId };
/** absent = not asked (outside the window); "loading" = first ask in flight; "error" = the call failed */
export type SigEntry = TokenSignal | "loading" | "error";
export type SigMap = ReadonlyMap<string, SigEntry>;

export const SIG_WINDOW = 60; // rows that get signals (the first 60 on screen)
const SIG_CHUNK = 30; // /api/signals takes 30 per call
const SIG_MS = 5 * 60_000; // the server caches 5 min: no point asking more often
const RETRY_MS = 25_000; // a row that came back unknown (slow chain) is asked again after this...
const RETRIES = 3; // ...this many times, then it waits for the 5-min round
/** when a filter that needs signals is on, every loaded row (up to this many) is asked, not only the first 60 */
export const SIG_WINDOW_FILTERED = 150;
// one sniper band for the whole site (lib/health, shared with Line Health and the board chips):
// 6+ known snipers in the first 20 is the "medium" warning, so the chip keeps rows under it
const SNIPER_OK = SNIPERS_MEDIUM;

/* ---------------- loader ---------------- */

export function useSignals(cards: Card[], opts: { paused: () => boolean; window?: number }): SigMap {
  const [map, setMap] = useState<SigMap>(() => new Map());
  const asked = useRef(new Map<string, { at: number; tries: number }>());
  const pausedRef = useRef(opts.paused);
  const backoff = useRef(0);
  useEffect(() => {
    pausedRef.current = opts.paused;
  }, [opts.paused]);
  // v6 launches have no v1 curve to read: they never go to the endpoint (their TAX chip is free)
  const key = cards
    .filter((c) => !c.v6)
    .slice(0, opts.window ?? SIG_WINDOW)
    .map((c) => `${c.token}:${c.createdAt || 0}`)
    .join(",");

  useEffect(() => {
    if (!key) return;
    let dead = false;
    let busy = false;
    const list = key.split(",").map((x) => {
      const [t, at] = x.split(":");
      return { t, at: Number(at) };
    });
    const run = async () => {
      if (busy || dead || document.visibilityState !== "visible" || pausedRef.current() || Date.now() < backoff.current) return;
      const now = Date.now();
      const need = list.filter(({ t }) => {
        const a = asked.current.get(t);
        if (!a) return true;
        if (now - a.at >= SIG_MS) return true;
        return a.tries > 0 && a.tries < RETRIES && now - a.at >= RETRY_MS; // tries > 0 = last answer was unknown
      });
      if (!need.length) return;
      busy = true;
      setMap((prev) => {
        const m = new Map(prev);
        for (const { t } of need) if (!m.has(t) || m.get(t) === "error") m.set(t, "loading");
        return m;
      });
      // one call after the other: the list's own polling keeps the lion's share of the request budget
      for (let i = 0; i < need.length && !dead; i += SIG_CHUNK) {
        const ch = need.slice(i, i + SIG_CHUNK).sort((a, b) => (a.t < b.t ? -1 : 1)); // sorted: one CDN key per page
        // marked as asked only when its call goes out: a chunk cut off by a newer list is asked by the next run
        for (const { t } of ch) asked.current.set(t, { at: Date.now(), tries: asked.current.get(t)?.tries ?? 0 });
        try {
          const r = await fetch(`/api/signals?tokens=${ch.map((x) => x.t).join(",")}&at=${ch.map((x) => x.at || "").join(",")}`);
          if (r.status === 429) backoff.current = Date.now() + 60_000;
          if (!r.ok) throw new Error(String(r.status));
          const j = (await r.json()) as { items?: Record<string, TokenSignal> };
          // applied even when the list moved on meanwhile: the answer is still true for these tokens
          setMap((prev) => {
            const m = new Map(prev);
            for (const { t } of ch) {
              const s = j.items?.[t];
              const a = asked.current.get(t);
              if (s) {
                // an unknown answer never replaces a good one already on screen
                const old = m.get(t);
                if (s.status !== "unknown" || !old || typeof old === "string") m.set(t, s);
                asked.current.set(t, { at: a?.at ?? Date.now(), tries: s.status === "unknown" ? (a?.tries ?? 0) + 1 : 0 });
              } else {
                m.set(t, "error");
                asked.current.set(t, { at: a?.at ?? Date.now(), tries: (a?.tries ?? 0) + 1 });
              }
            }
            return m;
          });
        } catch {
          setMap((prev) => {
            const m = new Map(prev);
            for (const { t } of ch) {
              const old = m.get(t);
              if (!old || old === "loading") m.set(t, "error");
              const a = asked.current.get(t);
              asked.current.set(t, { at: a?.at ?? Date.now(), tries: (a?.tries ?? 0) + 1 });
            }
            return m;
          });
        }
      }
      busy = false;
    };
    // after the list has painted, never before it
    const t0 = setTimeout(() => void run(), 400);
    const iv = setInterval(() => void run(), 10_000);
    const onVis = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      dead = true;
      clearTimeout(t0);
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [key]);

  return map;
}

/* ---------------- chips ---------------- */

export type Tone = "bad" | "warn" | "plain" | "good";
export type Chip = { text: string; tone: Tone; title: string };

const pctBps = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;

/**
 * up to 2 chips, worst first: dev sold, heavy snipers, farm, a big dev bag, some snipers, tax, dev moved tokens.
 * The health rules live in lib/healthChips, shared with the token page's Signals strip (same words, same bands).
 */
export function chipsFor(c: Card, s: TokenSignal | null): Chip[] {
  const out: (Chip & { rank: number })[] = healthChips({
    devSells: s?.dev ? s.dev.sells : null,
    devMovedTo: s?.dev ? s.dev.movedTo : null,
    devHoldsBps: s?.dev ? s.dev.holdsBps : null,
    snipers: s?.snipers ?? null,
    farm: s?.farm ?? null,
    firstBuyers: s?.firstBuyers ?? null,
  }).map(({ rank, text, tone, title }) => ({ rank, text, tone, title }));
  if (c.v6) out.push({ rank: 5, text: `TAX ${pctBps(c.v6.taxBps)}`, tone: "plain", title: `Taxed v6 launch: ${pctBps(c.v6.taxBps)} on every trade, paired with ${c.v6.pair}.` });
  return out
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 2)
    .map(({ text, tone, title }) => ({ text, tone, title }));
}

export const gradeTone = (g: string): Tone => (g === "A" || g === "B" ? "good" : g === "C" ? "plain" : "bad");

/** the tooltip of a graded cell: what was read, and what wasn't */
export function sigTitle(s: TokenSignal): string {
  const parts: string[] = [`Line Health ${s.grade} (${s.score}/100), quick check from the first ${s.firstBuyers} buyers and the dev wallet.`];
  if (s.reasons.length) parts.push(s.reasons.map((r) => r.label).join(" · ") + ".");
  else parts.push("No warning signs at the front.");
  if (s.dev?.holdsBps !== null && s.dev?.holdsBps !== undefined) parts.push(s.dev.holdsBps > 0 ? `Dev holds ${pctBps(s.dev.holdsBps)} of supply.` : "Dev holds none.");
  if (s.partial) parts.push("Partial: some inputs couldn't be read.");
  parts.push("Signals, not verdicts. Full check on the line.");
  return parts.join(" ");
}

/* ---------------- filters ---------------- */

/** the SHOW ONLY chips (ids unchanged: shared ?f= links keep working). soon/fresh stay valid ids with no chip:
 * they duplicate the Near graduation / New tabs, and a link that carries one shows a removable pill instead. */
export const FILTERS: { id: FilterId; label: string; title: string; needsSignals: boolean }[] = [
  { id: "clean", label: "Grade A–B", title: "Line Health A or B with every input read.", needsSignals: true },
  { id: "nosnipe", label: `Under ${SNIPER_OK} snipers`, title: `Fewer than ${SNIPER_OK} known sniper bots in the first 20 buyers (${SNIPER_OK}+ is a warning in Line Health).`, needsSignals: true },
  { id: "dev", label: "Dev never sold", title: "The creator never sold and still holds some supply.", needsSignals: true },
];
/** the one rule every chip follows, said once (chip tooltips, the sheet, the legend) */
export const FILTER_SCOPE = "Filters check the rows loaded on this page. Rows we can't check yet are hidden, never counted as passing. Load more to filter more.";
/** legacy ids from old links: a pill in the summary line, never a chip */
export const LEGACY_FILTERS: { id: FilterId; label: string; title: string }[] = [
  { id: "soon", label: "Near graduation 60%+", title: "To grad 60%+ and not stalled (from a shared link)" },
  { id: "fresh", label: "Under 1h old", title: "Launched less than an hour ago (from a shared link)" },
];

const sigOf = (e: SigEntry | undefined): TokenSignal | null => (e && typeof e !== "string" ? e : null);

/** true = passes, false = fails, null = can't tell yet (signals unknown or still loading) */
export function passes(f: FilterId, c: Card, e: SigEntry | undefined, nowSec: number | null): boolean | null {
  const s = sigOf(e);
  switch (f) {
    case "soon":
      return !c.graduated && c.progressBps >= 6_000 && !c.etaStalled;
    case "fresh":
      return nowSec === null || !c.createdAt ? null : nowSec - c.createdAt < 3_600;
    case "clean":
      if (c.v6) return false; // no Line Health for v6 curves: never "clean" by proof
      if (!s || s.status === "unknown") return null;
      return s.status === "ok" && (s.grade === "A" || s.grade === "B") && !s.partial;
    case "nosnipe":
      if (c.v6) return false; // no sniper read for v6 curves: never "few snipers" by proof
      if (!s || s.status === "unknown" || s.snipers === null) return null; // unknown is never a pass
      return s.snipers < SNIPER_OK;
    case "dev":
      if (c.v6) return false; // no dev read for v6 curves: never "holding" by proof (and never "loading" either)
      if (!s || s.status === "unknown" || !s.dev || s.dev.holdsBps === null) return null;
      return s.dev.sells === 0 && s.dev.holdsBps > 0;
  }
}

/** every active filter must pass; a "can't tell" hides the row and is counted, so the bar can say so */
// "unchecked" = a row outside the signals window that nobody will ask about: hidden, but never "still checking"
const unchecked = (c: Card, sig: SigMap, asked?: ReadonlySet<string>) => !!asked && !c.v6 && !asked.has(c.token) && !sig.has(c.token);

export function applyFilters(rows: Card[], fs: FilterId[], sig: SigMap, nowSec: number | null, asked?: ReadonlySet<string>): { rows: Card[]; unknown: number; unchecked: number } {
  if (!fs.length) return { rows, unknown: 0, unchecked: 0 };
  let unknown = 0;
  let skipped = 0;
  const out = rows.filter((c) => {
    let pend = false;
    for (const f of fs) {
      const p = passes(f, c, sig.get(c.token), nowSec);
      if (p === false) return false;
      if (p === null) pend = true;
    }
    if (pend) {
      if (unchecked(c, sig, asked)) skipped++;
      else unknown++;
    }
    return !pend;
  });
  return { rows: out, unknown, unchecked: skipped };
}

/** what each chip would keep, before it is clicked: pass = rows that pass it alone, unknown = rows it can't tell yet */
export function countFilters(rows: Card[], sig: SigMap, nowSec: number | null, asked?: ReadonlySet<string>): Record<FilterId, { pass: number; unknown: number; unchecked: number }> {
  const out = {} as Record<FilterId, { pass: number; unknown: number; unchecked: number }>;
  for (const f of ["clean", "nosnipe", "dev", "soon", "fresh"] as FilterId[]) out[f] = { pass: 0, unknown: 0, unchecked: 0 };
  for (const c of rows) {
    const e = sig.get(c.token);
    const skip = unchecked(c, sig, asked);
    for (const f of Object.keys(out) as FilterId[]) {
      const p = passes(f, c, e, nowSec);
      if (p === true) out[f].pass++;
      else if (p === null) {
        if (skip) out[f].unchecked++;
        else out[f].unknown++;
      }
    }
  }
  return out;
}
