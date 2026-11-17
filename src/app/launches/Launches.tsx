"use client";
// LIVE LAUNCHES: every vibe/vibe token as one live row of the board (minimal spec §3.1): grade, token (ticker over
// one fixed sub-line: name · age · the grade's top flag), the price line over 24 h (or the whole life of a younger
// token) with its %, a thin progress bar to graduation, holders and volume 24 h; a row lights up when someone buys.
// One toolbar above it: preset tabs (each a complete view with its own order), Hide high risk and Refresh.
import Link from "next/link";
import EmptyState from "@/components/ui/EmptyState";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { prime } from "@/lib/prime";
import Sparkline, { type SparkData } from "@/components/Sparkline";
import TokenAvatar from "@/components/TokenAvatar";
import type { LaunchCard as Card } from "@/lib/launches";
import { toggleWatch, useWatchlist } from "./watch";
import { deltaOf, markSeen, moved, readSeen, seedSeen, useSeen, type Delta, type SeenMap } from "./seen";
import { boardQuery, DEFAULT_SORT, naturalDir, parseBoard, type BoardState, type Dir, type FilterId, type Period, type SortKey, type Tab } from "./state";
import { applyFilters, FILTERS, SIG_WINDOW, SIG_WINDOW_FILTERED, useSignals, type SigMap } from "./signals";
import styles from "./launches.module.css";
import BoardingRows from "./Boarding";
import { fmtEth } from "@/lib/format";
import { GradeBadge } from "@/components/screener/Grade";
import { useScreener } from "@/components/screener/useScreener";
import { coverageWord, standingWord, type ScreenerRow } from "@/lib/screener-types";

type Page = { items: Card[]; next: string | null; v6?: "ok" | "error" | "off"; missing?: string[] };
// "down" is terminal: MAX_TRIES failures in a row, the automatic retries stop, "Try again" starts them over
type Conn = "ok" | "retry" | "limited" | "down";
const MAX_TRIES = 5;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// one row of presets, each a complete view (its own order and window); ids are the ?tab= values
const TABS: { id: Tab; label: string; short?: string; caption: string }[] = [
  { id: "new", label: "New", caption: "Newest launches first." },
  { id: "hot", label: "Hot", caption: "Most ETH traded in the last 24 h." },
  { id: "door", label: "Near graduation", short: "Near grad", caption: "Closest to graduation, not graduated yet." },
  { id: "grad", label: "Graduated", caption: "Latest graduations first." },
  { id: "watch", label: "☆ Watchlist", short: "☆ Pins", caption: "Tokens you pinned with ☆. Saved in this browser." },
];
// what a tab keeps of a search or a refresh (the server already sends only these; a search is one list for all tabs)
const inTab = (t: Tab, c: Card) => (t === "door" ? !c.graduated : t === "grad" ? c.graduated : true);
const POLL_MS = 30_000; // the board is CDN-cached 30 s (api/launches)
const CHUNK = 20; // /api/launches?tokens= takes 20 addresses per call
const WATCH_MAX = 60; // 3 calls at most (the list itself keeps 50)
const EXTRA_REFRESH = 40; // rows loaded with "More" refreshed per poll (2 calls), oldest first
const STALE_MS = POLL_MS * 2 + 5_000;
const PART_ADDR = /^0x[0-9a-fA-F]{4,39}$/;
const SPARK_MS = 60_000; // price lines are CDN-cached 60 s (api/spark): no point asking more often
const SPARK_CHUNK = 24; // one board page per call (the first chunk is the same for every viewer: CDN-cached)
const SPARK_MAX = 120; // 5 calls at most per refresh
const SPARK_RETRY_MS = 12_000; // a row the server left out (slow upstream) is asked again this soon
const YOUNG_S = 2 * 3600; // v6 rows under 2 h draw from 1m candles, older ones from 5m
const SEEN_AFTER_MS = 30_000; // 30 s on the Watchlist = seen
const BG_WATCH_MS = 120_000; // off the Watchlist tab: check the pinned tokens every 2 min for the "new" counter
const LIST_CACHE_MAX = 10; // lists kept in memory for an instant tab switch (shown at once, refreshed behind)
const PENDING_MAX = 50; // New tab: tokens held behind the "↑ N new" pill


type SparkMap = ReadonlyMap<string, SparkData | null>;
// the line for the chosen period: 24 h (or since launch), or the last hour only. undefined = loading, null = unknown
// (an older server answer without the hour line is unknown for 1h, never the 24 h line under a 1h label)
const sparkFor = (s: SparkData | null | undefined, period: Period): SparkData | null | undefined =>
  period === "24h" || !s ? s : s.h1 ? { ...s.h1, trades: s.trades } : null;
// the % beside the line: first to last trade of the window; null = unknown or no line
// (trades = the whole life's count: under 2 there is no line yet, in either period)
const sparkChg = (s: SparkData | null | undefined) => (s && s.x.length && (s.trades === undefined || s.trades >= 2) ? s.chgBps : null);

function sortValue(c: Card, k: SortKey, period: Period, rank: number, sig: SigMap, spark: SparkMap): number | null {
  switch (k) {
    case "sig": {
      // Line Health score; rows not graded (unknown, too early, v6, outside the window) always last
      const e = sig.get(c.token);
      return e && typeof e !== "string" && e.score !== null ? e.score : null;
    }
    case "rank": return -rank;
    case "new": return c.createdAt || null;
    case "door": return c.graduated ? 10_001 : c.progressBps;
    case "eta": return c.etaHours; // stalled and unknown are null: always last
    case "holders": return c.holders;
    case "vol": return period === "1h" ? c.volume1hEth : c.volume24hEth;
    case "chg": return sparkChg(sparkFor(spark.get(c.token), period));
    case "buys": return c.buys1h;
  }
}

function sortRows(ranked: { c: Card; i: number }[], key: SortKey, dir: Dir, period: Period, sig: SigMap, spark: SparkMap = new Map()): Card[] {
  const sign = dir === "desc" ? -1 : 1;
  return ranked
    .map((x) => ({ ...x, v: sortValue(x.c, key, period, x.i, sig, spark) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1; // unknown always last, never counted as zero
      if (b.v === null) return -1;
      return a.v === b.v ? a.i - b.i : sign * (a.v - b.v);
    })
    .map((x) => x.c);
}

function age(ts: number, now: number) {
  const s = Math.max(0, Math.floor(now / 1000 - ts));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const eth = (v: number | null) => (v === null ? "—" : v > 0 && v < 0.001 ? "<0.001" : fmtEth(v));
const pctText = (bps: number) => `${(bps / 100).toFixed(1)}%`;
// under 0.05 % prints as 0.0 %: never a red "−0.0%"
const flatBps = (bps: number) => Math.abs(bps) < 5;
function chgText(bps: number) {
  if (flatBps(bps)) return "0.0%";
  const p = bps / 100;
  const a = Math.abs(p);
  const body = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(1);
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${body}%`;
}
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
function ago(ms: number, now: number) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const signed = (v: number, body: string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${body}`;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// warm a token's line on hover/touch: by the time the click lands, the CDN already has it
const warmed = new Set<string>();
let warmTimer: ReturnType<typeof setTimeout> | undefined;
type Prefetch = (href: string) => void;
function warmNow(c: Card, pre?: Prefetch) {
  if (warmed.has(c.token)) return;
  warmed.add(c.token);
  // the page shell (its loading skeleton): the click then paints at once
  pre?.(`/line/${c.token}`);
  // a v6 line is the lite page (vibe/vibe's server render reads it); everything else is the chain line,
  // kept for the line page itself to take (lib/prime): one request, not two
  if (c.v6) fetch(`/api/v6/${c.token}`).catch(() => {});
  else prime(`/api/queue/${c.token}?limit=1000`);
}
// a pointer that rests on a row for 250 ms (not a mouse sweeping across the list) warms that one line
function warm(c: Card, pre?: Prefetch) {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => warmNow(c, pre), 250);
}
const unwarm = () => clearTimeout(warmTimer);

// "since your last visit": compact parts, unknown sides left out (never shown as 0)
type SincePart = { text: string; tone: "up" | "down" | "grad" | "stall" };
function sinceParts(d: Delta): SincePart[] {
  const out: SincePart[] = [];
  if (d.graduated) out.push({ text: "Graduated!", tone: "grad" });
  if (d.stalled) out.push({ text: "Stalled", tone: "stall" });
  if (d.holders !== null && d.holders !== 0) out.push({ text: `${signed(d.holders, String(Math.abs(d.holders)))} holders`, tone: d.holders > 0 ? "up" : "down" });
  if (!d.graduated && Math.abs(d.doorBps) >= 10) out.push({ text: `${signed(d.doorBps, (Math.abs(d.doorBps) / 100).toFixed(1))}% door`, tone: d.doorBps > 0 ? "up" : "down" });
  if (d.priceBps !== null && Math.abs(d.priceBps) >= 10) out.push({ text: `${chgText(d.priceBps)} price`, tone: d.priceBps > 0 ? "up" : "down" });
  return out;
}
function sinceText(d: Delta | null, now: number | null): string {
  if (!d) return "Changes show from your next visit";
  const when = now !== null ? ` since ${ago(d.since, now)}` : " since your last visit";
  const parts = sinceParts(d);
  return parts.length ? `${parts.map((x) => x.text).join(" · ")}${when}` : `No change${when}`;
}

class HttpError extends Error {
  constructor(public status: number, public retryAfter: number) {
    super(String(status));
  }
}
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new HttpError(r.status, Number(r.headers.get("retry-after")) || 0);
  return (await r.json()) as T;
}
const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
// one row per token, first one wins (stable React keys: a token never shows twice)
function uniq(list: Card[]): Card[] {
  const had = new Set<string>();
  return list.filter((c) => (had.has(c.token) ? false : (had.add(c.token), true)));
}
// the pointer is on the board: fresh numbers go in, but rows keep their places (no row jumps under the cursor)
function keepOrder(fresh: Card[], shown: Card[]): Card[] {
  const at = new Map(shown.map((c, i) => [c.token, i]));
  return fresh
    .map((c, i) => ({ c, k: at.get(c.token) ?? shown.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.c);
}
// "Updated 12s ago": ticks on its own, so the whole board doesn't re-render every second
function Updated({ at }: { at: number | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const t0 = setTimeout(() => setNow(Date.now()), 0);
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 1_000);
    return () => {
      clearTimeout(t0);
      clearInterval(iv);
    };
  }, []);
  if (at === null || now === null) return <span className={styles.updated} aria-hidden />;
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const txt = s < 5 ? "just now" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  return (
    <span className={styles.updated} title={`Updated at ${new Date(at).toLocaleTimeString()}. The list refreshes every 30 s.`}>
      <i aria-hidden /> {txt}
    </span>
  );
}

// "Hide high risk" (D and F): one switch for every tab, remembered in this browser; storage can be blocked
const RISK_KEY = "exit.hideRisk";
const riskSubs = new Set<() => void>();
let riskCache: boolean | null = null;
function readRisk(): boolean {
  if (riskCache !== null) return riskCache;
  try {
    riskCache = window.localStorage.getItem(RISK_KEY) === "1";
  } catch {
    riskCache = false;
  }
  return riskCache;
}
function setRisk(on: boolean) {
  riskCache = on;
  try {
    window.localStorage.setItem(RISK_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the switch still works for this visit */
  }
  riskSubs.forEach((f) => f());
}
function subscribeRisk(f: () => void) {
  riskSubs.add(f);
  return () => riskSubs.delete(f);
}
const isHighRisk = (r: ScreenerRow | undefined) => r?.grade === "D" || r?.grade === "F";

export default function Launches({ initial: served, board: servedBoard, home = false }: { initial: Page | null; board: BoardState; home?: boolean }) {
  const router = useRouter();
  const pre = useCallback((href: string) => router.prefetch(href), [router]);
  const sp = useSearchParams();
  // "back" from a line remounts this board from the router cache with the props of its FIRST render
  // (e.g. plain /launches), while the URL says ?tab=grad&sort=holders: the URL wins, and rows from the
  // server are used only when they belong to the same list (tab + search)
  const [{ board, initial }] = useState(() => {
    const b = parseBoard(sp);
    return { board: b, initial: b.tab === servedBoard.tab && b.q === servedBoard.q ? served : null };
  });
  const watch = useWatchlist();
  const hideRisk = useSyncExternalStore(subscribeRisk, readRisk, () => false);
  const [tab, setTab] = useState<Tab>(board.tab);
  const [query, setQuery] = useState(board.q.replace(/^\$/, ""));
  const [items, setItems] = useState<Card[]>(initial?.items ?? []);
  const [next, setNext] = useState<string | null>(initial?.next ?? null);
  const [v6, setV6] = useState<Page["v6"]>(initial?.v6 ?? "off");
  const [missing, setMissing] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error" | "more">(initial ? "ok" : "loading");
  // no first page from the server (slow or failed) is not an error yet: the client load right after decides
  const [conn, setConn] = useState<Conn>("ok");
  const fails = useRef(0); // failed loads in a row
  const [lastTry, setLastTry] = useState<number | null>(null);
  const down = conn === "down";
  const [flash, setFlash] = useState<Record<string, number>>({}); // token -> new buys since the last look (-1 = new row)
  const period: Period = "24h"; // one window for the whole board (see ./state)
  // filter chips were removed from the board (operator, 03.10): the list always shows every row
  const [filters, setFilters] = useState<FilterId[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: board.sort, dir: board.dir });
  const [now, setNow] = useState<number | null>(null); // ages appear after mount: no server/client clock mismatch
  const [seenAt, setSeenAt] = useState<ReadonlyMap<string, number>>(() => new Map()); // render copy of fetchedAt
  const reqId = useRef(0);
  const skipKey = useRef<string | null>(initial ? `${board.tab}|${board.q.replace(/^\$/, "")}` : null);
  const itemsRef = useRef(items);
  const watchRef = useRef(watch);
  const fetchedAt = useRef(new Map<string, number>());
  const pauseUntil = useRef(0);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [focusRow, setFocusRow] = useState(-1); // j/k row focus (-1 = none)
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  const seen = useSeen();
  const [baseline, setBaseline] = useState<SeenMap | null>(null); // "last visit", frozen while the Watchlist is open
  const [bgWatch, setBgWatch] = useState<Card[]>([]); // pinned cards checked while another tab is open
  const [spark, setSpark] = useState<ReadonlyMap<string, SparkData | null>>(() => new Map());
  const sparkAt = useRef(new Map<string, number>());
  const watchShownAt = useRef(0); // when the Watchlist rows were first on screen (0 = not yet)
  // loading without blanking: the list the rows on screen belong to, lists seen before (instant tab switch),
  // the request in flight (a newer one aborts it), and the New tab's arrivals held behind a pill
  const listKey = useRef<string | null>(initial ? `${board.tab}|${board.q.replace(/^\$/, "")}` : null);
  const listCache = useRef(new Map<string, { items: Card[]; next: string | null; v6: Page["v6"]; at: number }>());
  const ctl = useRef<AbortController | null>(null);
  const inflight = useRef(false);
  const hovering = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  // rows fade in once, when a list replaces the boarding screen (never on re-sorts or refreshes):
  // the render that swaps loading for rows already carries the fading overlay, so no frame ever cuts
  const isLoading = state === "loading" || (state === "error" && items.length === 0 && !down);
  const [wasLoading, setWasLoading] = useState(isLoading);
  const [leaving, setLeaving] = useState(false); // boarding screen fading out over the fresh rows
  if (wasLoading !== isLoading) {
    setWasLoading(isLoading);
    setLeaving(!isLoading);
  }
  useEffect(() => {
    if (!leaving) return;
    const u = setTimeout(() => setLeaving(false), 700);
    return () => clearTimeout(u);
  }, [leaving]);
  const headRef = useRef<HTMLDivElement>(null);
  const [headH, setHeadH] = useState(0);
  useEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeadH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const swapping = leaving;
  const [pending, setPending] = useState<Card[]>([]);
  const pendingRef = useRef(pending);
  const [busy, setBusy] = useState(false); // a refresh with rows kept on screen: thin bar over the list
  const [manualBusy, setManualBusy] = useState(false); // the Refresh button spins
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    watchRef.current = watch;
  }, [watch]);
  useEffect(() => {
    const t = setTimeout(() => {
      const n = Date.now();
      setNow(n);
      for (const c of itemsRef.current) if (!fetchedAt.current.has(c.token)) fetchedAt.current.set(c.token, n);
      setSeenAt(new Map(fetchedAt.current));
      if (itemsRef.current.length) setUpdatedAt(n); // the server's first page was just rendered
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const fail = useCallback((e: unknown) => {
    fails.current++;
    setLastTry(Date.now());
    if (fails.current >= MAX_TRIES) setConn("down");
    else if (e instanceof HttpError && e.status === 429) {
      setConn("limited");
      pauseUntil.current = Date.now() + Math.min(60, Math.max(5, e.retryAfter || 30)) * 1000;
    } else setConn("retry");
  }, []);
  const connOk = useCallback(() => {
    fails.current = 0;
    setConn("ok");
  }, []);

  const load = useCallback(
    async (t: Tab, qq: string, cursor: string | null, quiet = false, manual = false) => {
      // an automatic refresh never cuts in: whatever is in flight (a tab switch, "More", Refresh) is newer or bigger
      if (quiet && !manual && inflight.current) return;
      const key = `${t}|${qq}`;
      ctl.current?.abort(); // the older request can't land over this one (and stops costing the API)
      const ac = new AbortController();
      ctl.current = ac;
      const id = ++reqId.current;
      inflight.current = true;
      const stamp = (list: Card[]) => {
        const n = Date.now();
        for (const c of list) fetchedAt.current.set(c.token, n);
      };
      if (cursor) setState("more");
      else {
        setState((s) => (s === "more" ? "ok" : s)); // a "More" this load cut off doesn't keep spinning
        if (!quiet) {
          const hit = listCache.current.get(key);
          if (hit || (listKey.current === key && itemsRef.current.length)) {
            // stale-while-revalidate: this list was on screen before, so it shows at once and refreshes behind
            if (hit && listKey.current !== key) {
              itemsRef.current = hit.items;
              setItems(hit.items);
              setNext(hit.next);
              setV6(hit.v6);
              setUpdatedAt(hit.at);
            }
            listKey.current = key;
            setPending([]);
            setState("ok");
            setBusy(true);
            quiet = true;
          } else {
            // first look at this list: skeleton rows (never another list's rows under this tab)
            setState("loading");
            setPending([]);
            fetchedAt.current.clear(); // a fresh list: freshness starts over (and the map stays small)
          }
        }
      }
      if (manual) {
        setBusy(true);
        setManualBusy(true);
      }
      try {
        if (t === "watch") {
          const list = watchRef.current.slice(0, WATCH_MAX);
          if (!list.length) {
            listKey.current = key;
            setItems([]);
            setNext(null);
            setMissing([]);
            setState("ok");
            connOk();
            setUpdatedAt(Date.now());
            return;
          }
          // pinned lists longer than 20 go in batches of 20 (one upstream call each)
          const got = await Promise.allSettled(chunks(list, CHUNK).map((c) => getJson<Page>(`/api/launches?tokens=${c.join(",")}`, ac.signal)));
          if (id !== reqId.current) return;
          const ok = got.filter((r): r is PromiseFulfilledResult<Page> => r.status === "fulfilled").map((r) => r.value);
          const bad = got.find((r): r is PromiseRejectedResult => r.status === "rejected");
          if (!ok.length) throw bad?.reason ?? new Error("down");
          const found = new Map(ok.flatMap((p) => p.items).map((c) => [c.token, c] as const));
          const fresh = uniq(list.map((tk) => found.get(tk)).filter((c): c is Card => !!c));
          stamp(fresh);
          listKey.current = key;
          setItems(fresh);
          if (!watchShownAt.current) watchShownAt.current = Date.now();
          setMissing(ok.flatMap((p) => p.missing ?? []));
          setNext(null);
          setNow(Date.now());
          setUpdatedAt(Date.now());
          setSeenAt(new Map(fetchedAt.current));
          setState("ok");
          if (bad) fail(bad.reason);
          else connOk();
          return;
        }
        const url = `/api/launches?tab=${t}${qq ? `&q=${encodeURIComponent(qq)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const j = await getJson<Page>(url, ac.signal);
        if (id !== reqId.current) return;
        stamp(j.items);
        if (quiet) {
          // live refresh of the first page, plus the oldest rows that came with "More" (known v1 rows only)
          const shown = itemsRef.current;
          const before = new Map(shown.map((c) => [c.token, c]));
          // New tab: fresh launches wait behind the "↑ N new" pill (the list never slides down by itself);
          // Refresh pressed on purpose puts them straight in
          const hold = t === "new" && !manual && shown.length > 0;
          const bumps: Record<string, number> = {};
          const arrived: Card[] = [];
          for (const c of j.items) {
            const old = before.get(c.token);
            const d = old ? (c.buys1h ?? 0) - (old.buys1h ?? 0) : 0;
            if (d > 0 || (old && (c.holders ?? 0) > (old.holders ?? 0))) bumps[c.token] = Math.max(1, d);
            else if (!old && shown.length) {
              if (hold) arrived.push(c);
              else bumps[c.token] = -1; // brand new row
            }
          }
          const held = new Set(arrived.map((c) => c.token));
          const fresh = new Set(j.items.map((c) => c.token));
          let extra = shown.filter((c) => !fresh.has(c.token)).slice(0, 120);
          const toRefresh = extra
            .filter((c) => !c.v6)
            .sort((a, b) => (fetchedAt.current.get(a.token) ?? 0) - (fetchedAt.current.get(b.token) ?? 0))
            .slice(0, EXTRA_REFRESH)
            .map((c) => c.token);
          if (toRefresh.length) {
            const got = await Promise.allSettled(chunks(toRefresh, CHUNK).map((c) => getJson<Page>(`/api/launches?tokens=${c.join(",")}&v1=1`, ac.signal)));
            if (id !== reqId.current) return;
            const upd = new Map(got.flatMap((r) => (r.status === "fulfilled" ? r.value.items : [])).map((c) => [c.token, c] as const));
            stamp([...upd.values()]);
            extra = extra.map((c) => upd.get(c.token) ?? c); // a row that didn't come back keeps its old numbers and goes stale
          }
          // Refresh pressed: the held arrivals that already slid past the first page come in too
          const waiting = manual ? pendingRef.current.filter((c) => !fresh.has(c.token)) : [];
          for (const c of waiting) bumps[c.token] = -1;
          let list = uniq([...j.items.filter((c) => !held.has(c.token)), ...waiting, ...extra]);
          // the pointer is on the board: numbers change, places don't (the next refresh without it re-sorts)
          if (hovering.current && !manual) list = keepOrder(list, shown);
          listKey.current = key;
          setItems(list);
          if (manual) setPending([]);
          else if (arrived.length) setPending((p) => uniq([...arrived, ...p]).slice(0, PENDING_MAX));
          if (Object.keys(bumps).length) {
            setFlash(bumps);
            setTimeout(() => setFlash({}), 2600);
          }
        } else {
          listKey.current = key;
          setItems((prev) => (cursor ? uniq([...prev, ...j.items]) : uniq(j.items)));
          setNext(j.next);
          setV6(j.v6 ?? "off");
        }
        setNow(Date.now());
        if (!cursor) setUpdatedAt(Date.now());
        setSeenAt(new Map(fetchedAt.current));
        setState("ok");
        connOk();
      } catch (e) {
        if (id !== reqId.current) return; // cut off by a newer load: that one reports
        fail(e);
        if (!quiet) {
          if (!cursor) {
            listKey.current = null;
            setItems([]); // never show another tab's rows under this tab
            setNext(null);
          }
          setState(cursor ? "ok" : "error");
        }
        // quiet (rows on screen): the rows stay, the toolbar says "Stale" over them
      } finally {
        if (id === reqId.current) {
          inflight.current = false;
          setBusy(false);
          setManualBusy(false);
        }
      }
    },
    [fail, connOk],
  );

  // the watch tab reloads when the list of stars changes; other tabs don't care about stars
  const watchKey = tab === "watch" ? watch.slice(0, WATCH_MAX).join(",") : "";

  // new tab / new search: load it (the server already rendered the first page of the URL's list)
  useEffect(() => {
    const key = `${tab}|${query}`;
    if (skipKey.current === key) {
      skipKey.current = null;
      return;
    }
    skipKey.current = null;
    fails.current = 0; // another list: its own tries
    const t = setTimeout(() => void load(tab, query, null), 0);
    return () => clearTimeout(t);
  }, [tab, query, watchKey, load]);

  // the board is alive: refresh while the tab is visible; a failed board retries (after a 429: after retry-after)
  // until MAX_TRIES failures in a row, then it stops and says so ("Try again" starts over)
  // (hidden browser tab: no requests at all; back on it after a while: one refresh right away, not a wait of up to 15 s)
  useEffect(() => {
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() < pauseUntil.current || fails.current >= MAX_TRIES) return;
      last = Date.now();
      const same = listKey.current === `${tab}|${query}` && itemsRef.current.length > 0;
      void load(tab, query, null, same);
    };
    const iv = setInterval(tick, POLL_MS);
    const back = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= POLL_MS) tick();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", back);
    };
  }, [tab, query, load]);

  // every list that loaded is kept (a few at most): switching back to it shows it at once, then refreshes
  useEffect(() => {
    const k = listKey.current;
    if (!k || state !== "ok" || updatedAt === null) return;
    const m = listCache.current;
    m.delete(k);
    m.set(k, { items, next, v6, at: updatedAt });
    if (m.size > LIST_CACHE_MAX) m.delete(m.keys().next().value as string);
  }, [items, next, v6, state, updatedAt]);

  // Refresh: the same list, fresh numbers; tab, page, sort and search stay as they are
  const refresh = () => {
    if (manualBusy) return;
    fails.current = 0;
    void load(tab, query, null, listKey.current === `${tab}|${query}` && itemsRef.current.length > 0, true);
  };
  // "↑ N new": the held launches go on top, and the view goes to them
  const showPending = () => {
    const add = pendingRef.current;
    if (!add.length) return;
    setItems((prev) => uniq([...add, ...prev]));
    setPending([]);
    setFlash(Object.fromEntries(add.map((c) => [c.token, -1])));
    setTimeout(() => setFlash({}), 2600);
    const top = boardRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) window.scrollTo({ top: Math.max(0, window.scrollY + top - 72) }); // 72: under the sticky header
  };

  // "since your last visit": the stored snapshot is the baseline while the Watchlist is open; what is on
  // screen becomes the next baseline after 30 s of viewing, or when the viewer leaves the tab or the page
  useEffect(() => {
    if (tab !== "watch") return;
    let done = false;
    const commit = () => {
      if (done || !watchShownAt.current) return;
      const w = new Set(watchRef.current);
      const cards = itemsRef.current.filter((c) => w.has(c.token));
      if (!cards.length) return;
      done = true;
      markSeen(cards);
    };
    const t0 = setTimeout(() => setBaseline(readSeen()), 0);
    const iv = setInterval(() => {
      if (watchShownAt.current && Date.now() - watchShownAt.current >= SEEN_AFTER_MS) commit();
    }, 5_000);
    const onHide = () => {
      if (document.visibilityState === "hidden") commit();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", commit);
    return () => {
      clearTimeout(t0);
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", commit);
      commit(); // leaving the tab: the rows still on screen are the Watchlist's
      watchShownAt.current = 0;
    };
  }, [tab]);

  // off the Watchlist: check the pinned tokens now and then, so the tab can say "3 new"
  const watchAll = watch.slice(0, WATCH_MAX).join(",");
  useEffect(() => {
    if (tab === "watch" || !watchAll) return;
    let dead = false;
    const run = async () => {
      if (document.visibilityState !== "visible" || Date.now() < pauseUntil.current) return;
      const got = await Promise.allSettled(chunks(watchAll.split(","), CHUNK).map((c) => getJson<Page>(`/api/launches?tokens=${c.join(",")}`)));
      if (dead) return;
      const ok = got.flatMap((r) => (r.status === "fulfilled" ? r.value.items : []));
      if (ok.length) setBgWatch(ok); // nothing came back: keep the last known cards (no "new" invented, none erased)
    };
    const t = setTimeout(() => void run(), 1_500);
    const iv = setInterval(() => void run(), BG_WATCH_MS);
    return () => {
      dead = true;
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [tab, watchAll]);

  // price lines for the rows on screen, lazily after the rows: v1 rows in one batched call per page (vibe's
  // /sparklines), v6 rows in their own call per page (the server reads one candle list per token, 6 at a time,
  // and caches them 60 s). Each row is asked again once a minute at most; a row the server left out (slow
  // upstream) is asked again in 12 s; a failed call leaves those rows "unknown", never flat.
  // key: "0x…" for a v1 row, "0x…:1" / "0x…:5" for a v6 row (1m candles under 2 h of age, 5m after)
  const nowS = now === null ? null : Math.floor(now / 1000);
  const sparkKey = items
    .slice(0, SPARK_MAX)
    .map((c) => (c.v6 ? (nowS === null ? "" : `${c.token}:${c.createdAt && nowS - c.createdAt < YOUNG_S ? 1 : 5}`) : c.token))
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    if (!sparkKey) return;
    let dead = false;
    const run = async () => {
      if (document.visibilityState !== "visible" || Date.now() < pauseUntil.current) return;
      const all = sparkKey.split(",");
      const n = Date.now();
      const due = (k: string) => n - (sparkAt.current.get(k.split(":")[0]) ?? 0) >= SPARK_MS;
      const v1 = all.filter((k) => !k.includes(":"));
      const v6 = all.filter((k) => k.includes(":"));
      const need = [
        ...chunks(v1, SPARK_CHUNK).map((ch) => ({ ch, url: `/api/spark?tokens=${[...ch].sort().join(",")}` })),
        ...chunks(v6, SPARK_CHUNK).map((ch) => ({ ch, url: `/api/spark?v6=${[...ch].sort().join(",")}` })),
      ].filter((x) => x.ch.some(due));
      if (!need.length) return;
      for (const x of need) for (const k of x.ch) sparkAt.current.set(k.split(":")[0], n); // no double asks while in flight
      const got = await Promise.allSettled(need.map((x) => getJson<{ items?: Record<string, SparkData> }>(x.url)));
      need.forEach((x, i) => {
        const r = got[i];
        for (const k of x.ch) {
          const t = k.split(":")[0];
          if (r.status === "rejected") sparkAt.current.delete(t); // asked again next round
          else if (!r.value.items?.[t]) sparkAt.current.set(t, n - SPARK_MS + SPARK_RETRY_MS); // left out: soon again
        }
      });
      if (dead) return;
      setSpark((prev) => {
        const keep = new Set(all.map((k) => k.split(":")[0]));
        const m = new Map(prev.size < 300 ? prev : [...prev].filter(([t]) => keep.has(t)));
        need.forEach((x, i) => {
          const r = got[i];
          for (const k of x.ch) {
            const t = k.split(":")[0];
            const v = r.status === "fulfilled" ? r.value.items?.[t] : undefined;
            if (v) m.set(t, v);
            else if (!m.get(t)) m.set(t, null); // a line already on screen stays until a fresh one replaces it
          }
        });
        return m;
      });
    };
    const t = setTimeout(() => void run(), 300);
    const iv = setInterval(() => void run(), SPARK_RETRY_MS);
    return () => {
      dead = true;
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [sparkKey]);

  // state -> URL (no navigation, no server round trip): back from a line lands on this same board
  useEffect(() => {
    const qs = boardQuery({ tab, sort: sort.key, dir: sort.dir, period, q: tab === "watch" ? "" : query, filters });
    // the board lives on "/" and on /launches: stay on whichever path it was opened on
    if (qs !== window.location.search) window.history.replaceState(null, "", `${window.location.pathname}${qs}`);
  }, [tab, sort, period, query, filters]);

  // URL -> state: the header search (or back/forward) changed the query string from outside
  const spKey = sp.toString();
  useEffect(() => {
    const b = parseBoard(new URLSearchParams(spKey));
    const mine = boardQuery({ tab, sort: sort.key, dir: sort.dir, period, q: tab === "watch" ? "" : query, filters });
    if (boardQuery(b) === mine) return;
    const t = setTimeout(() => {
      setTab(b.tab);
      setFilters([]);
      setSort({ key: b.sort, dir: b.dir });
      setQuery(b.q.replace(/^\$/, ""));
    }, 0);
    return () => clearTimeout(t);
    // only a change of the URL itself should run this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spKey]);

  const pickTab = (t: Tab) => {
    setTab(t);
    setSort({ key: DEFAULT_SORT[t], dir: naturalDir(DEFAULT_SORT[t]) });
    setFocusRow(-1);
    if (t === "watch") setQuery("");
  };
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((x) => x.id === tab);
    const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const t = TABS[(to + TABS.length) % TABS.length].id;
    pickTab(t);
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${t}"]`)?.focus();
  };
  const pickSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: naturalDir(key) }));

  const clearQuery = () => setQuery("");

  // client-side sort over the rows loaded so far (the vibe API only sorts by 3 fields)
  // deferred: the pressed header / menu lights up at once, the rows re-sort right behind it
  const sortD = useDeferredValue(sort);
  const periodD = useDeferredValue(period);
  const watchD = useDeferredValue(watch);
  const filtersD = useDeferredValue(filters);
  const emptySig = useMemo<SigMap>(() => new Map(), []);
  // every sort but Line Health: the order signals load in follows what the viewer sees first
  // v6 rows: the list has no 1h window; their price line carries it (volume, buys, sells of the last hour)
  const filled = useMemo(
    () =>
      items.map((c) => {
        const s = c.v6 ? spark.get(c.token) : null;
        if (!s || s.buys1h === undefined) return c;
        return {
          ...c,
          volume1hEth: c.volume1hEth ?? (c.v6?.pair === "ETH" ? (s.vol1hEth ?? null) : null),
          buys1h: c.buys1h ?? s.buys1h ?? null,
          sells1h: c.sells1h ?? s.sells1h ?? null,
        };
      }),
    [items, spark],
  );
  const base = useMemo(() => {
    // Watchlist: an unpinned row leaves at once (no reload of the whole list for it)
    const pinnedSet = tab === "watch" ? new Set(watchD) : null;
    const ranked = (pinnedSet ? filled.filter((c) => pinnedSet.has(c.token)) : filled).map((c, i) => ({ c, i }));
    const sort = sortD;
    const period = periodD;
    if (sort.key === "sig" || (sort.key === "rank" && sort.dir === "desc")) return ranked.map((x) => x.c);
    return sortRows(ranked, sort.key, sort.dir, period, emptySig, spark);
  }, [filled, sortD, periodD, tab, watchD, emptySig, spark]);

  // board signals: lazily, for the first 60 rows on screen, never blocking the list; with a filter that needs
  // them on, every loaded row is asked (150 at most), so "checking" always ends
  const paused = useCallback(() => Date.now() < pauseUntil.current, []);
  const sigFilterOn = filtersD.some((f) => FILTERS.some((x) => x.id === f && x.needsSignals));
  const sigMax = sigFilterOn ? SIG_WINDOW_FILTERED : SIG_WINDOW;
  const sig = useSignals(base, { paused, window: sigMax });
  // screener grades for the rows (one shared snapshot; "—" until a token is graded)
  const screener = useScreener();
  const graded = useMemo(() => {
    const m = new Map<string, ScreenerRow>();
    for (const r of screener.data?.tokens ?? []) m.set(r.token.toLowerCase(), r);
    return m;
  }, [screener.data]);
  const sigWindow = useMemo(() => new Set(base.filter((c) => !c.v6).slice(0, sigMax).map((c) => c.token)), [base, sigMax]);

  const sorted = useMemo(
    () => (sortD.key === "sig" ? sortRows(base.map((c, i) => ({ c, i })), "sig", sortD.dir, periodD, sig) : base),
    [base, sortD, periodD, sig],
  );
  const nowSec = now === null ? null : Math.floor(now / 1000);
  const filtered = useMemo(() => applyFilters(sorted, filtersD, sig, nowSec, sigWindow, screener.data ? graded : undefined), [sorted, filtersD, sig, nowSec, sigWindow, screener.data, graded]);
  // the tab's own cut (a search answer or a refresh may carry rows of another view), then Hide high risk
  const inView = useMemo(() => filtered.rows.filter((c) => inTab(tab, c)), [filtered.rows, tab]);
  const rows = useMemo(() => (hideRisk ? inView.filter((c) => !isHighRisk(graded.get(c.token.toLowerCase()))) : inView), [inView, hideRisk, graded]);
  const riskHidden = inView.length - rows.length;
  // keyboard (P2): j/k rows, Enter/o open, p pin, 1-5 lists, f filters, ? the list of keys.
  // Never while typing, in a select, or with a dialog open; Enter on a real control keeps its own meaning.
  useEffect(() => {
    keyHandler.current = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const k = e.key;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest("dialog"))) return;
      if (document.querySelector("dialog[open]")) return;
      try {
        if (k !== "?" && k !== "Escape" && document.querySelector(":popover-open")) return;
      } catch {
        /* no popover support: nothing can be open */
      }
      if (k === "j" || k === "k") {
        e.preventDefault();
        if (!rows.length) return;
        const nx = focusRow < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, focusRow + (k === "j" ? 1 : -1)));
        setFocusRow(nx);
        boardRef.current?.querySelector(`[data-row="${nx}"]`)?.scrollIntoView({ block: "nearest" });
      } else if ((k === "Enter" || k === "o") && focusRow >= 0 && rows[focusRow]) {
        if (k === "Enter" && t && t !== document.body && /^(A|BUTTON|SUMMARY)$/.test(t.tagName)) return;
        e.preventDefault();
        router.push(`/line/${rows[focusRow].token}`);
      } else if (k === "p" && focusRow >= 0 && rows[focusRow]) {
        e.preventDefault();
        const c = rows[focusRow];
        if (!watch.includes(c.token)) seedSeen(c);
        toggleWatch(c.token);
      } else if (/^[1-5]$/.test(k)) {
        e.preventDefault();
        pickTab(TABS[Number(k) - 1].id);
      }
    };
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const missingSet = useMemo(() => new Set(missing), [missing]);
  const foundCount = watch.filter((t) => !missingSet.has(t)).length;
  // pinned tokens that moved since they were last seen (fresh rows on screen win over the background check)
  const newCount = useMemo(() => {
    if (tab === "watch") return 0;
    const w = new Set(watch);
    const m = new Map<string, Card>();
    for (const c of bgWatch) if (w.has(c.token)) m.set(c.token, c);
    for (const c of items) if (w.has(c.token)) m.set(c.token, c);
    let k = 0;
    for (const c of m.values()) if (moved(deltaOf(c, seen[c.token]))) k++;
    return k;
  }, [tab, watch, bgWatch, items, seen]);
  const stubs = tab === "watch" && state !== "loading" ? missing.filter((t) => watch.includes(t)) : [];

  const ariaSort = (k: SortKey): "ascending" | "descending" | "none" => (sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
  // a header sorts within the tab (press again to flip); the tab itself already picked the order
  const th = (k: SortKey, label: string, className: string, title: string) => (
    <div role="columnheader" aria-sort={ariaSort(k)} className={`${styles.th} ${className} ${sort.key === k ? styles.thOn : ""}`}>
      <button type="button" onClick={() => pickSort(k)} title={title}>
        {label}
        {sort.key === k && <i aria-hidden>{sort.dir === "desc" ? "↓" : "↑"}</i>}
      </button>
    </div>
  );

  const prefix = PART_ADDR.test(query);
  // one empty state for every "nothing to show" (never a table head over a void)
  const tryAgain = (
    <button type="button" className={styles.ghostBtn} onClick={refresh}>
      Try again
    </button>
  );
  const empty: { title: string; body: string; action: React.ReactNode } | null =
    down && items.length === 0 && !stubs.length
      ? { title: "Can't load launches right now.", body: lastTry === null ? "" : `Last try ${hhmm(lastTry)}.`, action: tryAgain }
      : state === "loading" || state === "error" || stubs.length || rows.length > 0
      ? null
      : riskHidden > 0
        ? {
            title: "Every row here is high risk",
            body: `${riskHidden} ${riskHidden === 1 ? "token is" : "tokens are"} hidden by Hide high risk.`,
            action: (
              <button type="button" className={styles.ghostBtn} onClick={() => setRisk(false)}>
                Show all
              </button>
            ),
          }
      : tab === "watch"
        ? watch.length === 0
          ? {
              title: "Nothing pinned yet",
              body: "Tap ☆ on any row to keep a token here. Saved in this browser.",
              action: (
                <button type="button" className={styles.ghostBtn} onClick={() => pickTab("new")}>
                  See new launches
                </button>
              ),
            }
          : {
              title: "Pinned tokens didn't load",
              body: "The directory returned none of them.",
              action: tryAgain,
            }
        : prefix || query
          ? {
              title: "No match in this list",
              body: prefix ? `No token starts with ${query}. Paste the full address.` : `No launches match “${query}” here.`,
              action: (
                <button type="button" className={styles.ghostBtn} onClick={clearQuery}>
                  Clear search
                </button>
              ),
            }
          : {
              title: "This list is empty right now",
              body: "Launches show up here as they happen.",
              action:
                tab === "new" ? null : (
                  <button type="button" className={styles.ghostBtn} onClick={() => pickTab("new")}>
                    See new launches
                  </button>
                ),
            };

  // one quiet status for every failure on this screen: it sits in the toolbar, the rows keep their place
  const status =
    down ? (
      // no rows: the empty state says it; rows on screen: here, over them
      items.length === 0 && !stubs.length ? null : (
        <span className={styles.status} role="status" style={{ whiteSpace: "normal" }}>
          Can&apos;t load launches right now.{lastTry !== null && ` Last try ${hhmm(lastTry)}.`}
          <button type="button" className={styles.inlineBtn} onClick={refresh}>
            Try again
          </button>
        </span>
      )
    ) : conn === "limited" || conn === "retry" ? (
      // tries are left: it asks again by itself. No rows: the skeleton says "loading"; rows on screen: they are old
      items.length === 0 ? null : (
        <span className={styles.status} role="status" title="The list isn't answering. Asking again by itself.">
          Stale
        </span>
      )
    ) : v6 === "error" && tab !== "watch" ? (
      <span className={styles.statusQuiet} role="status" title="Taxed v6 launches may be missing from this list.">
        Partial list
      </span>
    ) : null;

  // the Price cell: the line (24 h, or since launch for a younger token) and its % from the first to the last trade.
  // Under 2 trades there is no line yet: a quiet "new". Unknown is a dash, never a flat line.
  const priceCell = (c: Card, sp: SparkData | null | undefined, chg: number | null, chgCls: string) => {
    if (sp && sp.x.length && sp.trades !== undefined && sp.trades < 2)
      return (
        <span className={styles.pNew} title="Too few trades for a price line yet">
          new
        </span>
      );
    const span = sp?.life ? "since launch" : "over 24 h";
    return (
      <>
        <Sparkline className={styles.spark} data={sp} period={period} />
        <span
          className={`${styles.chg} ${sp === undefined ? styles.chgWait : chgCls}`}
          title={sp === undefined ? undefined : chg === null ? (sp === null ? "Price unknown right now, not zero." : "No trades in the last 24 h.") : `Price ${span}, first to last trade`}
        >
          {sp === undefined ? "" : chg === null ? "—" : chgText(chg)}
        </span>
      </>
    );
  };

  const staleSince = (c: Card) => {
    const at = seenAt.get(c.token);
    return now !== null && at !== undefined && now - at > STALE_MS ? at : null;
  };

  const Heading = home ? "h2" : "h1"; // "/" has the hero's H1; /launches has only the board
  const sortedNote = sort.key !== DEFAULT_SORT[tab] || sort.dir !== naturalDir(DEFAULT_SORT[tab]);
  const nf = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));

  return (
    <div className={styles.root}>
      {home ? (
        // "/" already has its title line and search above: the board's own heading is for screen readers only
        <Heading id="board" className="srOnly">
          All launches
        </Heading>
      ) : (
        <div className={styles.ph}>
          <Heading id="board" className={styles.title}>
            Live launches
          </Heading>
          <p className={styles.lead}>Every vibe/vibe launch, live: price, time to graduation, volume.</p>
        </div>
      )}

      {/* one toolbar: the list (tabs) on the left; status, Sort and Refresh on the right */}
      <div className={styles.bar}>
        <div className={`${styles.tabs} fadeX`} role="tablist" aria-label="List" ref={tabsRef} onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              className={`${styles.tab} ${tab === t.id ? styles.tabOn : ""}`}
              onClick={() => pickTab(t.id)}
              title={t.caption}
              aria-label={t.short ? t.label : undefined}
            >
              {t.short ? (
                <>
                  <span className={styles.tLong}>{t.label}</span>
                  <span className={styles.tShort} aria-hidden>
                    {t.short}
                  </span>
                </>
              ) : (
                t.label
              )}
              {t.id === "watch" && newCount > 0 ? (
                <span className={styles.newCount} title="Pinned tokens that moved since you last looked">
                  {newCount} new
                </span>
              ) : (
                t.id === "watch" && foundCount > 0 && <span className={styles.count}>{foundCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className={styles.tools}>
          {status}
          <button
            type="button"
            role="switch"
            aria-checked={hideRisk}
            className={`${styles.risk} ${hideRisk ? styles.riskOn : ""}`}
            onClick={() => setRisk(!hideRisk)}
            title="Hide tokens graded D or F. Tokens not graded yet stay."
          >
            <i aria-hidden />
            Hide high risk
          </button>
          <button
            type="button"
            className={`${styles.refresh} ${manualBusy ? styles.refreshOn : ""}`}
            onClick={refresh}
            aria-label="Refresh the list"
            aria-busy={manualBusy}
            title="Refresh the list (the tab, sort and search stay)"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
              <path d="M13.6 1.8v3.6H10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
            </svg>
            <Updated at={updatedAt} />
          </button>
        </div>
      </div>

      {/* only when there is something to say: the search in force, launches held behind the pill */}
      {((query && tab !== "watch") || (tab === "new" && pending.length > 0 && state !== "loading")) && (
        <p className={styles.sum} aria-live="polite">
          {query && (
            <span className={styles.qpill}>
              {prefix ? "Address starts with" : "Search"} <b>“{query}”</b>
              <button type="button" onClick={clearQuery} aria-label="Clear search" title="Clear search">
                ×
              </button>
            </span>
          )}
          {/* New tab: launches found by the refresh wait here (never over the table header) */}
          {tab === "new" && pending.length > 0 && state !== "loading" && (
            <button type="button" className={styles.newPill} onClick={showPending}>
              ↑ {pending.length} new
            </button>
          )}
        </p>
      )}

      <div
        ref={boardRef}
        className={`${styles.board} ${swapping ? styles.fresh : ""} ${tab === "new" ? styles.tabNew : ""}`}
        role="table"
        aria-label="Live launches"
        aria-busy={isLoading || busy}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") hovering.current = true;
        }}
        onPointerLeave={() => {
          hovering.current = false;
        }}
      >
        {/* thin bar over the list while it refreshes with the old rows still on screen (no layout shift) */}
        <div className={`${styles.progress} ${busy || state === "more" ? styles.progressOn : ""}`} aria-hidden />
        <div ref={headRef} className={`${styles.row} ${styles.head}`} role="row" hidden={!!empty}>
          <div role="columnheader" className={`${styles.th} ${styles.cTok}`}>Token</div>
          {th("chg", "Price 24h", styles.cSpark, "Sort by price change over 24 h (or since launch for a younger token)")}
          {tab === "grad" ? (
            <div role="columnheader" className={`${styles.th} ${styles.cDoor}`} title="When the token graduated (this tab's order)">
              Graduated
            </div>
          ) : (
            th("door", "To graduation", styles.cDoor, "Sort by progress to graduation")
          )}
          {th("holders", "Holders", styles.cIn, "Sort by holders")}
          {th("vol", "Vol 24h", styles.cVol, "Sort by ETH traded in the last 24 h")}
          <div role="columnheader" className={styles.cStar}>
            <span className={styles.sr}>Pin</span>
          </div>
        </div>

        {/* one element for loading and leaving: in the flow while loading, then an overlay that fades out
            while the rows fade in */}
        {(isLoading || swapping) && (
          <div key="boarding" className={isLoading ? styles.bIn : styles.bOut} style={isLoading ? undefined : { top: headH }} aria-hidden>
            {/* tall enough to keep the footer below the fold while the list loads (8 rows let it jump: CLS 0.18) */}
            <BoardingRows count={tab === "watch" ? 4 : 14} />
          </div>
        )}
        {state === "loading" || (state === "error" && items.length === 0)
          ? null
          : rows.map((c, i) => {
              const pct = c.progressBps / 100;
              const f = flash[c.token];
              const pinned = watch.includes(c.token);
              const vol = c.volume24hEth;
              const title = `$${c.symbol || "???"}`;
              const stale = staleSince(c);
              const d = tab === "watch" && baseline ? deltaOf(c, baseline[c.token]) : null;
              const since = tab === "watch" && baseline ? sinceText(d, now) : null;
              const parts = d ? sinceParts(d) : [];
              const ageTxt = now !== null && c.createdAt ? age(c.createdAt, now) : null;
              // the sub-line, fixed slots in a fixed order: name · age · one flag. The flag is the grade's top reason
              // (screen() lists the worst first), only when it is a warning or worse; no grade yet, no flag
              const sr = graded.get(c.token.toLowerCase());
              const top = sr?.grade ? sr.reasons[0] : undefined;
              const flag = top && (top.level === "bad" || top.level === "warn") ? top : null;
              const sp = spark.get(c.token);
              const spv = sparkFor(sp, period);
              const chg = sparkChg(spv);
              const chgCls = chg === null || flatBps(chg) ? styles.unk : chg > 0 ? styles.up : styles.down;
              return (
                <div
                  key={c.token}
                  role="row"
                  data-row={i}
                  className={`${styles.row} ${f ? (f < 0 ? styles.rowNew : styles.rowBuy) : ""} ${stale ? styles.stale : ""} ${focusRow === i ? styles.rowFocus : ""}`}
                  title={stale ? `Not refreshed since ${clock(stale)}: these numbers may be old` : undefined}
                  onPointerEnter={() => warm(c, pre)}
                  onPointerLeave={unwarm}
                  onPointerDown={() => warmNow(c, pre) /* a tap: start at once, the click follows in ~100 ms */}
                >
                  <div role="cell" className={styles.cTok}>
                    <Link
                      className={styles.tok}
                      href={`/line/${c.token}`}
                      prefetch={false}
                      onFocus={() => warm(c, pre)}
                      aria-label={`${title}, ${c.name}${ageTxt ? `, ${ageTxt} old` : ""}${sr?.grade ? `, grade ${sr.grade}` : ""}${flag ? `: ${flag.text}` : ""}. Open the token page${since ? `. ${since}` : ""}`}
                    >
                      <GradeBadge grade={sr?.grade ?? null} noGrade={sr?.metrics.noGrade} size="sm" title={sr?.grade ? `Grade ${sr.grade}, ${standingWord(sr.grade)} (${coverageWord(sr.metrics.coverage)}): ${sr.reasons.map((x) => x.text).join(" · ") || "no flags"}` : standingWord(null, sr?.metrics.noGrade)} />
                      <span className={styles.logo}>
                        <TokenAvatar src={c.image} symbol={c.symbol} size={28} /* lazy: an eager logo becomes a <link rel=preload> on every page that prefetched "/" */ />
                      </span>
                      <span className={styles.names}>
                        <b className={styles.sym}>{title}</b>
                        <small className={styles.meta}>
                          <span className={styles.mName}>{c.name || "—"}</span>
                          {ageTxt && <span className={styles.mAge} title={`Launched ${ageTxt} ago`}>{ageTxt}</span>}
                          {flag && <span className={`${styles.mFlag} ${flag.level === "bad" ? styles.hiBad : styles.hiWarn}`}>{flag.text}</span>}
                        </small>
                        {since !== null && (
                          <small className={styles.since} title={since}>
                            {d ? (
                              <>
                                {parts.length
                                  ? parts.map((x, k) => (
                                      <span key={x.text}>
                                        {k > 0 && " · "}
                                        <span className={styles[`s_${x.tone}`]}>{x.text}</span>
                                      </span>
                                    ))
                                  : "No change"}
                                {now !== null ? ` · ${ago(d.since, now)}` : ""}
                              </>
                            ) : (
                              "Changes show from your next visit"
                            )}
                          </small>
                        )}
                      </span>
                    </Link>
                  </div>
                  <div role="cell" className={styles.cSpark}>
                    {priceCell(c, spv, chg, chgCls)}
                  </div>
                  <div role="cell" className={styles.cDoor}>
                    {c.graduated ? (
                      // the Graduated tab: every row graduated, so the cell says when; elsewhere a quiet label
                      tab === "grad" ? (
                        <span className={styles.grad} title={c.graduatedAt ? `Graduated ${new Date(c.graduatedAt * 1000).toLocaleString()}` : "Graduation time unknown"}>
                          <span className={styles.mobOnly}>Graduated </span>
                          {c.graduatedAt && now !== null ? `${age(c.graduatedAt, now)} ago` : "—"}
                        </span>
                      ) : (
                        <span className={styles.grad}>Graduated</span>
                      )
                    ) : (
                      <span className={styles.doorTop} title={`${pctText(c.progressBps)} of the way to graduation`}>
                        <span className={styles.meter} aria-hidden>
                          <i className={pct >= 85 ? styles.meterHot : undefined} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                        </span>
                        <span className={styles.pct}>{pctText(c.progressBps)}</span>
                      </span>
                    )}
                  </div>
                  {(() => {
                    // real holders (bought in, more than dust) once the grade has read them; vibe's raw count until then
                    const real = sr && sr.metrics.holdersAll !== undefined && sr.metrics.holders !== null ? sr.metrics.holders : null;
                    const raw = real !== null ? sr!.metrics.holdersAll ?? c.holders : c.holders;
                    const tip = real !== null
                      ? raw !== null && raw > real ? `${real.toLocaleString("en-US")} real holders; ${raw.toLocaleString("en-US")} incl. ${(raw - real).toLocaleString("en-US")} airdropped or dust` : "Real holders: bought in and hold more than dust"
                      : c.holders === null ? "Unknown, not zero." : undefined;
                    const n = real ?? c.holders;
                    return (
                      <div role="cell" className={`${styles.num} ${styles.cIn} ${n === null ? styles.unk : ""}`} title={tip}>
                        {nf(n)}
                      </div>
                    );
                  })()}
                  <div
                    role="cell"
                    className={`${styles.num} ${styles.cVol} ${vol === null || vol === 0 ? styles.unk : ""}`}
                    title={c.v6 && c.v6.pair !== "ETH" ? `Traded in ${c.v6.pair}: no ETH volume to show` : vol === null ? "Unknown, not zero." : undefined}
                  >
                    {eth(vol)}
                    {/* phones have no column head: the unit and window ride along */}
                    {vol !== null && <span className={styles.volUnit}> ETH 24h</span>}
                    {f ? <i className={styles.bump}>{f < 0 ? "new" : `+${f}`}</i> : null}
                  </div>
                  <div role="cell" className={styles.cStar}>
                    <button
                      type="button"
                      className={`${styles.star} ${pinned ? styles.starOn : ""}`}
                      aria-pressed={pinned}
                      aria-label={pinned ? `Remove ${title} from watchlist` : `Add ${title} to watchlist`}
                      title={pinned ? "Unpin" : "Pin to your Watchlist"}
                      onClick={() => {
                        if (!pinned) seedSeen(c); // a new pin: its "since" starts now
                        toggleWatch(c.token);
                      }}
                    >
                      {pinned ? "★" : "☆"}
                    </button>
                  </div>
                </div>
              );
            })}

        {stubs.map((t) => (
          <div key={t} role="row" className={`${styles.row} ${styles.stub}`}>
            <div role="cell" className={styles.cTok}>
              <span className={styles.names}>
                <b className={styles.addr}>{shortAddr(t)}</b>
                <small className={styles.meta}>Didn&apos;t load.</small>
              </span>
            </div>
            <div role="cell" className={styles.cStar}>
              <button type="button" className={styles.star} aria-label={`Remove ${shortAddr(t)} from watchlist`} title="Remove from watchlist" onClick={() => toggleWatch(t)}>
                ×
              </button>
            </div>
          </div>
        ))}
      </div>

      {empty && (
        <EmptyState boxed={false} className={styles.empty} title={empty.title} action={empty.action}>
          {empty.body}
        </EmptyState>
      )}

      {tab === "watch" && watch.length > WATCH_MAX && <p className={styles.fine}>Showing the first {WATCH_MAX} of {watch.length} pinned tokens.</p>}

      {next && tab !== "watch" && state !== "loading" && state !== "error" && (
        <div className={styles.more}>
          <button type="button" className={styles.ghostBtn} onClick={() => void load(tab, query, next)} disabled={state === "more"}>
            {state === "more" ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
      {sortedNote && <p className={styles.fine}>Sorted within the loaded rows</p>}

    </div>
  );
}
