"use client";

import type { TicketPnl, WireEntry } from "@/lib/types";
import styles from "./PositionPnl.module.css";

const SELL_FEE = 0.0125;

export type PnlFigures = {
  diff: number; // ETH, sale value now minus cost
  pct: number;
  sign: "+" | "-";
  eth: string; // "+0.0278 ETH"
  usd: string | null; // "+$74.76"
  source: string; // where the sale value came from
};

/** Illustrative testnet PnL: what selling the whole bag returns now, minus what it cost. Null = unknown. */
export function pnlFigures(entry: WireEntry, pnl: TicketPnl | null | undefined): PnlFigures | null {
  const cost = entry.positionCostEth;
  const tokens = Number(BigInt(entry.balance) / 10n ** 12n) / 1e6;
  let value: number | null = null;
  let source = "";
  if (pnl?.sellQuoteEth != null) {
    value = pnl.sellQuoteEth; // the curve's own quote for selling the whole bag, after the 1.25% fee
    source = "Curve sell quote · after fee";
  } else if (pnl?.graduated && pnl.markPriceEth && pnl.markPriceEth > 0) {
    value = tokens * pnl.markPriceEth * (1 - SELL_FEE);
    const age = pnl.markPriceTs ? Math.max(0, Math.floor(pnl.asOf / 1000 - pnl.markPriceTs)) : null;
    source = `Pool price, recent buys · ${age === null ? "unknown" : age < 60 ? "just now" : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`}`;
  }
  if (value === null || !Number.isFinite(cost) || cost <= 0 || tokens <= 0) return null;
  const diff = value - cost;
  const pct = (diff / cost) * 100;
  const digits = Math.abs(diff) >= 0.01 ? 4 : Math.abs(diff) >= 0.0001 ? 6 : 8;
  // plain ASCII "-": the pixel font draws the unicode minus off the baseline
  const sign = diff < 0 ? "-" : "+";
  const usdAbs = pnl?.ethUsd ? Math.abs(diff) * pnl.ethUsd : null;
  const usd = usdAbs === null ? null : `${sign}$${usdAbs < 0.01 ? "<0.01" : usdAbs.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const eth = `${sign}${Math.abs(diff).toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")} ETH`;
  return { diff, pct, sign, eth, usd, source };
}

export const PNL_TITLE = "Selling the whole bag now (curve quote after the 1.25% fee, or recent pool price after graduation) minus what it cost. Gas excluded. Testnet estimate.";

export default function PositionPnl({ entry, pnl }: { entry: WireEntry; pnl: TicketPnl | null | undefined }) {
  const f = pnlFigures(entry, pnl);
  if (!f) {
    return <div className={styles.pnl}><span>TESTNET EST. PNL</span><strong>—</strong><small>Waiting for a sell quote</small></div>;
  }
  return (
    <div className={`${styles.pnl} ${f.diff < 0 ? styles.negative : styles.positive}`} title={PNL_TITLE}>
      <span>TESTNET EST. PNL</span>
      <strong>{f.eth}{f.usd ? ` (${f.usd})` : ""}</strong>
      <small><span className={styles.chg}>{f.sign}{Math.abs(f.pct).toFixed(1)}%</span> · illustrative</small>
      <small>{f.source}</small>
    </div>
  );
}
