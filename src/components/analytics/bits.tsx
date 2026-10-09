"use client";
// Small shared pieces of the analytics cards.
// A card is a block on the page background (no box): h3 title + one meta line (what · source · age) on the
// same row, then the hero number, then the detail. No header strip, no footer strip (spec 1.4).
import type { ReactNode } from "react";
import { EXPLORER } from "@/lib/config";
import { ageShort, useNow, type AnalyticsState } from "./useTokenAnalytics";
import { CardHead } from "@/components/ui/CardHead";
import type { GlossaryId } from "@/lib/glossary";
import ProfileLink from "../ProfileLink";
import s from "./analytics.module.css";

/** Moved to @/lib/format so the /dev and /w tables share it; re-exported for the analytics cards. */
export { pct } from "@/lib/format";

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;

/** where a card's numbers come from (the analytics section envelope) */
export type CardSrc = { source: string; detail?: string; computedAt: number; reason?: string | null };

/** "chain · 4s ago" in the card head; stale data says so (the only amber on the page) */
export function SrcMeta({ src, stale = false }: { src: CardSrc; stale?: boolean }) {
  const now = useNow(10_000);
  const age = now === null ? null : ageShort(Math.max(0, now - src.computedAt));
  const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(src.computedAt);
  return (
    <span className={s.src} title={`${src.detail ?? src.source} · read ${clock} UTC`}>
      {src.source}
      {age !== null && (stale ? <b className={s.staleTag}> · stale {age}</b> : ` · ${age} ago`)}
    </span>
  );
}

/** `loading`: the first answer isn't here yet; the card keeps roughly its loaded height (no layout jump).
 *  `src`: the source and age, shown in the head meta after `sub`. */
export function Card({ id, title, term, sub, src, stale = false, loading = false, children }: {
  id: string; title: string; term?: GlossaryId; sub?: ReactNode; src?: CardSrc | null; stale?: boolean; loading?: boolean; children: ReactNode;
}) {
  const meta = sub || src ? (
    <>
      {sub}
      {sub && src ? <span className={s.dot} aria-hidden> · </span> : null}
      {src ? <SrcMeta src={src} stale={stale} /> : null}
    </>
  ) : undefined;
  return (
    <section id={id} className={s.card} aria-labelledby={`${id}-t`} data-loading={loading || undefined} aria-busy={loading || undefined}>
      {/* a glossary heading gets a small (i), never an underline: a heading must not read as a link */}
      <CardHead id={`${id}-t`} title={title} term={term} meta={meta} className={s.head} />
      {children}
    </section>
  );
}

/** The card body while there is no data: loading, trouble, or the section's own reason. */
export function Pending({ state, reason, reading = "Reading the first 100 buys…" }: { state: AnalyticsState; reason?: string | null; reading?: string }) {
  if (state.trouble === "loading") {
    // the shape of a loaded card (hero number, a line, a stat grid), pulsing: the card keeps its height
    return (
      <div className={s.skel} role="status" aria-label={reading}>
        <i className={s.skBig} /><i className={s.skLine} />
        <div className={s.skGrid}><i /><i /><i /></div>
        <i className={s.skLine} /><i className={s.skLine} />
      </div>
    );
  }
  const text = state.trouble === "rate" || state.trouble === "down"
    ? "Retrying… Unknown, not zero."
    : reason || "Unknown right now. Unknown, not zero.";
  return <p className={s.msg} role="status">{text}</p>;
}

/** A partial-read note under a card (the source and age now sit in the head). Nothing when there is no reason. */
export function Source({ reason }: { source?: string; detail?: string; at?: number; reason?: string | null; stale?: boolean }) {
  return reason ? <p className={s.footReason}>{reason}</p> : null;
}

/** An address: opens the wallet's ticket on this page (or the explorer), plus the wallet-profile icon. */
export function Addr({ wallet, onSelect, children }: { wallet: string; onSelect?: (w: string) => void; children: ReactNode }) {
  return (
    <span className={s.addrWrap}>
      {onSelect ? (
        <button type="button" className={s.addr} onClick={() => onSelect(wallet)} aria-label={`Open the ticket of ${wallet}`}>{children}</button>
      ) : (
        <a className={s.addr} href={addrUrl(wallet)} target="_blank" rel="noreferrer">{children}</a>
      )}
      <ProfileLink addr={wallet} />
    </span>
  );
}

/** One restrained chip (spec 1.6): a 6 px square + plain text. tone: bad = red, warn = light, ok = green, plain = grey. */
export function Tag({ tone = "plain", title, children }: { tone?: "bad" | "warn" | "ok" | "plain"; title?: string; children: ReactNode }) {
  return <span className={`${s.tag} ${s[`t_${tone}`]}`} title={title}>{children}</span>;
}
