"use client";
// Header of a line: avatar, ticker, "name · age", contract chip, then the page's buttons (passed in).
// token = null is the $EXIT line on /exit: its subtitle says what the site is, with the thresholds.
import Link from "next/link";
import { useState, type ReactNode } from "react";
import PixelIcon from "./PixelIcon";
import { Portrait } from "./Sprite";
import TokenAvatar from "./TokenAvatar";
import HowStrip from "./HowStrip";
import DevBadge from "./DevBadge";
import type { LineInfo, TokenAbout } from "@/lib/lineContext";
import { shortAddr } from "@/lib/format";
import styles from "./TokenHead.module.css";

type Props = {
  token: string | null;
  info: LineInfo | null;
  age?: string | null;
  loading?: boolean; // the queue hasn't answered yet: show a placeholder, never "$TOKEN"
  actions?: ReactNode;
  /** one live-data status plate shown beside the title (e.g. "Reconnecting…") */
  status?: ReactNode;
  /** the token's own description and links (vibe/vibe); nothing is drawn when absent */
  about?: TokenAbout | null;
  /** the token's creator (vibe/vibe or the chain); null = unknown, then no dev badge */
  creator?: string | null;
};

export default function TokenHead({ token, info, age = null, loading = false, actions, status = null, about = null, creator = null }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!token) return;
    navigator.clipboard?.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }, () => {});
  };

  if (!token) {
    return (
      <header className={styles.head}>
        <div className={styles.id}>
          <span className={`${styles.avatar} ${styles.exitAvatar}`} aria-hidden><Portrait skin="suit" size={44} scale={2} /></span>
          <div className={styles.names}>
            <div className={styles.titleRow}>
              <h1 className={styles.sym} title="Every ponzi needs exit liquidity.">$EXIT</h1>
              {status}
            </div>
            <p className={styles.lede}>
              Every $EXIT holder, in buy order. Buy <b>0.0003 ETH</b> or more to take a place, and every buyer
              behind you adds a point. Sell, and your points pass down the line.
            </p>
            <div className={styles.guide}><HowStrip variant="link" /></div>
          </div>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
    );
  }

  const symbol = info?.symbol || null;
  const meta = [info?.name, age].filter(Boolean).join(" · ");
  // the token's own words, unless they only repeat the ticker or the name (a lone "WIND" read as debug output)
  const rawDesc = about?.description?.trim() || null;
  const same = (x: string | null | undefined) => !!x && rawDesc !== null && rawDesc.replace(/^\$/, "").toLowerCase() === x.trim().toLowerCase();
  const description = rawDesc && !same(info?.symbol) && !same(info?.name) ? rawDesc : null;
  const links = about?.links ?? [];
  return (
    <>
      <nav className={styles.crumb} aria-label="Breadcrumb">
        <Link href="/">Tokens</Link>
        <span aria-hidden>/</span>
        <span aria-current="page">{symbol ? `$${symbol}` : shortAddr(token)}</span>
      </nav>
      <header className={styles.head}>
        <div className={styles.id}>
          <span className={styles.avatarSlot}>
            <TokenAvatar src={info?.image ?? null} symbol={symbol ?? ""} size={48} priority />
          </span>
          <div className={styles.names}>
            <div className={styles.titleRow}>
              {symbol ? (
                <h1 className={styles.sym}>${symbol}</h1>
              ) : loading ? (
                <h1 className={styles.sym}><span className={styles.skel} aria-label="Loading token" /></h1>
              ) : (
                <h1 className={`${styles.sym} ${styles.addrTitle}`}>{shortAddr(token)}</h1>
              )}
              {status}
            </div>
            <div className={styles.sub}>
              {meta ? <span className={styles.meta}>{meta}</span> : loading ? <span className={`${styles.skel} ${styles.skelSm}`} aria-hidden /> : null}
              <button type="button" className={styles.chip} onClick={copy} title="Copy contract address" aria-label={copied ? "Contract address copied" : `Copy contract address ${token}`}>
                <span>{shortAddr(token)}</span>
                <PixelIcon name={copied ? "check" : "copy"} size={12} />
              </button>
              {links.map((l) => (
                <a key={l.href} className={styles.link} href={l.href} target="_blank" rel="noreferrer nofollow ugc" title={`${l.label}: the token's own link (opens a new tab)`}>{l.label} ↗</a>
              ))}
              <DevBadge token={token.toLowerCase()} creator={creator} />
            </div>
            {description && <p className={styles.desc} title={description}>{description}</p>}
          </div>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </header>
    </>
  );
}
