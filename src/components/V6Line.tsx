"use client";
// A taxed v6 launch as a line, "lite": our chain engine reads v1 curves only, so this page shows what
// vibe/vibe's own indexer reports, and says so. The order is holders by bag (biggest nearest the door),
// NOT buy order; the door is the pair reserve on the curve over its target. Unknown = "—", never 0.
// The same composition as a v1 line (LiveHero): verdict, the line (with the first buyers' sniper / bundle marks
// on the people who still hold), one row of figures, the sections, then Trades and Holders by bag.
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Sprite from "./Sprite";
import TokenHead from "./TokenHead";
import ShareCard from "./ShareCard";
import ProfileLink from "./ProfileLink";
import dynamic from "next/dynamic";
import { FirstBuyersCard, useHealth } from "./HealthCard";
import Unreadable from "./token/Unreadable";
import { useTries } from "./useTries";
import { useTokenAnalytics } from "./analytics/useTokenAnalytics";
import { Verdict, ReportSections, Figures, FrontCaption, readFront, type Fallback, type MarketItem } from "./token/Report";
import { readVerdict } from "./token/verdict";
import { trackRecord, useDevPassport } from "./token/useDevPassport";
import rp from "./token/Report.module.css";
import an from "./analytics/analytics.module.css";
import type { TokenAbout } from "@/lib/lineContext";
import type { V6Holder, V6Line as Line } from "@/lib/v6";
import type { Skin } from "@/lib/skins";
import { EXPLORER, VIBE_APP } from "@/lib/config";
import { fmtAge, fmtCompact, fmtEth, fmtInt, fmtTokens, shortAddr } from "@/lib/format";
import styles from "./V6Line.module.css";

const POLL_MS = 20_000; // the v6 line is CDN-cached 20 s (api/v6)
const CROWD_MAX = 14; // people drawn in the corridor; the rest are "+N more" (the holder list has them all)
const HOLDERS_SHOWN = 50;
const SKINS: Skin[] = ["plain", "hood", "bag", "getaway", "suit"];

/** one fixed look per wallet (the same person in every refresh), the dev as The Dev */
function skinOf(h: V6Holder): Skin {
  if (h.isCreator) return "architect";
  let x = 0;
  for (let i = 2; i < 10; i++) x = (x * 31 + h.address.charCodeAt(i)) >>> 0;
  return SKINS[x % SKINS.length];
}

/** pair units (decimals) as a number; null when the decimals are unknown */
function units(v: string | null, decimals: number | null): number | null {
  if (v === null || decimals === null) return null;
  try {
    const b = BigInt(v);
    const cut = Math.max(0, decimals - 9);
    return Number(b / 10n ** BigInt(cut)) / 10 ** (decimals - cut);
  } catch {
    return null;
  }
}
// pair amounts (NVDA, USDG, a token): fmtCompact rounds anything under 1 to "<1", so a 0.662 NVDA door read "<1 of 1" (audit 15.10)
const pairNum = (n: number) =>
  Math.abs(n) >= 1000 ? fmtCompact(n) : n === 0 ? "0" : Number(n.toPrecision(3)).toFixed(12).replace(/\.?0+$/, ""); // 3 significant digits, never 1e-7
const share = (bps: number | null) => (bps === null ? "—" : bps < 1 ? "<0.01%" : `${(bps / 100).toFixed(bps < 100 ? 2 : 1)}%`);
const taxText = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
function chg(bps: number | null) {
  if (bps === null) return "—";
  if (Math.abs(bps) < 5) return "0.0%";
  const p = bps / 100;
  return `${p > 0 ? "+" : "−"}${Math.abs(p) >= 1000 ? `${(Math.abs(p) / 1000).toFixed(1)}k` : Math.abs(p).toFixed(1)}%`;
}

function aboutOf(l: Line): TokenAbout | null {
  const links: TokenAbout["links"] = [];
  if (l.socials?.x) links.push({ label: "X", href: l.socials.x });
  if (l.socials?.telegram) links.push({ label: "Telegram", href: l.socials.telegram });
  if (l.socials?.website) links.push({ label: "Website", href: l.socials.website });
  return l.description || links.length ? { description: l.description, links } : null;
}

// the full analytics cards, folded under each report section: loaded after the page
const CardHold = () => <section className={an.card} data-loading aria-hidden />;
const Cards = dynamic(() => import("./analytics/AnalyticsCards"), { ssr: false, loading: () => <CardHold /> });

export default function V6Line({ initial }: { initial: Line }) {
  const [line, setLine] = useState<Line>(initial);
  const [conn, setConn] = useState<"ok" | "retry">(initial.updatedAt ? "ok" : "retry");
  const [now, setNow] = useState<number | null>(null);
  const token = initial.token;
  const busy = useRef(false);
  const { failed, round, start, fail, ok } = useTries(token);
  // phones: the same people, the crowd pans sideways inside the scene (re-measure the bracket on a resize)
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    let dead = false;
    let have = initial.updatedAt > 0; // holders and trades are on screen: a failed refresh keeps them and keeps asking
    start();
    const run = async () => {
      if (busy.current || document.visibilityState !== "visible") return;
      busy.current = true;
      try {
        const r = await fetch(`/api/v6/${token}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Line;
        if (dead) return;
        // a refresh whose market part did not come back keeps the last known holders and trades
        setLine((prev) => (j.updatedAt ? j : { ...j, holders: prev.holders, trades: prev.trades, stats: prev.stats, holderCount: prev.holderCount, updatedAt: prev.updatedAt }));
        if (j.updatedAt) {
          have = true;
          ok();
          setConn("ok");
        } else miss();
      } catch {
        if (!dead) miss();
      } finally {
        busy.current = false;
        if (!dead) setNow(Date.now());
      }
    };
    const t0 = setTimeout(() => setNow(Date.now()), 0);
    const iv = setInterval(() => void run(), POLL_MS);
    // vibe/vibe didn't answer: ask again while tries are left, then stop (Unreadable takes over)
    const miss = () => {
      setConn("retry");
      if (!have && !fail(token)) clearInterval(iv);
    };
    if (round > 0 || !have) void run(); // "Try again", or nothing on screen yet: ask now
    return () => {
      dead = true;
      clearTimeout(t0);
      clearInterval(iv);
    };
  }, [token, initial.updatedAt, round, start, fail, ok]);

  const known = line.updatedAt > 0; // holders/trades/stats came back at least once
  const dec = line.pair.decimals;
  const pairSym = line.pair.symbol;
  const money = (v: string | null) => {
    const n = units(v, dec);
    return n === null ? "—" : line.pair.native ? `${fmtEth(n)} ETH` : `${pairNum(n)} ${pairSym}`;
  };
  const doorPct = line.doorBps === null ? null : line.doorBps / 100;
  const crowd = line.holders.slice(0, CROWD_MAX);
  const inLine = line.holderCount ?? (known && line.holdersComplete ? line.holders.length : null);
  const rest = inLine === null ? 0 : Math.max(0, inLine - crowd.length);
  const age = now !== null && line.createdAt ? fmtAge(now / 1000 - line.createdAt) : null;
  const vibeUrl = `${VIBE_APP}/token/${token}`;
  const about = useMemo(() => aboutOf(line), [line]);

  // the same analytics contract as a v1 line; a 404 here means "not read yet", asked again every minute
  const analytics = useTokenAnalytics(token, { retryMissing: true });
  const health = useHealth(token, { retryMissing: true });
  const a = analytics.a;
  const passport = useDevPassport(line.creator);
  // the letter in the share text = the letter on the page and on the card (one grade)
  const shareRead = useMemo(() => (passport.loading ? null : readVerdict(analytics.a, trackRecord(passport.p, token), null)), [analytics.a, passport.p, passport.loading, token]);
  const shareGrade = shareRead?.grade ?? null;
  const shareFull = !!shareRead && shareRead.coverage !== null && shareRead.coverage.length === 0;
  const fallback = useMemo<Fallback | null>(() => known ? {
    holders: line.holders.map((h) => ({ wallet: h.address, pct: h.shareBps === null ? null : h.shareBps / 100, isCreator: !!h.isCreator })),
    complete: !!line.holdersComplete,
    count: line.holderCount,
    vol24: line.stats.volume24h === null ? null : money(line.stats.volume24h),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  } : null, [known, line]);
  const c1h = line.stats.change1hBps;
  const a24 = a?.volume.data?.windows.find((w) => w.label === "24h") ?? null;
  const mcap = a?.market.data?.mcapEth ?? null; // in the pair's unit (the answer's own unit)
  const unitSym = a?.unit?.symbol ?? (line.pair.native ? "ETH" : pairSym);
  const taxSplit = line.taxSplit ? `Tax split: ${line.taxSplit.cashBps / 100}% project, ${line.taxSplit.holdersBps / 100}% holders, ${line.taxSplit.burnBps / 100}% burn` : null;
  const market: Record<"mcap" | "vol" | "holders" | "curve", MarketItem> = {
    mcap: {
      label: "MCap", value: mcap === null ? "—" : <>{fmtEth(mcap)}<small> {unitSym}</small></>,
      sub: c1h === null || Math.abs(c1h) < 5 ? undefined : <span className={c1h > 0 ? styles.up : styles.down}>{chg(c1h)} 1h</span>,
      title: "Spot price x total supply",
    },
    // the chain's 24 h volume once the analytics are in (the number the Volume section uses)
    vol: { label: "Vol 24h", value: a24 ? <>{fmtEth(a24.volumeEth)}<small> {unitSym}</small></> : known ? money(line.stats.volume24h) : "—" },
    holders: { label: "Holders", value: inLine === null ? "—" : fmtInt(inLine) },
    curve: {
      label: "Curve", value: line.graduated ? "Graduated" : doorPct === null ? "—" : `${doorPct.toFixed(1)}%`,
      sub: line.taxBps === null ? undefined : `tax ${taxText(line.taxBps)}`,
      title: [`${pairSym} on the curve over its target: ${money(line.reserve)} of ${money(line.target)}`, taxSplit].filter(Boolean).join(". "),
    },
  };
  const has = (x: unknown) => x !== null && x !== undefined;
  // the first buyers' marks on the people in the line (this line is by bag: every person still holds)
  const front = useMemo(() => readFront(a, health), [a, health]);

  // a tapped person opens its card under the scene, and a bracket marks the smaller bags behind it
  const [picked, setPicked] = useState<string | null>(null);
  const pickedIdx = picked ? line.holders.findIndex((h) => h.address.toLowerCase() === picked) : -1;
  const pickedHolder = pickedIdx >= 0 ? line.holders[pickedIdx] : null;
  const pickedInCrowd = pickedIdx >= 0 && pickedIdx < crowd.length ? pickedIdx : -1;
  const behind = pickedIdx < 0 || inLine === null ? null : Math.max(0, inLine - (pickedIdx + 1));
  const pickedTrade = picked ? line.trades.find((t) => t.actor.toLowerCase() === picked) : undefined;
  const sceneRef = useRef<HTMLDivElement>(null);
  const personRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [bracket, setBracket] = useState<{ left: number; width: number } | null>(null);
  const measure = useCallback(() => {
    const sc = sceneRef.current;
    const back = personRefs.current.slice(pickedInCrowd + 1, crowd.length).filter((el): el is HTMLButtonElement => !!el);
    if (!sc || pickedInCrowd < 0 || back.length === 0) return setBracket(null);
    const base = sc.getBoundingClientRect().left;
    const rs = back.map((el) => el.getBoundingClientRect()).filter((r) => r.right > base);
    if (!rs.length) return setBracket(null);
    const left = Math.max(4, Math.min(...rs.map((r) => r.left)) - base - 4);
    const right = Math.max(...rs.map((r) => r.right)) - base + 4;
    setBracket({ left, width: right - left });
  }, [pickedInCrowd, crowd.length]);
  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, phone]);
  const pick = (addr: string) => {
    const a = addr.toLowerCase();
    setPicked((p) => (p === a ? null : a));
    requestAnimationFrame(() => document.getElementById("v6-holder")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicked(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picked]);

  const markOf = (addr: string) => front?.marks.get(addr.toLowerCase()) ?? null;
  const markText = (addr: string) => {
    const m = markOf(addr);
    return m ? ` · ${[m.sn && "known sniper", m.fa && "farm wallet", m.bu && "bundled buy"].filter(Boolean).join(", ")}` : "";
  };
  const marksOf = (addr: string) => {
    const m = markOf(addr);
    if (!m) return null;
    return (
      <span className={styles.marks} aria-hidden>
        {m.sn && <i className={rp.mSn} />}
        {m.fa && <i className={rp.mFa} />}
        {m.bu && <i className={rp.mBu} />}
      </span>
    );
  };

  // vibe/vibe isn't answering: old numbers are marked stale; with nothing to show it reads on, then gives up below
  const status = conn === "retry" && !failed ? (
    <span className={styles.plate} role="status" title="vibe/vibe isn't answering.">{known ? "stale" : "Reading…"}</span>
  ) : null;

  return (
    <section className={styles.page}>
      <div className="wrap">
        <TokenHead
          token={token}
          info={{ name: line.name, symbol: line.symbol, image: line.image, creator: line.creator }}
          age={age}
          status={status}
          about={about}
          creator={null}
          actions={
            <>
              {/* the quiet link first, the primary last: TokenHead puts the last action first, full width, on phones */}
              <ShareCard kind="line" id={token} symbol={line.symbol || null} grade={shareGrade} fullCheck={shareFull} className="btn quiet" rootClassName={styles.shareRight} />
              <a className="btn start" href={vibeUrl} target="_blank" rel="noreferrer">Trade on vibe ↗</a>
            </>
          }
        />

        <Unreadable failed={failed} className={styles.note} />

        {/* 1. the verdict */}
        <Verdict state={analytics} health={health} passport={passport} token={token} createdAt={line.createdAt || null} />

        {/* 2. the line, by bag */}
        <section id="line" className={styles.lineTop} aria-label="The line by bag size">

        {/* the corridor: biggest bag at the door, the line trailing off to the left */}
        {/* a group, not role="img": an img role hides the clickable people from keyboards and screen readers */}
        <div ref={sceneRef} className={styles.scene} role="group" aria-label={known ? `The line by bag size: ${inLine ?? "unknown"} holders, the door ${line.graduated ? "is open" : doorPct === null ? "at an unknown point" : `${doorPct.toFixed(1)}% open`}. Pick a person to open their card.` : "Holders unknown right now"}>
          <div className={styles.wall} aria-hidden />
          <div className={styles.crowd} onScroll={measure}>
            {known && crowd.map((h, i) => (
              <button
                type="button"
                key={h.address}
                ref={(el) => {
                  personRefs.current[i] = el;
                }}
                className={`${styles.person} ${i === 0 ? styles.front : ""} ${i === pickedInCrowd ? styles.picked : ""} ${pickedInCrowd >= 0 && i > pickedInCrowd ? styles.behind : ""}`}
                style={{ animationDelay: `${(i % 5) * 0.17}s` }}
                title={`#${i + 1} by bag · ${shortAddr(h.address)} · ${share(h.shareBps)} of supply${h.isCreator ? " · the dev" : ""}${markText(h.address)}`}
                aria-label={`#${i + 1} by bag${h.isCreator ? ", the dev" : ""}, ${h.address}, ${share(h.shareBps)} of supply${markText(h.address)}. Open card`}
                aria-pressed={i === pickedInCrowd}
                aria-controls="v6-holder"
                onClick={() => pick(h.address)}
              >
                <Sprite skin={skinOf(h)} scale={1} face="right" />
                <span className={styles.label}>
                  {marksOf(h.address)}
                  {h.isCreator ? "DEV" : `#${i + 1}`}<b>{share(h.shareBps)}</b>
                </span>
              </button>
            ))}
            {known && rest > 0 && <span className={styles.more}>&lt; +{fmtInt(rest)} more</span>}
            {known && crowd.length === 0 && <span className={styles.empty}>{inLine === 0 ? "Nobody holds it yet." : "No bags reported yet."}</span>}
            {!known && <span className={styles.empty}>Holders unknown right now</span>}
          </div>
          <div className={styles.door} aria-hidden>
            <span className={styles.sign}>EXIT</span>
            <span className={styles.frame}>
              <i style={{ height: `${line.graduated ? 100 : Math.max(0, Math.min(100, doorPct ?? 0))}%` }} />
            </span>
            <span className={styles.doorPct}>{line.graduated ? "OPEN" : doorPct === null ? "?% OPEN" : `${doorPct.toFixed(1)}% OPEN`}</span>
          </div>
          <div className={styles.floor} aria-hidden />
          {bracket && behind !== null && (
            <span className={styles.bracket} style={{ left: bracket.left, width: bracket.width }} aria-hidden>
              <span>BEHIND · {fmtInt(behind)}</span>
            </span>
          )}
        </div>

        <FrontCaption front={front} health={health}>
          {known && inLine !== null && <span className={styles.byBag}>by bag · {fmtInt(inLine)} holders</span>}
        </FrontCaption>

        {pickedHolder && (
          <section id="v6-holder" className={styles.card} aria-label="Holder card">
            <div className={styles.cardHead}>
              <Sprite skin={skinOf(pickedHolder)} scale={1} face="right" />
              <div className={styles.who}>
                <span className={styles.addrCell}>
                  <a href={`${EXPLORER}/address/${pickedHolder.address}`} target="_blank" rel="noreferrer" className={styles.addr} title="Open in the explorer">{shortAddr(pickedHolder.address)} ↗</a>
                  {pickedHolder.isCreator && <span className={styles.devChip}>DEV</span>}
                </span>
                <small>Ranked by bag</small>
              </div>
              <div className={styles.place}>
                <b>#{pickedIdx + 1}</b>
                <span>/ {inLine === null ? "—" : fmtInt(inLine)}</span>
              </div>
              <button type="button" className={styles.close} onClick={() => setPicked(null)} aria-label="Close the card">×</button>
            </div>
            <dl className={styles.cardStats}>
              <div><dt>Share</dt><dd>{share(pickedHolder.shareBps)}</dd></div>
              <div><dt>Bag</dt><dd>{fmtTokens(pickedHolder.balance)}</dd></div>
              <div><dt>Bigger bags</dt><dd>{fmtInt(pickedIdx)}</dd></div>
              <div><dt>Behind</dt><dd className={styles.hot}>{behind === null ? "—" : fmtInt(behind)}</dd></div>
            </dl>
            {pickedTrade && (
              <p className={styles.lastTrade}>
                <span className={styles.muted}>Last trade</span>
                <span className={pickedTrade.side === "BUY" ? styles.up : styles.down}>{pickedTrade.side === "BUY" ? "Buy" : "Sell"}</span>
                <span className={styles.num}>{money(pickedTrade.pair)}</span>
                <span className={styles.muted}>{now !== null && pickedTrade.at ? fmtAge(now / 1000 - pickedTrade.at) : ""}</span>
              </p>
            )}
            <div className={styles.cardLinks}>
              <Link href={`/w/${pickedHolder.address.toLowerCase()}`} prefetch={false}>Wallet profile →</Link>
              {pickedHolder.isCreator && <Link href={`/w/${pickedHolder.address.toLowerCase()}#launches`} prefetch={false}>Dev passport →</Link>}
            </div>
          </section>
        )}

        </section>

        {/* 3. the numbers: one row */}
        <Figures state={analytics} fallback={fallback} mcap={market.mcap} vol={market.vol} holders={market.holders} curve={market.curve} />

        <ReportSections
          state={analytics}
          creator={line.creator}
          unit={line.pair.native ? "ETH" : pairSym}
          fallback={fallback}
          passport={passport}
          token={token}
          details={health.res || has(a?.bundle.data) || has(a?.supply.data) || has(a?.volume.data) || has(a?.exitMath.data) || has(a?.clones.data) ? <>
            {has(a?.bundle.data) && <Cards part="bundle" state={analytics} />}
            {has(a?.supply.data) && <Cards part="supply" state={analytics} />}
            {health.res && <div className={rp.wide}><FirstBuyersCard health={health} /></div>}
            {has(a?.volume.data) && <Cards part="volume" state={analytics} />}
            {has(a?.exitMath.data) && <Cards part="exit" state={analytics} />}
            {has(a?.clones.data) && <Cards part="clones" state={analytics} />}
          </> : undefined}
        />

        {/* 4. at the bottom: the trades and the holders */}
        <div className={styles.grid}>
          <section className={styles.panel} aria-labelledby="v6-tape">
            <h2 id="v6-tape" className={styles.ph}>Trades <span>{known ? `last ${line.trades.length}` : "—"}</span></h2>
            {!known ? (
              <p className={styles.note}>Trades unknown right now.</p>
            ) : line.trades.length === 0 ? (
              <p className={styles.note}>No trades yet.</p>
            ) : (
              <ol className={styles.tape}>
                {line.trades.map((t) => (
                  <li key={t.id}>
                    <span className={t.side === "BUY" ? styles.up : styles.down}>{t.side === "BUY" ? "Buy" : "Sell"}</span>
                    <span className={styles.addrCell}><a href={`${EXPLORER}/address/${t.actor}`} target="_blank" rel="noreferrer" className={styles.addr}>{shortAddr(t.actor)}</a><ProfileLink addr={t.actor} /></span>
                    <span className={styles.num}>{money(t.pair)}</span>
                    <span className={`${styles.num} ${styles.muted}`}>{fmtTokens(t.tokens)}</span>
                    {t.tx ? (
                      <a href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noreferrer" className={styles.when} title="Open the transaction">{now !== null && t.at ? fmtAge(now / 1000 - t.at) : "tx"}</a>
                    ) : (
                      <span className={styles.when}>{now !== null && t.at ? fmtAge(now / 1000 - t.at) : ""}</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className={styles.panel} aria-labelledby="v6-holders">
            <h2 id="v6-holders" className={styles.ph}>Holders by bag <span>{known ? (line.holdersComplete && line.holders.length <= HOLDERS_SHOWN ? "all" : `top ${Math.min(HOLDERS_SHOWN, line.holders.length)}`) : "—"}</span></h2>
            {!known ? (
              <p className={styles.note}>Holders unknown right now.</p>
            ) : line.holders.length === 0 ? (
              <p className={styles.note}>No holders reported yet.</p>
            ) : (
              <ol className={styles.holders}>
                {line.holders.slice(0, HOLDERS_SHOWN).map((h, i) => (
                  <li key={h.address}>
                    <span className={styles.rank}>#{i + 1}</span>
                    <span className={styles.addrCell}>
                      <a href={`${EXPLORER}/address/${h.address}`} target="_blank" rel="noreferrer" className={styles.addr}>{shortAddr(h.address)}</a>
                      {h.isCreator && <Link href={`/w/${h.address.toLowerCase()}#launches`} prefetch={false} className={styles.dev} title="Open the dev passport">Dev →</Link>}
                      <ProfileLink addr={h.address} />
                    </span>
                    <span className={styles.bar} aria-hidden><i style={{ width: `${h.shareBps === null ? 0 : Math.min(100, h.shareBps / 100)}%` }} /></span>
                    <span className={styles.num}>{share(h.shareBps)}</span>
                    <span className={`${styles.num} ${styles.muted}`}>{fmtTokens(h.balance)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {!line.coverageComplete && known && <p className={styles.fine}>Trade history incomplete.</p>}
      </div>
    </section>
  );
}
