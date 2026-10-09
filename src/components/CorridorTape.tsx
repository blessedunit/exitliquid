"use client";
// The trade tape: every buy and sell, newest first. A row opens that wallet's ticket.
import { useEffect, useRef, useState } from "react";
import { useLineCtx } from "@/lib/lineContext";
import styles from "./CorridorTape.module.css";
import { fmtAge, fmtCompact, fmtEth, shortAddr } from "@/lib/format";
import ProfileLink from "./ProfileLink";
import type { WireTrade } from "@/lib/types";
import type { WalletTag } from "@/lib/analytics/types";
import { TAG_HINT, TAG_TEXT, TAG_TONE } from "./analytics/walletTags";

const wallet = (value: string) => shortAddr(value);
const amount = fmtCompact;
const eth = fmtEth;
const ageSeconds = (ts: number, updatedAt: number) => Math.max(0, Math.floor(updatedAt / 1000 - ts));
const age = fmtAge;
const exact = (v: number) => v.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
const FRESH_SECONDS = 30; // rows younger than this are highlighted as new
// trades under the line's entry size (0.0003 ETH) are dust: hidden by default, one click shows them
const DUST_ETH = 0.0003;
// the tape opens at 8 rows (the live view under the corridor); "Show all" opens the full scrolling tape
const FIRST_ROWS = 8;

export default function CorridorTape({
  trades,
  symbol,
  updatedAt,
  selected,
  onSelect,
  places,
  lineComplete = false,
  unknown = false,
  limit = 300,
  hint,
  tags,
}: {
  trades: WireTrade[];
  symbol?: string;
  updatedAt: number;
  selected?: string;
  onSelect: (wallet: string) => void;
  /** wallet -> current place in line (the loaded part of the line) */
  places?: Map<string, number>;
  /** the whole line is loaded, so "not found" really means "not in line" */
  lineComplete?: boolean;
  /** the queue is unreachable: the tape is unknown, not empty */
  unknown?: boolean;
  limit?: number;
  /** a short line in the tape header (e.g. how to open a ticket when no side column is shown) */
  hint?: string;
  /** wallet -> dev / sniper / farm / gifted (token analytics); absent = no tags yet */
  tags?: Record<string, WalletTag>;
}) {
  // older history, loaded on demand (the live poll only carries the newest rows)
  const { token: otherToken } = useLineCtx(); // older pages (/api/trades) exist only for $EXIT
  const [older, setOlder] = useState<WireTrade[]>([]);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "end" | "error">("idle");
  const loadOlder = async () => {
    setOlderState("loading");
    try {
      const r = await fetch(`/api/trades?skip=${trades.length + older.length}&limit=200`);
      if (!r.ok) throw new Error(String(r.status));
      const page = (await r.json()) as { trades: WireTrade[]; total: number };
      const next = [...page.trades, ...older];
      setOlder(next);
      setOlderState(trades.length + next.length >= page.total || !page.trades.length ? "end" : "idle");
    } catch {
      setOlderState("error");
    }
  };
  const all = [...older, ...trades.slice(-limit)].reverse();
  const [showDust, setShowDust] = useState(false);
  // a size we can't read is never "dust": only a known small trade is hidden
  const isDust = (t: WireTrade) => {
    const v = t.side === "sell" ? t.sellValueEth : t.buyCostEth;
    return v != null && Number.isFinite(v) && v < DUST_ETH;
  };
  const dust = all.reduce((n, t) => n + (isDust(t) ? 1 : 0), 0);
  const filtered = showDust ? all : all.filter((t) => !isDust(t));
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? filtered : filtered.slice(0, FIRST_ROWS);
  // the tape scrolls inside itself, but only once the pointer has settled on it (or it was clicked):
  // a page scroll that merely passes over the tape keeps scrolling the page
  const [active, setActive] = useState(false);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDwell = () => { if (dwell.current) clearTimeout(dwell.current); dwell.current = null; };
  useEffect(() => clearDwell, []);
  const onMove = (e: React.PointerEvent) => {
    if (active || e.pointerType !== "mouse" || dwell.current) return;
    dwell.current = setTimeout(() => { dwell.current = null; setActive(true); }, 350);
  };
  const onWheelIdle = () => clearDwell(); // still scrolling the page: restart the wait
  const onLeave = () => { clearDwell(); setActive(false); };
  const token = symbol ? `$${symbol}` : "Amount";

  const place = (trade: WireTrade) => {
    const p = places?.get(trade.wallet);
    if (p) return { text: `#${p}`, title: "Current place in line", dim: false };
    if (!lineComplete) return { text: "—", title: "Not in the loaded part of the line", dim: true };
    return trade.side === "sell"
      ? { text: "out", title: "Not in line any more", dim: true }
      : { text: "—", title: "Not in line: under 0.0003 ETH, or sold since", dim: true };
  };

  return (
    <section className={styles.tape} aria-labelledby="tape-title">
      <div className={styles.head}>
        <h2 id="tape-title">Tape</h2>
        {hint && <span className={styles.hint}>{hint}</span>}
        {dust > 0 && (
          <button type="button" className={styles.dustBtn} onClick={() => setShowDust((v) => !v)} aria-pressed={showDust} title={`Trades under ${DUST_ETH} ETH (the line's entry size)`}>
            {showDust ? "Hide tiny trades" : <>Show {dust} tiny trades<span className={styles.hideM}> (&lt;{DUST_ETH} ETH)</span></>}
          </button>
        )}
      </div>
      <div
        className={`${styles.scroll} ${expanded ? styles.scrollAll : ""} ${active ? styles.scrollOn : ""}`}
        onPointerMove={onMove}
        onPointerDown={() => { clearDwell(); setActive(true); }}
        onPointerLeave={onLeave}
        onWheel={active ? undefined : onWheelIdle}
      >
        <div className={`${styles.row} ${styles.cols}`} aria-hidden>
          <span>Age</span><span>Side</span><span>Wallet</span><span className={styles.num}>ETH</span><span className={`${styles.num} ${styles.hideM}`}>{token}</span><span className={`${styles.num} ${styles.hideM}`}>Place</span>
        </div>
        {rows.length ? rows.map((trade, index) => {
          const secs = ageSeconds(trade.ts, updatedAt);
          const p = place(trade);
          const value = trade.side === "sell" ? trade.sellValueEth : trade.buyCostEth;
          const valueTitle = trade.side === "sell"
            ? value == null ? "Sale value unavailable" : `${trade.estimated ? "Estimated ETH received" : "ETH received after the 1.25% fee"}: ${exact(value)} ETH`
            : value == null ? "Buy cost unavailable" : `ETH paid incl. the 1.25% fee: ${exact(value)} ETH`;
          // the row opens the ticket; the profile icon sits over the wallet cell as its own link (no link inside a button)
          return (
            <div className={styles.rowWrap} key={`${trade.tx ?? trade.ts}-${trade.wallet}-${index}`}>
            <button
              type="button"
              className={`${styles.row} ${selected === trade.wallet ? styles.active : ""} ${updatedAt && secs < FRESH_SECONDS ? styles.fresh : ""}`}
              onClick={() => onSelect(trade.wallet)}
              aria-label={`${trade.side} by ${trade.wallet}, ${age(secs)} ago. Open ticket`}
              aria-pressed={selected === trade.wallet}
            >
              <span className={styles.t3}>{updatedAt ? age(secs) : "—"}</span>
              <span className={`${styles.side} ${trade.side === "buy" ? styles.up : styles.down}`}>{trade.side === "buy" ? "Buy" : "Sell"}</span>
              <span className={styles.wallet}>{wallet(trade.wallet)}{tags?.[trade.wallet] && <i className={`${styles.tag} ${styles[`tag_${TAG_TONE[tags[trade.wallet]]}`]}`} title={TAG_HINT[tags[trade.wallet]]}>{TAG_TEXT[tags[trade.wallet]]}</i>}</span>
              <span className={styles.num} title={valueTitle}>{value == null ? "—" : `${trade.estimated ? "~" : ""}${eth(value)}`}</span>
              <span className={`${styles.num} ${styles.t2} ${styles.hideM}`} title={`${trade.tokens.toLocaleString("en-US")} ${token}`}>{amount(trade.tokens)}</span>
              <span className={`${styles.num} ${styles.hideM} ${p.dim ? styles.t3 : ""}`} title={p.title}>{p.text}</span>
            </button>
            <ProfileLink addr={trade.wallet} className={styles.prof} />
            </div>
          );
        }) : updatedAt && !unknown ? (
          <p className={styles.empty}>{dust > 0 ? `Only tiny trades so far (${dust}, under ${DUST_ETH} ETH).` : "No trades yet."}</p>
        ) : (
          // loading, or live data unknown (the page shows one "Reconnecting" plate): rows waiting, never "no trades"
          <div className={styles.skeleton} aria-label={unknown ? "Trades unknown right now" : "Reading the tape"} role="status">
            {Array.from({ length: 8 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.08}s` }} />)}
          </div>
        )}
        {!expanded && filtered.length > FIRST_ROWS && (
          <button type="button" className={styles.loadOlder} onClick={() => setExpanded(true)} aria-expanded={false}>
            Show all {filtered.length.toLocaleString("en-US")} trades
          </button>
        )}
        {expanded && (
          <button type="button" className={styles.loadOlder} onClick={() => { setExpanded(false); setActive(false); }} aria-expanded>
            Show less
          </button>
        )}
        {expanded && rows.length > 0 && (
          otherToken || olderState === "end" || trades.length < limit
            ? <div className={styles.historyEnd}>{otherToken ? `Last ${rows.length} trades` : `Start of history · ${rows.length} trades`}</div>
            : <button type="button" className={styles.loadOlder} onClick={loadOlder} disabled={olderState === "loading"}>
                {olderState === "loading" ? "Loading…" : olderState === "error" ? "Couldn't load · try again" : `Load older · ${rows.length} shown`}
              </button>
        )}
      </div>
    </section>
  );
}
