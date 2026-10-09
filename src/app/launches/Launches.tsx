"use client";
// LIVE LAUNCHES: every vibe/vibe token as one live row of the board (minimal spec §3.1): grade, a thin
// progress bar to the door, holders, volume, the 24 h line and B/S; a row lights up when someone buys.
// One toolbar above it: the list (tabs), Sort, How to read (a popover) and Refresh.
import Link from "next/link";
import EmptyState from "@/components/ui/EmptyState";
import Term from "@/components/ui/Term";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { prime } from "@/lib/prime";
import Sparkline, { type SparkData } from "@/components/Sparkline";
import TokenAvatar from "@/components/TokenAvatar";
import type { LaunchCard as Card } from "@/lib/launches";
import { toggleWatch, useWatchlist } from "./watch";
import { deltaOf, markSeen, moved, readSeen, seedSeen, useSeen, type Delta, type SeenMap } from "./seen";
import { boardQuery, DEFAULT_SORT, FILTER_IDS, naturalDir, parseBoard, type BoardState, type Dir, type FilterId, type Period, type SortKey, type Tab } from "./state";
import { applyFilters, chipsFor, FILTERS, gradeTone, SIG_WINDOW, SIG_WINDOW_FILTERED, sigTitle, useSignals, type SigEntry, type SigMap } from "./signals";
import styles from "./launches.module.css";
import BoardingRows from "./Boarding";
import { fmtEth } from "@/lib/format";

type Page = { items: Card[]; next: string | null; v6?: "ok" | "error" | "off"; missing?: string[] };
type Conn = "ok" | "retry" | "limited";

// ids unchanged (shared ?tab= links keep working); one caption line under the tabs says what the list is
const TABS: { id: Tab; label: string; short?: string; caption: string }[] = [
  { id: "hot", label: "Trending", caption: "Most traded right now, in vibe/vibe's order." },
  { id: "new", label: "New", caption: "Newest launches first." },
  { id: "door", label: "Near graduation", short: "Near grad", caption: "Closest to 5 ETH on the curve, the point where trading moves to a V4 pool." },
  { id: "grad", label: "Graduated", caption: "Reached 5 ETH and moved to a V4 pool." },
  { id: "watch", label: "☆ Watchlist", short: "☆ Pins", caption: "Tokens you pinned with ☆. Saved in this browser." },
];
const POLL_MS = 30_000; // the board is CDN-cached 30 s (api/launches)
const CHUNK = 20; // /api/launches?tokens= takes 20 addresses per call
const WATCH_MAX = 60; // 3 calls at most (the list itself keeps 50)
const EXTRA_REFRESH = 40; // rows loaded with "More" refreshed per poll (2 calls), oldest first
const STALE_MS = POLL_MS * 2 + 5_000;
const PART_ADDR = /^0x[0-9a-fA-F]{4,39}$/;
const SPARK_MS = 300_000; // sparklines are CDN-cached 5 min (api/spark): no point asking more often
const SPARK_CHUNK = 24; // one board page per call (the first chunk is the same for every viewer: CDN-cached)
const SPARK_MAX = 120; // 5 calls at most per refresh
const SEEN_AFTER_MS = 30_000; // 30 s on the Watchlist = seen
const BG_WATCH_MS = 120_000; // off the Watchlist tab: check the pinned tokens every 2 min for the "new" counter
const LIST_CACHE_MAX = 10; // lists kept in memory for an instant tab switch (shown at once, refreshed behind)
const PENDING_MAX = 50; // New tab: tokens held behind the "↑ N new" pill
const HOW_ID = "board-how"; // the How to read popover

// the list's own order, named for what it is on each tab
const rankTitle = (t: Tab) => (t === "hot" ? "vibe/vibe trending order" : t === "watch" ? "your pin order" : "list order");
const rankLabel = (t: Tab) => (t === "hot" ? "Trending order" : t === "watch" ? "Pin order" : t === "grad" ? "Graduation order" : "List order");
function sortLabel(k: SortKey, period: Period, tab: Tab = "hot"): string {
  switch (k) {
    case "rank": return rankLabel(tab);
    case "new": return "Newest";
    case "door": return "Closest to grad";
    case "eta": return "Soonest ETA";
    case "holders": return "Holders";
    case "vol": return `Vol ${period}`;
    case "chg": return "Price 1h %";
    case "buys": return "Buys 1h";
    case "sig": return "Grade";
  }
}
// only columns the viewer can see are offered: holders hide under 1080 px, volume (and its period) on phones
const SORTS_WIDE: SortKey[] = ["rank", "new", "door", "eta", "sig", "holders", "vol", "chg", "buys"];
const SORTS_MID: SortKey[] = ["rank", "new", "door", "eta", "sig", "vol", "chg", "buys"];
const SORTS_PHONE: SortKey[] = ["rank", "new", "door", "eta", "sig", "chg", "buys"];

function sortValue(c: Card, k: SortKey, period: Period, rank: number, sig: SigMap): number | null {
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
    case "chg": return c.change1hBps;
    case "buys": return c.buys1h;
  }
}

function sortRows(ranked: { c: Card; i: number }[], key: SortKey, dir: Dir, period: Period, sig: SigMap): Card[] {
  const sign = dir === "desc" ? -1 : 1;
  return ranked
    .map((x) => ({ ...x, v: sortValue(x.c, key, period, x.i, sig) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1; // unknown always last, never counted as zero
      if (b.v === null) return -1;
      return a.v === b.v ? a.i - b.i : sign * (a.v - b.v);
    })
    .map((x) => x.c);
}

// viewport width class, for the sort menu only (server snapshot: wide; the client corrects after hydration)
type Width = "wide" | "mid" | "phone";
function widthNow(): Width {
  if (window.matchMedia("(max-width: 760px)").matches) return "phone";
  if (window.matchMedia("(max-width: 1080px)").matches) return "mid";
  return "wide";
}
function subscribeWidth(l: () => void) {
  const a = window.matchMedia("(max-width: 760px)");
  const b = window.matchMedia("(max-width: 1080px)");
  a.addEventListener("change", l);
  b.addEventListener("change", l);
  return () => {
    a.removeEventListener("change", l);
    b.removeEventListener("change", l);
  };
}

function age(ts: number, now: number) {
  const s = Math.max(0, Math.floor(now / 1000 - ts));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const eth = (v: number | null) => (v === null ? "—" : v > 0 && v < 0.001 ? "<0.001" : fmtEth(v));
function eta(h: number | null) {
  if (h === null) return null;
  if (h < 1) return "~<1h";
  if (h < 48) return `~${Math.round(h)}h`;
  if (h < 24 * 30) return `~${Math.round(h / 24)}d`;
  return "~30d+";
}
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
const taxText = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}% tax`;
// New tab: how the first minutes went, from numbers already in the list. A 1h window covers the whole life of
// a token under an hour old (and 24 h for v6), so there it reads "so far"; older, the window is named.
function earlyText(c: Card, ageS: number | null): { text: string; hot: boolean } | null {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (c.v6) {
    if (c.buys24h === null) return null;
    const so = ageS !== null && ageS < 86_400 ? "so far" : "24h";
    return { text: `${plural(c.buys24h, "buy")}${c.sells24h ? ` / ${plural(c.sells24h, "sell")}` : ""} ${so}`, hot: c.buys24h >= 10 };
  }
  if (c.buys1h === null) return null;
  const so = ageS !== null && ageS < 3_600 ? "so far" : "1h";
  const who = c.buyers1h !== null && c.buyers1h > 0 ? `${plural(c.buyers1h, "buyer")} · ` : "";
  return { text: c.buys1h === 0 ? `no buys ${so === "so far" ? "yet" : "this hour"}` : `${who}${plural(c.buys1h, "buy")} ${so}`, hot: (c.buyers1h ?? 0) >= 10 };
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
  const width = useSyncExternalStore(subscribeWidth, widthNow, () => "wide" as Width);
  const [tab, setTab] = useState<Tab>(board.tab);
  const [query, setQuery] = useState(board.q.replace(/^\$/, ""));
  const [items, setItems] = useState<Card[]>(initial?.items ?? []);
  const [next, setNext] = useState<string | null>(initial?.next ?? null);
  const [v6, setV6] = useState<Page["v6"]>(initial?.v6 ?? "off");
  const [missing, setMissing] = useState<string[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "error" | "more">(initial ? "ok" : "loading");
  // no first page from the server (slow or failed) is not an error yet: the client load right after decides
  const [conn, setConn] = useState<Conn>("ok");
  const [flash, setFlash] = useState<Record<string, number>>({}); // token -> new buys since the last look (-1 = new row)
  const [period, setPeriod] = useState<Period>(board.period);
  // filter chips were removed from the board : the list always shows every row
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
  const isLoading = state === "loading" || (state === "error" && items.length === 0);
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
    if (e instanceof HttpError && e.status === 429) {
      setConn("limited");
      pauseUntil.current = Date.now() + Math.min(60, Math.max(5, e.retryAfter || 30)) * 1000;
    } else setConn("retry");
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
            setConn("ok");
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
          else setConn("ok");
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
        setConn("ok");
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
        // quiet (rows on screen): the rows stay, the pill says "Reconnecting…" over them
      } finally {
        if (id === reqId.current) {
          inflight.current = false;
          setBusy(false);
          setManualBusy(false);
        }
      }
    },
    [fail],
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
    const t = setTimeout(() => void load(tab, query, null), 0);
    return () => clearTimeout(t);
  }, [tab, query, watchKey, load]);

  // the board is alive: refresh while the tab is visible; a failed board keeps retrying (after a 429: after retry-after)
  // (hidden browser tab: no requests at all; back on it after a while: one refresh right away, not a wait of up to 15 s)
  useEffect(() => {
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() < pauseUntil.current) return;
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

  // 24 h sparklines for the rows on screen: v1 rows only (vibe has none for v6), a page of rows per call,
  // each row asked again once a minute at most; a failed call leaves those rows "unknown", not flat
  const sparkKey = items
    .filter((c) => !c.v6)
    .slice(0, SPARK_MAX)
    .map((c) => c.token)
    .join(",");
  useEffect(() => {
    if (!sparkKey) return;
    let dead = false;
    const run = async () => {
      if (document.visibilityState !== "visible" || Date.now() < pauseUntil.current) return;
      const list = sparkKey.split(",");
      const n = Date.now();
      const need = chunks(list, SPARK_CHUNK).filter((ch) => ch.some((t) => n - (sparkAt.current.get(t) ?? 0) >= SPARK_MS));
      if (!need.length) return;
      for (const ch of need) for (const t of ch) sparkAt.current.set(t, n); // no double asks while in flight
      const got = await Promise.allSettled(need.map((ch) => getJson<{ items?: Record<string, SparkData> }>(`/api/spark?tokens=${[...ch].sort().join(",")}`)));
      need.forEach((ch, i) => {
        if (got[i].status === "rejected") for (const t of ch) sparkAt.current.delete(t); // asked again next round
      });
      if (dead) return;
      setSpark((prev) => {
        const keep = new Set(list);
        const m = new Map(prev.size < 300 ? prev : [...prev].filter(([t]) => keep.has(t)));
        need.forEach((ch, i) => {
          const r = got[i];
          for (const t of ch) {
            if (r.status === "fulfilled") m.set(t, r.value.items?.[t] ?? null);
            else if (!m.has(t)) m.set(t, null);
          }
        });
        return m;
      });
    };
    const t = setTimeout(() => void run(), 300);
    const iv = setInterval(() => void run(), SPARK_MS / 2);
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
      setPeriod(b.period);
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
  const base = useMemo(() => {
    // Watchlist: an unpinned row leaves at once (no reload of the whole list for it)
    const pinnedSet = tab === "watch" ? new Set(watchD) : null;
    const ranked = (pinnedSet ? items.filter((c) => pinnedSet.has(c.token)) : items).map((c, i) => ({ c, i }));
    const sort = sortD;
    const period = periodD;
    if (sort.key === "sig" || (sort.key === "rank" && sort.dir === "desc")) return ranked.map((x) => x.c);
    return sortRows(ranked, sort.key, sort.dir, period, emptySig);
  }, [items, sortD, periodD, tab, watchD, emptySig]);

  // board signals: lazily, for the first 60 rows on screen, never blocking the list; with a filter that needs
  // them on, every loaded row is asked (150 at most), so "checking" always ends
  const paused = useCallback(() => Date.now() < pauseUntil.current, []);
  const sigFilterOn = filtersD.some((f) => FILTERS.some((x) => x.id === f && x.needsSignals));
  const sigMax = sigFilterOn ? SIG_WINDOW_FILTERED : SIG_WINDOW;
  const sig = useSignals(base, { paused, window: sigMax });
  const sigWindow = useMemo(() => new Set(base.filter((c) => !c.v6).slice(0, sigMax).map((c) => c.token)), [base, sigMax]);

  const sorted = useMemo(
    () => (sortD.key === "sig" ? sortRows(base.map((c, i) => ({ c, i })), "sig", sortD.dir, periodD, sig) : base),
    [base, sortD, periodD, sig],
  );
  const nowSec = now === null ? null : Math.floor(now / 1000);
  const filtered = useMemo(() => applyFilters(sorted, filtersD, sig, nowSec, sigWindow), [sorted, filtersD, sig, nowSec, sigWindow]);
  const rows = filtered.rows;
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
      } else if (k === "?") {
        e.preventDefault();
        (document.getElementById(HOW_ID) as (HTMLElement & { togglePopover?: () => void }) | null)?.togglePopover?.();
      }
    };
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // free risk flag: a ticker already used by an older token in the rows on screen
  const dupOf = useMemo(() => {
    const first = new Map<string, Card>();
    for (const c of items) {
      const k = c.symbol.trim().toLowerCase();
      if (!k || !c.createdAt) continue;
      const f = first.get(k);
      if (!f || c.createdAt < f.createdAt) first.set(k, c);
    }
    return (c: Card) => {
      const f = first.get(c.symbol.trim().toLowerCase());
      return f && f.token !== c.token && c.createdAt > f.createdAt ? f : null;
    };
  }, [items]);

  // free dev flag: how many rows on screen this creator launched (2+ = a serial launcher, visible at a glance)
  const devCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of items) if (c.creator) m.set(c.creator, (m.get(c.creator) ?? 0) + 1);
    return m;
  }, [items]);

  const sortOptions = useMemo(() => {
    const base = width === "phone" ? SORTS_PHONE : width === "mid" ? SORTS_MID : SORTS_WIDE;
    return base.includes(sort.key) ? base : [...base, sort.key]; // a sort from a shared link stays visible in the menu
  }, [width, sort.key]);

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
  const th = (k: SortKey, label: string, className: string, opts: { short?: string; term?: React.ReactNode; extra?: React.ReactNode } = {}) => (
    <div role="columnheader" aria-sort={ariaSort(k)} className={`${styles.th} ${className} ${sort.key === k ? styles.thOn : ""}`}>
      <button type="button" onClick={() => pickSort(k)} title={`Sort by ${k === "rank" ? rankTitle(tab) : sortLabel(k, period, tab)}`}>
        {opts.short ? (
          <>
            <span className={styles.thLong}>{label}</span>
            <span className={styles.thShort} aria-hidden>{opts.short}</span>
          </>
        ) : (
          label
        )}
        {sort.key === k && <i aria-hidden>{sort.dir === "desc" ? "↓" : "↑"}</i>}
      </button>
      {opts.term}
      {opts.extra}
    </div>
  );

  const prefix = PART_ADDR.test(query);
  // one empty state for every "nothing to show" (never a table head over a void)
  const empty: { title: string; body: string; action: React.ReactNode } | null =
    state === "loading" || state === "error" || stubs.length || items.length > 0
      ? null
      : tab === "watch"
        ? watch.length === 0
          ? {
              title: "Nothing pinned yet",
              body: "Tap ☆ on any row to keep a token here. Saved in this browser.",
              action: (
                <button type="button" className={styles.ghostBtn} onClick={() => pickTab("hot")}>
                  See trending
                </button>
              ),
            }
          : {
              title: "Pinned tokens didn't load",
              body: "The directory isn't answering. Retrying by itself.",
              action: (
                <button type="button" className={styles.ghostBtn} onClick={() => void load(tab, query, null)}>
                  Retry now
                </button>
              ),
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
                tab === "hot" ? null : (
                  <button type="button" className={styles.ghostBtn} onClick={() => pickTab("hot")}>
                    See trending
                  </button>
                ),
            };

  // one quiet status for every failure on this screen: it sits in the toolbar, the rows keep their place
  const status =
    conn === "limited" ? (
      <span className={styles.status} role="status" title="Too many requests. Retrying by itself.">
        Rate-limited · retrying
      </span>
    ) : conn === "retry" ? (
      <span className={styles.status} role="status" title="The directory isn't answering.">
        Retrying…
        <button type="button" className={styles.inlineBtn} onClick={() => void load(tab, query, null, items.length > 0)}>
          Retry now
        </button>
      </span>
    ) : v6 === "error" && tab !== "watch" ? (
      <span className={styles.statusQuiet} role="status" title="Taxed v6 launches may be missing from this list.">
        Partial list
      </span>
    ) : null;

  // a signal chip (spec §1.6): a small square in the tone, plain text, no box
  type ChipT = ReturnType<typeof chipsFor>[number];
  const chip = (x: ChipT) => (
    <span key={x.text} className={styles.chip} title={x.title}>
      <i className={styles[`sq_${x.tone}`]} aria-hidden />
      <span className={styles.chipText}>{x.text}</span>
    </span>
  );
  const chipList = (chips: ChipT[]) => (chips.length > 0 ? <span className={styles.chips}>{chip(chips[0])}</span> : null);

  // the Grade cell: a Line Health letter and the worst flag; unknown is a dash with its reason, never a grade
  const sigCell = (c: Card) => {
    const e: SigEntry | undefined = sig.get(c.token);
    const dash = (title: string, chips: ChipT[] = []) => (
      <span key="dash" className={`${styles.sig} ${styles.sigIn}`} title={title}>
        <b className={`${styles.gr} ${styles.grNone}`} aria-label={title}>—</b>
        {chipList(chips)}
      </span>
    );
    if (c.v6) return dash("No Line Health for taxed v6 launches: not a v1 curve.", chipsFor(c, null));
    if (!sigWindow.has(c.token) && (e === undefined || e === "loading")) return dash(`Grades load for the first ${sigMax} rows on screen.`);
    if (e === undefined || e === "loading")
      return (
        <span key="load" className={styles.sig} aria-label="Loading the grade">
          <span className={`${styles.gBar} ${styles.grLoad}`} />
        </span>
      );
    if (e === "error") return dash("The grade didn't load. Retrying.");
    if (e.status === "unknown") return dash("Couldn't read this line on the chain right now: unknown, not clean. Retrying.");
    if (e.status === "not_v1") return dash("Not a vibe/vibe v1 launch: no Line Health.");
    const chips = chipsFor(c, e);
    if (e.status === "early" || !e.grade) {
      const why = `Too early to grade: only ${e.firstBuyers ?? 0} ${e.firstBuyers === 1 ? "buyer" : "buyers"} so far, the front of the line isn't formed yet.`;
      return (
        <span key="early" className={`${styles.sig} ${styles.sigIn}`} title={why}>
          <b className={styles.grEarly} aria-label={why}>new</b>
          {chipList(chips)}
        </span>
      );
    }
    const title = sigTitle(e);
    // a C-F letter never stands alone: with no flag chip, the worst reason of the check speaks for it
    if (!chips.length && gradeTone(e.grade) !== "good") {
      const r = e.reasons.find((x) => x.severity === "high" || x.severity === "medium" || x.severity === "low");
      if (r) chips.push({ text: r.label, tone: r.severity === "high" ? "bad" : "warn", title: r.label });
    }
    return (
      <span key="ok" className={`${styles.sig} ${styles.sigIn}`} title={title}>
        <b className={`${styles.gr} ${styles[`grade_${gradeTone(e.grade)}`]} ${e.partial ? styles.grPartial : ""}`} aria-label={`Grade ${e.grade}${e.partial ? ", partial" : ""}`}>
          {e.grade}
          {e.partial ? "*" : ""}
        </b>
        {chipList(chips)}
      </span>
    );
  };

  const staleSince = (c: Card) => {
    const at = seenAt.get(c.token);
    return now !== null && at !== undefined && now - at > STALE_MS ? at : null;
  };

  const Heading = home ? "h2" : "h1"; // "/" has the hero's H1; /launches has only the board
  const sortedNote = sort.key !== DEFAULT_SORT[tab] || sort.dir !== naturalDir(DEFAULT_SORT[tab]);
  const nf = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));

  const sortSelect = (
    <label className={styles.sel}>
      <span>Sort</span>
      <select
        value={sort.key}
        onChange={(e) => {
          const k = e.target.value as SortKey;
          setSort({ key: k, dir: naturalDir(k) });
        }}
      >
        {sortOptions.map((k) => (
          <option key={k} value={k} title={k === "rank" ? rankTitle(tab) : undefined}>
            {sortLabel(k, period, tab)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className={styles.root}>
      {home ? (
        <Heading id="board" className={styles.sr}>
          Live launches
        </Heading>
      ) : (
        <div className={styles.ph}>
          <Heading id="board" className={styles.title}>
            Live launches
          </Heading>
          <p className={styles.lead}>Every vibe/vibe launch, live: the grade of the first buyers, time to graduation, volume. Signals, not verdicts.</p>
        </div>
      )}

      {/* one toolbar: the list (tabs) on the left; status, Sort, How to read and Refresh on the right */}
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
          {sortSelect}
          <button type="button" className={`${styles.ghostBtn} ${styles.howBtn}`} popoverTarget={HOW_ID}>
            How to read
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

      {/* only when there is something to say: the search in force, launches held behind the pill, a slow first load */}
      {((query && tab !== "watch") || (tab === "new" && pending.length > 0 && state !== "loading") || (isLoading && state === "error")) && (
        <p className={styles.sum} aria-live="polite">
          {isLoading && state === "error" && <span>The list isn&apos;t answering yet. Retrying…</span>}
          {query && tab !== "watch" && (
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
        aria-busy={state === "loading" || busy || (state === "error" && items.length === 0)}
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
          {th("rank", "#", styles.cRank)}
          <div role="columnheader" className={`${styles.th} ${styles.cTok}`}>Token</div>
          {th("sig", "Grade", styles.cSig, { term: <Term id="health" icon /> })}
          {th("door", "To grad", styles.cDoor, { term: <Term id="to-grad" icon /> })}
          {th("holders", "Holders", styles.cIn)}
          {th("vol", "Vol", styles.cVol, {
            extra: (
              <span className={styles.seg} role="group" aria-label="Volume period">
                {(["1h", "24h"] as Period[]).map((p) => (
                  <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)} title={`Volume over the last ${p}`}>
                    {p}
                  </button>
                ))}
              </span>
            ),
          })}
          {th("chg", "24h", styles.cSpark)}
          {th("buys", "B/S 1h", styles.cBs, { term: <Term id="b-s" icon /> })}
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
              const vol = period === "1h" ? c.volume1hEth : c.volume24hEth;
              const e = eta(c.etaHours);
              const title = `$${c.symbol || "???"}`;
              const dup = dupOf(c);
              const stale = staleSince(c);
              const d = tab === "watch" && baseline ? deltaOf(c, baseline[c.token]) : null;
              const since = tab === "watch" && baseline ? sinceText(d, now) : null;
              const parts = d ? sinceParts(d) : [];
              const ageS = now !== null && c.createdAt ? Math.max(0, now / 1000 - c.createdAt) : null;
              const fresh = ageS !== null && ageS < 30 * 60;
              const devN = devCount.get(c.creator) ?? 0;
              const early = tab === "new" ? earlyText(c, ageS) : null;
              const ageTxt = now !== null && c.createdAt ? age(c.createdAt, now) : null;
              // the meta line under the ticker: name · age, then the free flags as words (no boxes)
              const meta: React.ReactNode[] = [];
              if (tab === "new" && ageTxt)
                meta.push(
                  <span key="age" className={fresh ? styles.hiGood : styles.hi} title={`Launched ${ageTxt} ago`}>
                    {ageTxt}
                  </span>,
                );
              meta.push(<span key="name">{c.name}</span>);
              if (tab !== "new" && ageTxt) meta.push(<span key="age">{ageTxt}</span>);
              if (early) meta.push(<span key="early" className={early.hot ? styles.hiGood : undefined}>{early.text}</span>);
              if (devN >= 2)
                meta.push(
                  <span key="dev" className={styles.hi} title={`This creator (${shortAddr(c.creator)}) launched ${devN} tokens on this list.`}>
                    dev ×{devN}
                  </span>,
                );
              if (dup)
                meta.push(
                  <span key="clone" className={styles.hiBad} title={`An older token already uses ${title} (${shortAddr(dup.token)}). Only the first one is the original: check the contract.`}>
                    clone
                  </span>,
                );
              if (c.v6)
                meta.push(
                  <span key="tax" className={styles.hi} title={`Taxed v6 launch: ${taxText(c.v6.taxBps)} on every trade, paired with ${c.v6.pair}. Line ranked by bag.`}>
                    {taxText(c.v6.taxBps)}
                    {c.v6.pair !== "ETH" ? ` · ${c.v6.pair} pair` : ""}
                  </span>,
                );
              const chg = c.change1hBps;
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
                  <div role="cell" className={`${styles.num} ${styles.cRank} ${styles.rank}`}>{i + 1}</div>
                  <div role="cell" className={styles.cTok}>
                    <Link
                      className={styles.tok}
                      href={`/line/${c.token}`}
                      prefetch={false}
                      onFocus={() => warm(c, pre)}
                      aria-label={`${title}, ${c.name}: open the token page${c.v6 ? " (taxed v6 launch, ranked by bag)" : ""}${since ? `. ${since}` : ""}`}
                    >
                      <span className={styles.logo}>
                        <TokenAvatar src={c.image} symbol={c.symbol} size={28} /* lazy: an eager logo becomes a <link rel=preload> on every page that prefetched "/" */ />
                      </span>
                      <span className={styles.names}>
                        <b className={styles.sym}>{title}</b>
                        <small className={styles.meta}>
                          {meta.map((m, k) => (
                            <span key={k}>
                              {k > 0 && <span className={styles.sep}> · </span>}
                              {m}
                            </span>
                          ))}
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
                  <div role="cell" className={styles.cSig}>
                    {sigCell(c)}
                  </div>
                  <div role="cell" className={styles.cDoor}>
                    {c.graduated ? (
                      <span className={styles.grad}>
                        <i aria-hidden />
                        Graduated
                      </span>
                    ) : (
                      <>
                        <span className={styles.doorTop}>
                          <span className={styles.meter} aria-hidden>
                            <i className={pct >= 85 ? styles.meterHot : undefined} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                          </span>
                          <span className={`${styles.pct} ${pct >= 60 ? styles.hot : ""}`}>{pctText(c.progressBps)}</span>
                        </span>
                        {e ? (
                          <small className={styles.eta} title="ETA to 5 ETH at the current pace (the slower of 24 h and the last hour).">
                            <Term id="eta">{e}</Term>
                          </small>
                        ) : c.etaStalled ? (
                          // "stalled" only when nobody bought this hour; buys over a flat or draining day read "slow"
                          <small className={styles.eta} title={c.buys1h ? "Buys this hour, but net inflow is flat, draining or far below the day's pace: no ETA." : "No buys in the last hour: no ETA."}>
                            <Term id="stalled">{c.buys1h ? "slow" : "stalled"}</Term>
                          </small>
                        ) : null}
                      </>
                    )}
                  </div>
                  <div role="cell" className={`${styles.num} ${styles.cIn} ${c.holders === null ? styles.unk : ""}`} title={c.holders === null ? "Unknown, not zero." : undefined}>
                    {nf(c.holders)}
                  </div>
                  <div
                    role="cell"
                    className={`${styles.num} ${styles.cVol} ${vol === null || vol === 0 ? styles.unk : ""}`}
                    title={c.v6 && c.v6.pair !== "ETH" ? `Traded in ${c.v6.pair}: no ETH volume to show` : vol === null ? "Unknown, not zero." : undefined}
                  >
                    {eth(vol)}
                  </div>
                  <div role="cell" className={styles.cSpark}>
                    {c.v6 ? (
                      <span className={`${styles.noSpark} ${styles.unk}`} role="img" aria-label="No 24 h price chart for taxed v6 launches" title="No 24 h price chart for taxed v6 launches">
                        —
                      </span>
                    ) : (
                      <Sparkline className={styles.spark} data={spark.has(c.token) ? spark.get(c.token) : undefined} />
                    )}
                    <span className={`${styles.chg} ${chgCls}`} title={chg === null ? "No 1h price change for this launch: unknown, not zero." : "Price change over the last hour"}>
                      {chg === null ? "—" : chgText(chg)}
                    </span>
                  </div>
                  <div role="cell" className={`${styles.num} ${styles.cBs}`}>
                    {c.buys1h === null && c.sells1h === null ? (
                      <span className={styles.unk} title="No 1h window for this launch: unknown, not zero.">—</span>
                    ) : (
                      <span className={styles.bs} title={`${c.buys1h ?? "—"} buys / ${c.sells1h ?? "—"} sells in the last hour`}>
                        {c.buys1h ?? "—"}
                        <span className={styles.slash}>/</span>
                        {c.sells1h ?? "—"}
                      </span>
                    )}
                    {f ? <i className={styles.bump}>{f < 0 ? "new" : `+${f}`}</i> : null}
                  </div>
                  {/* phones: holders, volume and B/S as one plain line under the progress */}
                  <div role="cell" className={styles.cMob} aria-hidden>
                    <span>{nf(c.holders)} holders</span>
                    <span className={styles.sep}> · </span>
                    <span>{eth(vol)} ETH {period}</span>
                    {c.buys1h !== null || c.sells1h !== null ? (
                      <>
                        <span className={styles.sep}> · </span>
                        <span>
                          {c.buys1h ?? "—"}/{c.sells1h ?? "—"} 1h
                        </span>
                      </>
                    ) : null}
                    {chg !== null && !flatBps(chg) ? (
                      <>
                        <span className={styles.sep}> · </span>
                        <span className={chgCls}>{chgText(chg)}</span>
                      </>
                    ) : null}
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
            <div role="cell" className={`${styles.num} ${styles.cRank} ${styles.rank}`}>·</div>
            <div role="cell" className={styles.cTok}>
              <span className={styles.names}>
                <b className={styles.addr}>{shortAddr(t)}</b>
                <small className={styles.meta}>Didn&apos;t load. Retrying.</small>
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
      <p className={styles.fine}>
        Signals, not verdicts · Sources and freshness: <Link href="/status">Status</Link>
        {sortedNote ? " · Sorted within the loaded rows" : ""}
      </p>

      {/* How to read: the legend (and the keys on a keyboard) in one popover */}
      <div id={HOW_ID} popover="auto" className={styles.how} aria-label="How to read the board">
        <div className={styles.howHead}>
          <h3>How to read</h3>
          <button type="button" className={styles.ghostBtn} popoverTarget={HOW_ID} popoverTargetAction="hide" aria-label="Close">
            ×
          </button>
        </div>
        <dl className={styles.legendList}>
          <div><dt>Grade</dt><dd>Line Health A–F: a check of the first 20 buyers and the dev, with the worst flag beside it. new = too early to grade. — = unknown, never clean. * = partial.</dd></div>
          <div><dt>To grad</dt><dd>Progress of the bonding curve to 5 ETH, where trading moves to a Uniswap V4 pool. Under it, the ETA at the slower pace (24 h or the last hour). Stalled = no buys this hour; slow = buys, but net inflow is flat.</dd></div>
          <div><dt>Holders</dt><dd>Wallets holding the token now.</dd></div>
          <div><dt>Vol</dt><dd>ETH traded in the last 1 h or 24 h (switch in the column head).</dd></div>
          <div><dt>24h</dt><dd>The 24 h price line, and the price change over the last hour.</dd></div>
          <div><dt>B/S 1h</dt><dd>Buys and sells in the last hour.</dd></div>
          <div><dt>Under the ticker</dt><dd>dev ×N = same creator N times on this list · clone = an older token already uses this ticker{v6 === "ok" ? " · % tax = a taxed v6 launch, ranked by bag" : ""}.</dd></div>
          <div><dt>☆</dt><dd>Pin a token to your Watchlist (this browser only).</dd></div>
        </dl>
        <dl className={`${styles.keyList} ${styles.keysOnly}`}>
          <div><dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next / previous row</dd></div>
          <div><dt><kbd>Enter</kbd> <kbd>o</kbd></dt><dd>Open the token</dd></div>
          <div><dt><kbd>p</kbd></dt><dd>Pin / unpin the row</dd></div>
          <div><dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Switch list</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>This panel</dd></div>
        </dl>
      </div>
    </div>
  );
}
