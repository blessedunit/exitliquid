"use client";
// The ticket of one wallet, opened by a click on a person in the line or a row on the tape.
// Until then: a one-line empty state. PnL and stock pockets come from /api/ticket ($EXIT only);
// other lines show a dash in the PnL cell.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLineCtx } from "@/lib/lineContext";
import PixelIcon from "./PixelIcon";
import Sprite from "./Sprite";
import { PNL_TITLE, pnlFigures } from "./PositionPnl";
import { groupFor, TIERS } from "@/lib/queue";
import { fmtCompact, fmtEth, fmtInt, fmtTokens, shortAddr } from "@/lib/format";
import { EXPLORER } from "@/lib/config";
import ProfileLink from "./ProfileLink";
import type { WalletTag } from "@/lib/analytics/types";
import { TAG_HINT, TAG_TEXT } from "./analytics/walletTags";
import type { QueueResponse, TicketResponse, WireEntry, WireTrade } from "@/lib/types";
import styles from "./MarketPass.module.css";

type Props = {
  wallet: string | null;
  entry?: WireEntry;
  trade?: WireTrade;
  data: QueueResponse | null;
  onClose: () => void;
  /** dev / sniper / farm / gifted, from the token analytics (null = no tag or unknown) */
  tag?: WalletTag | null;
};

const STOCKS_TITLE = "Testnet stock tokens this wallet holds (TSLA, AMZN, PLTR, NFLX, AMD, SPCX). They add a badge.";

function date(ts: number) {
  if (!ts) return "Time unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  }).format(ts * 1000);
}

export default function MarketPass({ wallet, entry, trade, data, onClose, tag = null }: Props) {
  const [ticket, setTicket] = useState<TicketResponse | null>(null);
  const [copiedWallet, setCopiedWallet] = useState<string | null>(null);
  const { token: otherToken } = useLineCtx();
  useEffect(() => {
    if (!wallet || otherToken) return; // the ticket API (PnL, stock pockets) is $EXIT-only
    const controller = new AbortController();
    fetch(`/api/ticket/${wallet}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<TicketResponse> : null)
      .then((value) => { if (!controller.signal.aborted) setTicket(value); })
      .catch(() => {});
    return () => controller.abort();
  }, [wallet, otherToken]);

  if (!wallet) {
    return (
      <div className={styles.empty}>
        <Sprite skin="getaway" scale={1} face="right" className={styles.emptySprite} />
        <p>Tap anyone in the line or on the tape to open a ticket.</p>
      </div>
    );
  }

  const rank = entry ? entry.isCreator ? "The Dev" : TIERS.find((tier) => tier.tier === entry.tier)?.name ?? "In line" : "Not in line";
  const tokenLabel = data?.symbol ? `$${data.symbol}` : "tokens";
  const details = ticket?.wallet === wallet ? ticket : null;
  const stocks = !details ? "Reading…" : details.stockBacked === null ? "Unknown" : details.stockBacked.length ? details.stockBacked.map((stock) => stock.symbol).join(" · ") : "None";
  const receipt = entry
    ? { heading: "Entry buy", valueLabel: "Est. entry", tokens: entry.entryTokens, eth: entry.entryValueEth, ts: entry.enteredTs }
    : trade
      ? {
          heading: `Last ${trade.side}`,
          valueLabel: trade.side === "sell" ? "Est. sold" : trade.buyCostExact ? "ETH sent" : "Est. buy",
          tokens: trade.tokens,
          eth: trade.side === "sell" ? trade.sellValueEth ?? null : trade.buyCostEth ?? null,
          ts: trade.ts,
        }
      : null;
  const copyWallet = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopiedWallet(wallet);
      window.setTimeout(() => setCopiedWallet((current) => current === wallet ? null : current), 2000);
    } catch { setCopiedWallet(null); }
  };
  // PnL cell: always filled (a value, "Reading…" or a neutral dash), so the grid never shows a hole
  const pnl = entry && !otherToken && details ? pnlFigures(entry, details.pnl) : null;
  const pnlCell = otherToken
    ? { value: "—", sub: null, tone: "", title: "PnL is shown for the $EXIT line only." }
    : !details
      ? { value: "Reading…", sub: null, tone: "", title: PNL_TITLE }
      : !pnl
        ? { value: "—", sub: null, tone: "", title: "No sell quote right now. " + PNL_TITLE }
        : {
            value: pnl.eth,
            sub: [pnl.usd ? `(${pnl.usd})` : null, `${pnl.sign}${Math.abs(pnl.pct).toFixed(1)}%`].filter((part): part is string => part !== null),
            tone: pnl.diff > 0 ? styles.up : pnl.diff < 0 ? styles.down : "",
            title: `${PNL_TITLE} ${pnl.source}.`,
          };
  const total = data && !data.unavailable ? fmtInt(data.totals.inLine) : "—";

  return (
    <section className={styles.pass} aria-live="polite" aria-label={`Ticket for ${wallet}`}>
      <div className={styles.head}>
        <h2>Ticket</h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close ticket">×</button>
      </div>

      <div className={styles.who}>
        <span className={styles.sprite} aria-hidden>
          <Sprite skin={entry?.isCreator ? "doorghost" : entry?.skin ?? "plain"} scale={2} face="right" />
        </span>
        <div className={styles.whoText}>
          <div className={styles.walletRow}>
            <a className={styles.address} href={`${EXPLORER}/address/${wallet}`} target="_blank" rel="noreferrer" title={`View ${wallet} on the explorer`}>{shortAddr(wallet)} ↗</a>
            <button type="button" className={styles.copy} onClick={copyWallet} aria-label={copiedWallet === wallet ? "Address copied" : `Copy wallet address ${wallet}`}>
              <PixelIcon name={copiedWallet === wallet ? "check" : "copy"} size={12} />
            </button>
            <ProfileLink addr={wallet} />
          </div>
          <span className={styles.rank}>{entry ? `${rank} · ${groupFor(entry.place, entry.isCreator)}` : rank}{tag && tag !== "dev" && <span title={TAG_HINT[tag]}> · {TAG_TEXT[tag]}</span>}</span>
        </div>
        {entry && (
          <div className={styles.place}>
            <span>Place</span>
            <b>#{entry.place}<small> / {total}</small></b>
          </div>
        )}
      </div>

      <p className={styles.lineNote}>
        {entry
          ? `${fmtInt(entry.ahead)} ahead in line`
          : "Sold out of the line, or bought under 0.0003 ETH."}
      </p>

      {entry && (
        <dl className={styles.kvs}>
          <div title="Points from new buyers who joined behind this wallet"><dt>Points</dt><dd>{fmtInt(entry.lp)}</dd></div>
          <div><dt>Bag</dt><dd>{fmtTokens(entry.balance)}</dd></div>
          <div title="Wallets behind this one in line"><dt>Behind you</dt><dd className={styles.acc}>{fmtInt(entry.behind)}</dd></div>
          <div title={pnlCell.title}><dt>PnL</dt><dd className={`${styles.pnl} ${pnlCell.tone}`}>{pnlCell.value}{pnlCell.sub && <small>{pnlCell.sub.map((part) => <span key={part}>{part}</span>)}</small>}</dd></div>
          {!otherToken && <div className={styles.wideKv}><dt title={STOCKS_TITLE}>Stock pockets</dt><dd>{stocks}</dd></div>}
        </dl>
      )}

      {receipt && (
        <div className={styles.receipt}>
          <div className={styles.receiptHead}><span>{receipt.heading}</span><time dateTime={new Date(receipt.ts * 1000).toISOString()}>{date(receipt.ts)}</time></div>
          <div className={styles.receiptLine}><span>Quantity</span><b title={`${receipt.tokens.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${tokenLabel}`}>{fmtCompact(receipt.tokens)} {tokenLabel}</b></div>
          <div className={styles.receiptLine}><span>{receipt.valueLabel}</span><b title={receipt.eth === null ? "Historical testnet ETH amount unavailable" : `${receipt.eth.toFixed(12)} testnet ETH`}>{fmtEth(receipt.eth)} ETH</b></div>
        </div>
      )}

      <div className={styles.foot}>
        <Link href={`/w/${wallet.toLowerCase()}`} prefetch={false}>Wallet profile</Link>
        <Link href={`/t/${wallet}`} prefetch={false}>Open full ticket ↗</Link>
      </div>
    </section>
  );
}
