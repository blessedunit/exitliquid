"use client";
// One composition for every line: header, the summary (grade, reading line, KPIs, chips), sticky section tabs,
// then Line (corridor + tape | ticket), Risk, Holders, Exit and Dev. Two columns of cards at 1100+, one below.
// token = null shows $EXIT (/exit); any other vibe/vibe token gets the same line on /line/<token>.
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Corridor, { corridorFit } from "./Corridor";
import Sprite from "./Sprite";
import CorridorTape from "./CorridorTape";
import MarketPass from "./MarketPass";
import CtaLink from "./CtaLink";
import ShareCard from "./ShareCard";
import TokenHead from "./TokenHead";
import TopHolders from "./TopHolders";
import HealthCard, { FirstBuyersCard, useHealth } from "./HealthCard";
import SummaryBar, { type SummaryKpis } from "./analytics/SummaryBar";
import DevMini from "./analytics/DevMini";
import SectionTabs from "./ui/SectionTabs";
import { useTokenAnalytics } from "./analytics/useTokenAnalytics";
import an from "./analytics/analytics.module.css";
import styles from "./LiveHero.module.css";
import { useQueue } from "@/lib/useLive";
import { LineProvider, type LineInfo, type TokenAbout } from "@/lib/lineContext";
import { ACTIVE_TOKEN, IS_LIVE } from "@/lib/config";
import { fmtEth, fmtInt } from "@/lib/format";
import type { QueueResponse, WireEntry } from "@/lib/types";

// "You are here": the wallet this visitor typed or connected on My Lines (never a shared ?w= link).
// Read through useSyncExternalStore: storage can throw (private mode, blocked site data) and is absent on the server.
function readMe(): string | null {
  try {
    const v = localStorage.getItem("exit.me");
    return v && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : null;
  } catch {
    return null;
  }
}
function subscribeMe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener("exit-me-change", cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener("exit-me-change", cb);
  };
}
// the corridor zooms in on phones at 700 px, so the page size follows the same breakpoint
function subscribeNarrow(cb: () => void) {
  const media = window.matchMedia("(max-width: 700px)");
  media.addEventListener("change", cb);
  return () => media.removeEventListener("change", cb);
}
const readNarrow = () => window.matchMedia("(max-width: 700px)").matches;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// the corridor SVG is 340 units tall: its visible width in units follows the stage's own size
const CORRIDOR_UNITS_H = 340;
// the corridor strip's height in px (LiveHero.module.css keeps the same numbers: 160 desktop, 120 phones)
const CORRIDOR_PX = 160;

// The queue API sends the newest 300 trades (lib/service toQueueResponse). Fewer than that = the whole history.
const TRADES_SENT = 300;
// $EXIT before launch: the CTA stays on-site ("Get in line" -> /lines), so it must not say "Buy"
const EXIT_CTA = IS_LIVE ? "Buy $EXIT" : undefined;

type Flow = { vol24: number | null; buys1h: number | null; sells1h: number | null };

/** Volume and trade counts from the tape, only when the tape really covers the window (unknown ≠ zero). */
function flowOf(data: QueueResponse | null): Flow {
  const none = { vol24: null, buys1h: null, sells1h: null };
  if (!data || data.unavailable || !data.updatedAt) return none;
  const trades = data.trades ?? [];
  const now = data.updatedAt / 1000;
  const whole = trades.length < TRADES_SENT;
  const oldest = trades[0]?.ts ?? Infinity;
  const covers = (seconds: number) => whole || oldest <= now - seconds;
  let vol24: number | null = null;
  if (covers(86_400)) {
    vol24 = 0;
    for (const t of trades) {
      if (t.ts < now - 86_400) continue;
      const eth = t.side === "buy" ? t.buyCostEth : t.sellValueEth;
      if (eth == null || !Number.isFinite(eth)) { vol24 = null; break; }
      vol24 += eth;
    }
  }
  if (!covers(3_600)) return { vol24, buys1h: null, sells1h: null };
  const hour = trades.filter((t) => t.ts >= now - 3_600);
  const buys1h = hour.filter((t) => t.side === "buy").length;
  return { vol24, buys1h, sells1h: hour.length - buys1h };
}

// The analytics cards sit below the fold: their code loads after the page (and never on /exit before launch).
// Placeholders keep the loaded cards' height, so nothing jumps when the chunk lands.
const CardHold = () => <section className={an.card} data-loading aria-hidden />;
const Cards = dynamic(() => import("./analytics/AnalyticsCards"), { ssr: false, loading: () => <CardHold /> });

/** the page's sections, in order (the sticky tabs and the section heads read from here) */
const SECTIONS = [
  { id: "line", label: "Line", lead: "Every holder, queued by first buy. Tap a person or a trade." },
  { id: "risk", label: "Risk", lead: "Who stands at the front: snipers, farms, bundled buys." },
  { id: "holders", label: "Holders", lead: "Who holds the supply, and how it got there." },
  { id: "exit", label: "Selling", lead: "How much selling the price can take, and how much of the volume is real." },
  { id: "dev", label: "Dev", lead: "The creator's record and other launches with this ticker." },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function ageText(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

type HeroProps = {
  token?: string | null;
  info?: LineInfo | null;
  createdAt?: number | null;
  /** holder count as vibe/vibe reports it (every wallet holding, not only those with a place); null = unknown */
  holders?: number | null;
  /** the token's own description and links, when vibe/vibe has them */
  about?: TokenAbout | null;
  /** 24 h volume as vibe/vibe reports it: shown when the tape doesn't cover the whole day; null = unknown */
  vol24Vibe?: number | null;
  /** the server heard a final 404 from vibe/vibe (v1 and v6): draw the "not a launch" page from the first paint */
  notVibeHint?: boolean;
  /** price change over the last hour (bps), as the board shows it; null = unknown */
  change1hBps?: number | null;
  /** the board's door ETA (hours) / "stalled"; null + false = no honest ETA */
  etaHours?: number | null;
  etaStalled?: boolean;
};

export default function LiveHero({ token = null, info: serverInfo = null, createdAt = null, holders = null, about = null, vol24Vibe = null, notVibeHint = false, change1hBps = null, etaHours = null, etaStalled = false }: HeroProps) {
  const { data, error } = useQueue(20_000, 1_000, token);
  // launchInfo() on the server can miss (vibe API slow): fall back to the queue's own name and symbol
  const liveData = data && (!token || data.token?.toLowerCase() === token) ? data : null;
  const info = useMemo<LineInfo | null>(() => {
    if (serverInfo?.symbol) return serverInfo;
    if (liveData?.symbol) return { name: liveData.name, symbol: liveData.symbol, image: serverInfo?.image ?? null, creator: liveData.creator };
    return serverInfo;
  }, [serverInfo, liveData]);

  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);
  const [meClosed, setMeClosed] = useState(false); // the visitor closed their own ticket: show the tape alone
  const [linePage, setLinePage] = useState(0);
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const [sceneEvent, setSceneEvent] = useState<{ key: string; kind: "buy" | "sell" | "exit"; wallet: string } | null>(null);
  const lastTrade = useRef<string | null>(null);
  const me = useSyncExternalStore(subscribeMe, readMe, () => null);
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, () => false);

  const line = useMemo(() => data?.line ?? [], [data?.line]);
  const unknown = !data || !!data.unavailable;
  const lineUnknown = !!data?.unavailable || (!data && !!error);
  // not a vibe/vibe launch: a final answer, so no corridor, tape, X-ray or Buy button for it
  // (the server's hint only sets the first paint; line data from the chain always wins, so no layout jump for a real 404)
  const notVibe = (error === "not_vibe" || notVibeHint) && !data;
  const inLine = data?.totals.inLine ?? 0;
  const progress = data?.curve.progressBps ?? 0;
  const mine = me ? line.find((e) => e.wallet === me) : undefined;
  const selected = selectedWallet ? line.find((e) => e.wallet === selectedWallet) : undefined;
  const selectedTrade = selectedWallet ? [...(data?.trades ?? [])].reverse().find((t) => t.wallet === selectedWallet) : undefined;
  const flow = useMemo(() => flowOf(data), [data]);
  const places = useMemo(() => new Map(line.map((e) => [e.wallet, e.place])), [line]);

  // the corridor is drawn edge to edge: measure the stage, then fit as many people as its width holds
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const { width: w, height: h } = e.contentRect;
      if (w > 0 && h > 0) setStage((prev) => (prev && Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [notVibe]);
  const span = stage ? (stage.w * CORRIDOR_UNITS_H) / stage.h : undefined;

  // paging through the corridor (the Dev stands beside the door, so page one gets one extra slot)
  // one page = everyone the measured corridor holds at the current sprite scale (edge to edge, no cap)
  const fit = span ? corridorFit(span, narrow) : narrow ? 4 : 10;
  const pageSize = Math.max(1, fit);
  const firstPageSize = pageSize + (line[0]?.isCreator ? 1 : 0);
  const pageCount = line.length <= firstPageSize ? 1 : 1 + Math.ceil((line.length - firstPageSize) / pageSize);
  const safePage = Math.min(linePage, pageCount - 1);
  const scene = safePage === 0 ? "door" : safePage === pageCount - 1 ? "arrival" : "passage";
  const pageStart = safePage === 0 ? 0 : firstPageSize + (safePage - 1) * pageSize;
  const pageLine = line.slice(pageStart, pageStart + (safePage === 0 ? firstPageSize : pageSize));
  const rangeStart = pageLine[0]?.place ?? 0;
  const rangeEnd = pageLine.at(-1)?.place ?? 0;
  const pageForIndex = (index: number) => index < firstPageSize ? 0 : 1 + Math.floor((index - firstPageSize) / pageSize);

  // in-app browsers (X, Telegram...) have no wallet: say so, with a copy-link button
  const [inApp, setInApp] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setInApp(/Twitter|TwitterAndroid|FBAN|FBAV|Instagram|Telegram/i.test(navigator.userAgent)), 0);
    return () => clearTimeout(t);
  }, []);
  // phones: the sticky buy bar shows once the in-page Buy / Find pair (under the summary) scrolled away
  const [pastHero, setPastHero] = useState(false);
  const phoneActsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => {
      const el = phoneActsRef.current;
      setPastHero(el && el.offsetParent !== null ? el.getBoundingClientRect().bottom < 0 : window.scrollY > 600);
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  // from the tape the ticket may be out of view; a click in the corridor never scrolls the page on
  // desktop (the ticket opens first in the side column), only on phones where it sits below
  const selectWallet = (wallet: string, from: "tape" | "corridor" | "holders" | "me" = "tape") => {
    const normalized = wallet.toLowerCase();
    const index = line.findIndex((entry) => entry.wallet === normalized);
    if (index >= 0) setLinePage(pageForIndex(index));
    setSelectedWallet(normalized);
    setFindStatus(null);
    if (from === "tape" || (from === "corridor" && window.matchMedia("(max-width: 760px)").matches)) {
      requestAnimationFrame(() => document.getElementById("market-pass")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" }));
    }
    // from Top holders: the ticket opens at the top of the same column; bring it into view
    // (on phones it sits above the holders list, so this scrolls up to it)
    if (from === "holders") {
      requestAnimationFrame(() => document.getElementById("market-pass")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }));
    }
  };

  const changePage = (next: number) => {
    setLinePage(Math.max(0, Math.min(pageCount - 1, next)));
    setSelectedWallet(null);
    setFindStatus(null);
  };
  // the on-scene arrows: when the one just pressed disappears (first / last page), keep focus on the other
  const backRef = useRef<HTMLButtonElement>(null);
  const fwdRef = useRef<HTMLButtonElement>(null);
  const pageBy = (delta: 1 | -1) => {
    const next = Math.max(0, Math.min(pageCount - 1, safePage + delta));
    changePage(next);
    const gone = delta === 1 ? next >= pageCount - 1 : next <= 0;
    if (gone) requestAnimationFrame(() => (delta === 1 ? fwdRef : backRef).current?.focus());
  };

  const findMe = () => {
    if (!me) return;
    const index = line.findIndex((entry) => entry.wallet === me);
    if (index < 0) {
      setFindStatus(lineUnknown || !data ? "Line unknown right now" : data.lineTruncated ? "Your place is beyond the loaded line" : "This wallet is not in line");
      return;
    }
    setLinePage(pageForIndex(index));
    setSelectedWallet(me);
    setFindStatus(`Found · #${line[index].place}`);
  };

  useEffect(() => {
    const trade = data?.trades.at(-1);
    if (!trade) return;
    const key = `${trade.tx ?? trade.ts}-${trade.wallet}-${trade.side}`;
    if (lastTrade.current === null) {
      lastTrade.current = key;
      return;
    }
    if (lastTrade.current === key) return;
    lastTrade.current = key;
    const exited = trade.side === "sell" && data?.feed.some((item) => item.kind === "exit" && item.wallet === trade.wallet && (!trade.tx || !item.tx || item.tx === trade.tx));
    setSceneEvent({ key, kind: exited ? "exit" : trade.side, wallet: trade.wallet });
    const timer = window.setTimeout(() => setSceneEvent(null), 2200);
    return () => window.clearTimeout(timer);
  }, [data?.trades, data?.feed]);

  const age = createdAt && data?.updatedAt ? ageText(Math.max(0, data.updatedAt / 1000 - createdAt)) : null;
  const pct = unknown ? null : progress / 100;
  // any trouble with live data (unknown, not zero): one quiet "Retrying…" in the summary's meta line
  const retrying = !notVibe && (!!(error && error !== "not_vibe") || !!data?.unavailable);
  // Line Health: the page's token, or on /exit the live $EXIT (demo token before launch; never mock data)
  const healthToken = token ?? (liveData && liveData.mode !== "mock" && /^0x[0-9a-f]{40}$/i.test(liveData.token) ? liveData.token.toLowerCase() : null);
  // token analytics (the summary + the analytics cards): one shared poll. Token pages, and /exit once $EXIT is
  // live (before launch /exit shows a demo token: its numbers must never sit under the $EXIT label)
  const anToken = token ? (notVibe ? null : token) : IS_LIVE ? ACTIVE_TOKEN : null;
  const analytics = useTokenAnalytics(anToken);
  const health = useHealth(healthToken);
  // the Supply read's per-wallet flags (top 10), shown as tags in the one holders list
  const supplyTop = analytics.a?.supply.data?.top10;
  const holderFlags = useMemo(() => (supplyTop ? new Map(supplyTop.map((r) => [r.wallet.toLowerCase(), r.flags])) : null), [supplyTop]);
  const an1h = analytics.a?.volume.data?.windows.find((w) => w.label === "1h") ?? null;
  const an24 = analytics.a?.volume.data?.windows.find((w) => w.label === "24h") ?? null;
  const market = analytics.a?.market.data ?? null;
  const marketReason = analytics.a?.market.reason ?? null;
  const anGraduated = !!analytics.a?.graduated;
  const tags = analytics.a?.tags;
  const creator = token ? info?.creator || liveData?.creator || null : null;
  // one holders figure on the page: the chain's own count (the Supply card's) once it is in, vibe/vibe's until then
  const chainHolders = analytics.a?.supply.data?.holders ?? null;
  const holdersShown = chainHolders ?? holders;

  // one KPI set for every line, with or without analytics (unknown = null, drawn as "—")
  const vol24Src: SummaryKpis["vol24Src"] = flow.vol24 !== null ? "tape" : vol24Vibe !== null && !unknown ? "vibe" : null;
  const curveGrad = !!data?.curve.graduated;
  const targetEth = data?.curve.targetEth || 5;
  const kpis = useMemo<SummaryKpis>(() => ({
    mcapEth: anToken ? market?.mcapEth ?? null : null,
    mcapTitle: market
      ? `Spot price x total supply, in ETH (spot ${fmtEth(market.spotEth * 1e6)} ETH per 1M)`
      : anToken ? marketReason ?? "Reading the curve…" : "Spot price x total supply, in ETH",
    change1hBps,
    vol24Eth: vol24Src === "tape" ? flow.vol24 : vol24Src === "vibe" ? vol24Vibe : null,
    vol24Src,
    realPct: an24 && an24.volumeEth > 0 ? (an24.realEth / an24.volumeEth) * 100 : null,
    // the same count as Real volume's 1h column (chain logs) when it's in; the tape until then
    buys1h: an1h ? an1h.buys : flow.buys1h,
    sells1h: an1h ? an1h.sells : flow.sells1h,
    bsTitle: an1h ? "Buys and sells in the last hour, from the chain logs" : "Buys and sells in the last hour, from the tape",
    holders: holdersShown,
    holdersSrc: chainHolders !== null ? "chain" : holders !== null ? "vibe" : null,
    inLine: unknown ? null : inLine,
    gradPct: pct,
    graduated: curveGrad || anGraduated,
    targetEth,
    etaHours: token ? etaHours : null,
    etaStalled: !!token && etaStalled,
  }), [anToken, market, marketReason, change1hBps, vol24Src, flow, vol24Vibe, an24, an1h, holdersShown, chainHolders, holders, unknown, inLine, pct, curveGrad, anGraduated, targetEth, token, etaHours, etaStalled]);

  // one stable handler for the memoized cards (a new arrow each render would re-render them on every queue poll)
  const selectRef = useRef<(wallet: string, from: "holders") => void>(() => {});
  const onHolder = useCallback((wallet: string) => selectRef.current(wallet, "holders"), []);
  // the ticket beside the tape: the one clicked, else the connected wallet's own (when it stands in this line);
  // nobody to show = no side column, the tape takes the full width
  const ticketWallet = selectedWallet ?? (me && mine && !meClosed ? me : null);
  const ticketEntry = selectedWallet ? selected : mine;
  const ticketTrade = selectedWallet ? selectedTrade : me ? [...(data?.trades ?? [])].reverse().find((t) => t.wallet === me) : undefined;
  const closeTicket = () => { if (!selectedWallet || selectedWallet === me) setMeClosed(true); setSelectedWallet(null); };
  const showSide = !!ticketWallet;
  useEffect(() => {
    selectRef.current = selectWallet;
  });
  const findMeAs = (cls: string) => me
    ? <button type="button" className={cls} onClick={findMe} title="Show your place in this line">Find me in line</button>
    : <Link className={cls} href="/lines" title="Connect or type your wallet on My lines, then find your place in every line">Find me in line</Link>;
  const findMeBtn = findMeAs(styles.btnS);

  // what each section holds on this page (an empty section gets no tab and no head)
  const has: Record<SectionId, boolean> = {
    line: true,
    risk: !!(healthToken || anToken),
    holders: !!(anToken || token),
    exit: !!anToken,
    dev: !!token,
  };
  const sections = SECTIONS.filter((x) => has[x.id]);
  const head = (id: SectionId) => {
    const x = SECTIONS.find((y) => y.id === id)!;
    return (
      <header className={styles.secHead}>
        <h2 id={`${id}-h`}>{x.label}</h2>
        <p>{x.lead}</p>
      </header>
    );
  };
  const canPage = !!data && !lineUnknown && pageCount > 1;

  return (
    <LineProvider value={{ token, info }}>
      <section className={`wrap ${styles.hero}`} aria-label={token ? `$${info?.symbol ?? "token"} line` : "$EXIT line"}>
        {inApp && (
          <div className={styles.inApp} role="note">
            <span>Opened inside an app? Buying needs a wallet app.</span>
            <button type="button" className={styles.btnG} onClick={() => { navigator.clipboard?.writeText(location.href).then(() => setCopied(true), () => {}); }}>
              {copied ? "Link copied" : "Copy link"}
            </button>
          </div>
        )}

        <TokenHead
          token={token}
          info={info}
          age={age}
          loading={!data && !error}
          about={about}
          creator={creator}
          actions={notVibe
            ? <Link className={styles.btnS} href="/">All tokens</Link>
            : token
            // phones: Buy / Find leave the header (the grade and the summary come right under the name); a quiet
            // pair sits under the KPIs and the sticky bar takes over once the summary scrolled away
            ? <>{findMeAs(`${styles.btnS} ${styles.wideOnly}`)}<ShareCard kind="line" id={token} symbol={info?.symbol ?? null} grade={analytics.a?.health?.grade ?? null} className={styles.btnG} rootClassName={styles.share} /><CtaLink className={`${styles.btnP} ${styles.wideOnly}`} /></>
            : <>{findMeBtn}<CtaLink className={styles.btnP} label={EXIT_CTA} /></>}
        />

        {!notVibe && <SummaryBar state={anToken ? analytics : null} kpis={kpis} retrying={retrying} />}
        {token && !notVibe && (
          <div ref={phoneActsRef} className={styles.phoneActions}>
            <CtaLink className={styles.btnS} />
            {findMeAs(styles.btnG)}
          </div>
        )}
        {!notVibe && !anToken && retrying && <p className={styles.note} role="status">Retrying… Live numbers unknown for now.</p>}

        {data?.note && <p className={styles.note} role="status">{data.note}</p>}
        {notVibe && (
          <p className={styles.note} role="status">Not a vibe/vibe launch: no line. {token && <><Link href={`/w/${token.toLowerCase()}`} prefetch={false}>Open as a wallet →</Link> · </>}<Link href="/">Browse tokens →</Link></p>
        )}

        {!notVibe && <>
        {sections.length > 1 && <SectionTabs items={sections.map((x) => ({ id: x.id, label: x.label }))} className={styles.tabs} />}

        <div id="line" className={styles.sec} aria-labelledby="line-h">
          {head("line")}
          <div className={styles.corr}>
            <div className={styles.stage} ref={stageRef}>
              <div className={styles.corridorBox}>
                <Corridor
                  line={pageLine}
                  inLine={inLine}
                  progressBps={progress}
                  maxShown={pageSize + 1}
                  span={span}
                  height={CORRIDOR_PX}
                  scene={scene}
                  highlight={me ?? undefined}
                  selected={selectedWallet ?? undefined}
                  onSelect={(entry) => selectWallet(entry.wallet, "corridor")}
                  showWallets
                  showRest={false}
                  event={sceneEvent ?? undefined}
                  status={lineUnknown ? "unknown" : !data ? "loading" : "ok"}
                  doorLabel={false}
                />
              </div>
              {/* while the chain is being read: a row of shadows waiting, not an empty corridor */}
              {!data && !error && (
                <div className={styles.shadowCrowd} aria-hidden>
                  {(["suit", "getaway", "bag", "hood", "plain", "hood", "bag"] as const).map((k, n) => (
                    <Sprite key={n} skin={k} scale={2} face="right" style={{ animationDelay: `${n * 0.18}s` }} />
                  ))}
                </div>
              )}
            </div>
            <div className={styles.corrFoot}>
              <span className={styles.range}>
                {!data ? (error ? "—" : "Reading the line…") : lineUnknown ? "—" : rangeStart ? <>#{rangeStart}–{rangeEnd} <span className={styles.t3}>of {fmtInt(inLine)}</span></> : "No one in line yet"}
                {data && !lineUnknown && (
                  <span className={`${styles.t3} ${styles.lineMeta}`} title="Walked out: the bag fell to 5% of its peak or under 5,000 tokens.">
                    {" "}· {fmtInt(data.totals.exited)} walked out
                  </span>
                )}
              </span>
              {/* paging: further back in line on the left, toward the front (the door) on the right */}
              {canPage && (
                <span className={styles.pager}>
                  <button ref={backRef} type="button" className={styles.arrow} onClick={() => pageBy(1)} disabled={safePage >= pageCount - 1} aria-label="Further back in line" title="Further back">
                    <span aria-hidden>←</span>
                  </button>
                  <button ref={fwdRef} type="button" className={styles.arrow} onClick={() => pageBy(-1)} disabled={safePage <= 0} aria-label="Toward the front of the line" title="Toward the front">
                    <span aria-hidden>→</span>
                  </button>
                </span>
              )}
            </div>
          </div>
          {(findStatus || (me && (mine || lineUnknown))) && (
            <p className={styles.youLine} role="status">
              {findStatus ?? (me && mine ? `You are #${mine.place} · ${fmtInt(mine.ahead)} ahead of you` : "You are #?")}
            </p>
          )}

          <div className={`${styles.grid2} ${showSide ? "" : styles.solo}`}>
            <div className={styles.tapeCol}>
              <CorridorTape
                trades={data?.trades ?? []}
                symbol={data?.symbol || info?.symbol}
                updatedAt={data?.updatedAt ?? 0}
                selected={selectedWallet ?? undefined}
                onSelect={selectWallet}
                places={places}
                lineComplete={!!data && !data.unavailable && !data.lineTruncated}
                unknown={lineUnknown}
                tags={tags}
              />
            </div>
            {showSide && (
              <aside className={styles.side} aria-label="Ticket">
                <div id="market-pass" className={styles.passSlot}>
                  <MarketPass wallet={ticketWallet} entry={ticketEntry} trade={ticketTrade} data={data} onClose={closeTicket} tag={tags?.[ticketWallet] ?? null} />
                </div>
              </aside>
            )}
          </div>
        </div>

        {/* every block is open to everyone: no locks, no blur */}
        {has.risk && (
          <div id="risk" className={styles.sec} aria-labelledby="risk-h">
            {head("risk")}
            <div className={styles.cards}>
              {healthToken && <HealthCard health={health} />}
              {anToken && <Cards part="bundle" state={analytics} me={me} onSelect={onHolder} />}
            </div>
            {/* the first 20 buyers: a full-width row under the two checks (as on /exit), so neither column runs long */}
            {healthToken && health.trouble !== "notvibe" && (
              <div className={styles.cardsRow}>
                <FirstBuyersCard health={health} selected={selectedWallet} onSelect={onHolder} />
              </div>
            )}
          </div>
        )}
        {has.holders && (
          <div id="holders" className={styles.sec} aria-labelledby="holders-h">
            {head("holders")}
            <div className={styles.cards}>
              {anToken && <Cards part="supply" state={analytics} me={me} onSelect={onHolder} />}
              {token && <TopHolders token={token} data={liveData} me={me} creator={creator} selected={selectedWallet} onSelect={onHolder} flags={holderFlags} />}
            </div>
          </div>
        )}
        {has.exit && (
          <div id="exit" className={styles.sec} aria-labelledby="exit-h">
            {head("exit")}
            <div className={styles.cards}>
              <Cards part="exit" state={analytics} me={me} onSelect={onHolder} />
              <Cards part="volume" state={analytics} me={me} onSelect={onHolder} />
            </div>
          </div>
        )}
        {has.dev && (
          <div id="dev" className={styles.sec} aria-labelledby="dev-h">
            {head("dev")}
            <div className={styles.cards}>
              <DevMini creator={creator} />
              {anToken && <Cards part="clones" state={analytics} me={me} onSelect={onHolder} />}
            </div>
          </div>
        )}
        </>}
      </section>

      {/* phones: the one action that matters, one thumb away (hidden above 760 px) */}
      {!notVibe && <div className={`${styles.stickyCta} stickyCtaBar ${pastHero ? styles.stickyOn : ""}`}>
        {token ? <CtaLink className={styles.btnP} /> : <CtaLink className={styles.btnP} label={EXIT_CTA} />}
        {findMeBtn}
      </div>}
    </LineProvider>
  );
}
