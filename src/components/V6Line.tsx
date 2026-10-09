"use client";
// A taxed v6 launch as a line, "lite": our chain engine reads v1 curves only, so this page shows what
// vibe/vibe's own indexer reports, and says so. The order is holders by bag (biggest nearest the door),
// NOT buy order; the door is the pair reserve on the curve over its target. Unknown = "—", never 0.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import Sprite from "./Sprite";
import TokenHead from "./TokenHead";
import ProfileLink from "./ProfileLink";
import type { TokenAbout } from "@/lib/lineContext";
import type { V6Holder, V6Line as Line } from "@/lib/v6";
import type { Skin } from "@/lib/skins";
import { EXPLORER, VIBE_APP } from "@/lib/config";
import { fmtAge, fmtCompact, fmtEth, fmtInt, fmtTokens, shortAddr } from "@/lib/format";
import styles from "./V6Line.module.css";

const POLL_MS = 20_000; // the v6 line is CDN-cached 20 s (api/v6)
const CROWD_MAX = 14; // people drawn in the corridor; the rest are "+N more" (the holder list has them all)
const CROWD_MAX_PHONE = 3; // ≤760 px: 3 people (≈51 px each) + "+N more" fit whole beside the door at 360 px, no plate cut
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

export default function V6Line({ initial }: { initial: Line }) {
  const [line, setLine] = useState<Line>(initial);
  const [conn, setConn] = useState<"ok" | "retry">(initial.updatedAt ? "ok" : "retry");
  const [now, setNow] = useState<number | null>(null);
  const token = initial.token;
  const busy = useRef(false);
  // phones draw fewer people (one fixed count, so "+N more" stays honest)
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
        setConn(j.updatedAt ? "ok" : "retry");
      } catch {
        if (!dead) setConn("retry");
      } finally {
        busy.current = false;
        if (!dead) setNow(Date.now());
      }
    };
    const t0 = setTimeout(() => setNow(Date.now()), 0);
    const iv = setInterval(() => void run(), POLL_MS);
    return () => {
      dead = true;
      clearTimeout(t0);
      clearInterval(iv);
    };
  }, [token]);

  const known = line.updatedAt > 0; // holders/trades/stats came back at least once
  const dec = line.pair.decimals;
  const pairSym = line.pair.symbol;
  const money = (v: string | null) => {
    const n = units(v, dec);
    return n === null ? "—" : line.pair.native ? `${fmtEth(n)} ETH` : `${fmtCompact(n)} ${pairSym}`;
  };
  const doorPct = line.doorBps === null ? null : line.doorBps / 100;
  const crowd = line.holders.slice(0, phone ? CROWD_MAX_PHONE : CROWD_MAX);
  const inLine = line.holderCount ?? (known && line.holdersComplete ? line.holders.length : null);
  const rest = inLine === null ? 0 : Math.max(0, inLine - crowd.length);
  const age = now !== null && line.createdAt ? fmtAge(now / 1000 - line.createdAt) : null;
  const vibeUrl = `${VIBE_APP}/token/${token}`;
  const about = useMemo(() => aboutOf(line), [line]);
  const lastPrice = units(line.lastPrice, dec);

  const status = conn === "retry" ? (
    <span className={styles.plate} role="status" title="vibe/vibe isn't answering.">Retrying…</span>
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
              <Link className="btn quiet" href="/launches?tab=new">All launches</Link>
              <a className="btn start" href={vibeUrl} target="_blank" rel="noreferrer">Trade on vibe ↗</a>
            </>
          }
        />

        <p className={styles.kind}>
          <span className={styles.tag}>v6</span>
          <span>Ranked by bag, read from vibe/vibe</span>
          <span className={styles.sep} aria-hidden>·</span>
          <span className={styles.taxChip} title={line.taxSplit ? `Tax on every trade: ${taxText(line.taxBps)}. Split: ${line.taxSplit.cashBps / 100}% project, ${line.taxSplit.holdersBps / 100}% holders, ${line.taxSplit.burnBps / 100}% burn.` : undefined}>
            {taxText(line.taxBps)} tax
          </span>
          {!line.pair.native && <span className={styles.muted}>paired with {pairSym}</span>}
        </p>
        {/* the engine reads v1 curves only: say the gap, so a missing Risk / Holders check reads as unknown, not clean */}
        <p className={styles.gap} role="note">Risk and holder analytics (Line health, bundles, supply, the dev) are not available for taxed v6 launches yet. Unknown, not clean.</p>

        <dl className={styles.stats}>
          <div>
            <dt>Door</dt>
            <dd className={line.graduated ? styles.hot : undefined}>{line.graduated ? "Open" : doorPct === null ? "—" : `${doorPct.toFixed(1)}%`}</dd>
            <small>{line.graduated ? "Graduated" : `${money(line.reserve)} of ${money(line.target)}`}</small>
          </div>
          <div>
            <dt>Holders</dt>
            <dd>{inLine === null ? "—" : fmtInt(inLine)}</dd>
            <small>{line.stats.buyers24h === null ? " " : `${fmtInt(line.stats.buyers24h)} buyers 24h`}</small>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>{taxText(line.taxBps)}</dd>
            <small>{line.taxSplit ? `${line.taxSplit.holdersBps / 100}% of it to holders` : " "}</small>
          </div>
          <div>
            <dt>Vol 24h</dt>
            <dd>{known ? money(line.stats.volume24h) : "—"}</dd>
            <small>{known ? `1h ${money(line.stats.volume1h)}` : " "}</small>
          </div>
          <div>
            <dt>Buys / Sells 24h</dt>
            <dd>
              <span className={styles.up}>▲{line.stats.buys24h ?? "—"}</span> <span className={line.stats.sells24h ? styles.down : styles.muted}>▼{line.stats.sells24h ?? "—"}</span>
            </dd>
            <small>1h ▲{line.stats.buys1h ?? "—"} ▼{line.stats.sells1h ?? "—"}</small>
          </div>
          <div>
            <dt>Price 1h</dt>
            <dd className={line.stats.change1hBps === null || Math.abs(line.stats.change1hBps) < 5 ? styles.muted : line.stats.change1hBps > 0 ? styles.up : styles.down}>{chg(line.stats.change1hBps)}</dd>
            <small title="Price of the last trade, per whole token">{lastPrice === null ? " " : `last ${line.pair.native ? fmtEth(lastPrice) : fmtCompact(lastPrice)} ${pairSym}`}</small>
          </div>
        </dl>

        {/* the corridor: biggest bag at the door, the line trailing off to the left */}
        <div className={styles.scene} role="img" aria-label={known ? `The line by bag size: ${inLine ?? "unknown"} holders, the door ${line.graduated ? "is open" : doorPct === null ? "at an unknown point" : `${doorPct.toFixed(1)}% open`}` : "Holders unknown right now"}>
          <div className={styles.wall} aria-hidden />
          <div className={styles.crowd}>
            {known && crowd.map((h, i) => (
              <div key={h.address} className={`${styles.person} ${i === 0 ? styles.front : ""}`} style={{ animationDelay: `${(i % 5) * 0.17}s` }} title={`#${i + 1} by bag · ${shortAddr(h.address)} · ${share(h.shareBps)} of supply${h.isCreator ? " · the dev" : ""}`}>
                <Sprite skin={skinOf(h)} scale={1} face="right" />
                <span className={styles.label}>{h.isCreator ? "DEV" : `#${i + 1}`}<b>{share(h.shareBps)}</b></span>
              </div>
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
        </div>

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
                      {h.isCreator && <Link href={`/dev/${h.address.toLowerCase()}`} prefetch={false} className={styles.dev} title="Open the dev passport">Dev →</Link>}
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

        <p className={styles.fine}>
          Taxed v6 launch: data from vibe/vibe, every 20 s. Ordered by bag, no places or points. Door = {pairSym} on the curve / target.
          {!line.coverageComplete && known ? " Trade history incomplete." : ""}
        </p>
      </div>
    </section>
  );
}
