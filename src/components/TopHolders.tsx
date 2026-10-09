"use client";
// Top holders: the top 30 wallets of a line, who first funded each one with ETH, and which of them bought together.
// The ONE wallet list of the Holders section (Supply keeps only the totals): rank 1 = the first holder outside the
// curve / pool / protocol, shares with one decimal (lib/format pct), and the Supply read's per-wallet flags
// (fresh, gifted, ≤2 tx, sniper, farm) as tags. Open to everyone. Signals, not verdicts: a shared funder or a same-second buy is a reason to look closer, never proof.
// Holders and funders come from /api/holders (filled in over a few calls); bundles from the page's own trades.
// The PC is the server: nothing is asked until the block comes near the viewport (explorer budget).
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { pct as pctOf, shortAddr } from "@/lib/format";
import ProfileLink from "./ProfileLink";
import type { QueueResponse } from "@/lib/types";
import type { HolderFlag } from "@/lib/analytics/types";
import { FLAG } from "./analytics/walletTags";
import an from "./analytics/analytics.module.css";
import { CardHead } from "./ui/CardHead";
import styles from "./TopHolders.module.css";

type Funding = { kind: "source"; from: string; block: number } | { kind: "faucet" } | { kind: "bridge" } | { kind: "none" };
type Row = { rank: number; address: string; shareBps: number; status: "ok" | "pending" | "error"; funding: Funding | null; cluster: number | null };
type Cluster = { id: number; wallets: number; shareBps: number; source: string };
type Holders = { token: string; rows: Row[]; clusters: Cluster[]; clusteredBps: number; pending: number; protocolSkipped: number };

const TRADES_SENT = 300; // the queue API sends the newest 300 trades: at that count the history is cut
const SHOWN = 10;
const EXPLORER = "https://explorer.testnet.chain.robinhood.com/address/";

const letter = (id: number) => (id < 26 ? String.fromCharCode(65 + id) : String(id + 1));
/** one precision on the page: the same pct() as Supply and the summary ("1.6%", "12%") */
const pct = (bps: number) => pctOf(bps / 100);
/** Supply flags shown here (Dev and One funder have their own marks in this list) */
const ROW_FLAGS: HolderFlag[] = ["sniper", "farm", "fresh", "gifted", "lownonce"];

type Props = {
  token: string;
  data: QueueResponse | null;
  /** kept for the callers; nothing is gated on it */
  me?: string | null;
  creator: string | null;
  /** the wallet whose ticket is open on this page */
  selected?: string | null;
  /** open this wallet's ticket on the page (and jump the corridor to it when it's in the loaded line) */
  onSelect?: (wallet: string) => void;
  /** per-wallet flags from the Supply read (top 10), keyed by lower-case address */
  flags?: ReadonlyMap<string, HolderFlag[]> | null;
};

export default function TopHolders({ token, data, creator, selected = null, onSelect, flags = null }: Props) {
  const [res, setRes] = useState<Holders | null>(null);
  const [trouble, setTrouble] = useState<"retry" | null>(null);
  const [all, setAll] = useState(false);
  const box = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);

  // lazy: start reading once the block is within ~one screen of the viewport
  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") {
      const t = setTimeout(() => setNear(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  // while funders are still being looked up the server fills ~10 per call: ask again soon, then every 5 min
  useEffect(() => {
    if (!near) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fills = 0;
    let first = true;
    const load = () => {
      // hidden browser tab: no request, look again in a few seconds (the first read always goes)
      if (!first && document.visibilityState !== "visible") {
        timer = setTimeout(load, 5_000);
        return;
      }
      first = false;
      fetch(`/api/holders/${token}`)
        .then(async (r) => {
          if (!alive) return;
          if (!r.ok) {
            // 429 (rate limit) and 503 (explorer busy) alike: unknown for now, ask again later
            setTrouble("retry");
            timer = setTimeout(load, 30_000);
            return;
          }
          const j = (await r.json()) as Holders;
          if (!alive) return;
          setRes(j);
          setTrouble(null);
          const again = j.pending > 0 && fills++ < 12;
          timer = setTimeout(load, again ? 6_000 : 300_000);
        })
        .catch(() => {
          if (!alive) return;
          setTrouble("retry");
          timer = setTimeout(load, 30_000);
        });
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [near, token]);

  const holders = res && res.token === token ? res : null;
  const dev = creator?.toLowerCase() ?? null;

  // bundle: 3+ of these wallets first bought in the same second, or (whole history loaded) in the launch minute
  const bundles = useMemo(() => {
    const out = new Map<string, "second" | "minute">();
    if (!holders || !data || data.token.toLowerCase() !== token || data.unavailable) return { out, whole: false, seen: 0, known: false };
    const trades = data.trades ?? [];
    const whole = trades.length < TRADES_SENT;
    const first = new Map<string, number>();
    for (const t of trades) {
      if (t.side !== "buy") continue;
      const w = t.wallet.toLowerCase();
      const prev = first.get(w);
      if (prev === undefined || t.ts < prev) first.set(w, t.ts);
    }
    const top = holders.rows.filter((r) => first.has(r.address));
    const bySecond = new Map<number, string[]>();
    for (const r of top) {
      const ts = first.get(r.address)!;
      bySecond.set(ts, [...(bySecond.get(ts) ?? []), r.address]);
    }
    for (const group of bySecond.values()) if (group.length >= 3) for (const a of group) out.set(a, "second");
    if (whole && trades[0]) {
      const launch = trades[0].ts;
      const early = top.filter((r) => first.get(r.address)! - launch <= 60);
      if (early.length >= 3) for (const r of early) if (!out.has(r.address)) out.set(r.address, "minute");
    }
    return { out, whole, seen: top.length, known: true };
  }, [holders, data, token]);

  const rows = holders ? (all ? holders.rows : holders.rows.slice(0, SHOWN)) : [];
  const clusterCount = holders?.clusters.length ?? 0;
  const bundled = bundles.out.size;
  const maxBps = holders?.rows[0]?.shareBps || 1;
  const meta = trouble && !holders ? "Retrying…" : holders ? `top ${holders.rows.length} · % of total supply · explorer${holders.pending > 0 ? ` · ${holders.pending} checking` : ""}` : "top 30 · explorer";

  return (
    <section ref={box} id="an-top" className={`${an.card} ${styles.panel}`} aria-labelledby="holders-title" data-loading={!holders && !trouble ? true : undefined}>
      <CardHead id="holders-title" title="Top holders" term="one-funder" meta={meta} className={an.head} />
      {!holders ? (
        trouble ? (
          <p className={an.msg} role="status">Retrying… Holders unknown for now, not zero.</p>
        ) : (
          <div className={an.skel} role="status" aria-label="Reading holders">
            <i className={an.skBig} /><i className={an.skLine} /><i className={an.skLine} /><i className={an.skLine} /><i className={an.skLine} />
          </div>
        )
      ) : holders.rows.length === 0 ? (
        <p className={an.msg}>No holders outside the curve and pool yet.</p>
      ) : (
        <>
          <div className={an.hero}>
            {clusterCount > 0 ? (
              <p className={an.big}><b>{pct(holders.clusteredBps)}</b><span>of supply held by {clusterCount} one-funder group{clusterCount === 1 ? "" : "s"}</span></p>
            ) : (
              <p className={an.noneLine}>
                {holders.pending < holders.rows.length ? "No shared funding source among the wallets checked." : "Checking who funded these wallets…"}
              </p>
            )}
            {(holders.pending > 0 || bundled > 0) && (
              <p className={an.line2} role="status">
                {holders.pending > 0 && <>{holders.pending} still being checked</>}
                {holders.pending > 0 && bundled > 0 && " · "}
                {bundled > 0 && <><b>{bundled}</b> bought together</>}
              </p>
            )}
          </div>
          <ol className={an.list} aria-label={`Top ${holders.rows.length} holders`}>
            {rows.map((r, i) => {
              const c = r.cluster !== null ? holders.clusters[r.cluster] : null;
              const b = bundles.out.get(r.address);
              const picked = !!selected && selected.toLowerCase() === r.address.toLowerCase();
              return (
                <li
                  key={r.address}
                  className={`${an.row} ${styles.row} ${onSelect ? styles.pickable : ""} ${picked ? styles.picked : ""}`}
                  // the whole row opens the ticket for a mouse; the address button is the keyboard target
                  onClick={onSelect ? (e) => { if (!(e.target as HTMLElement).closest("a, button")) onSelect(r.address); } : undefined}
                >
                  <span className={an.rank}>{i + 1}</span>
                  <span className={an.who}>
                    <span className={styles.addrCell}>
                      {onSelect ? (
                        <button type="button" className={styles.addr} onClick={() => onSelect(r.address)} aria-pressed={picked} aria-label={`Open ticket for ${r.address}`} title="Open ticket">
                          {shortAddr(r.address)}
                        </button>
                      ) : (
                        <a className={styles.addr} href={`${EXPLORER}${r.address}`} target="_blank" rel="noreferrer" title={`${r.address} on the explorer`}>
                          {shortAddr(r.address)}
                        </a>
                      )}
                      {onSelect && (
                        <a className={styles.ext} href={`${EXPLORER}${r.address}`} target="_blank" rel="noreferrer" aria-label={`${r.address} on the explorer (opens in a new tab)`} title="On the explorer">
                          <span aria-hidden>↗</span>
                        </a>
                      )}
                      <ProfileLink addr={r.address} />
                    </span>
                    {dev && r.address === dev && <Link className={styles.devLink} href={`/dev/${dev}`} prefetch={false} title="Open the dev passport">Dev →</Link>}
                    {c && (
                      <span
                        className={`${an.tag} ${an.t_bad}`}
                        title={`One funder ${letter(c.id)}: ${c.wallets} wallets first funded from ${shortAddr(c.source)}, ${pct(c.shareBps)} of supply`}
                      >
                        One funder {letter(c.id)}
                      </span>
                    )}
                    {(flags?.get(r.address) ?? []).filter((fl) => ROW_FLAGS.includes(fl)).map((fl) => (
                      <span key={fl} className={`${an.tag} ${an[`t_${FLAG[fl].tone}`]}`} title={FLAG[fl].hint}>{FLAG[fl].text}</span>
                    ))}
                    {b && (
                      <span className={`${an.tag} ${an.t_warn}`} title={b === "second" ? "First buy in the same second as 2+ other top holders" : "First buy in the launch minute, with 2+ other top holders"}>
                        Bundle
                      </span>
                    )}
                    {r.status === "pending" && <span className={styles.wait} title="Funding source not checked yet">checking…</span>}
                    {r.status === "error" && <span className={styles.wait} title="The explorer didn't answer: funding source unknown for now">—</span>}
                  </span>
                  <span className={an.right}>
                    <span className={an.meter} aria-hidden><i style={{ width: `${Math.min(100, (r.shareBps / maxBps) * 100)}%` }} /></span>
                    {pct(r.shareBps)}
                  </span>
                </li>
              );
            })}
          </ol>
          {holders.rows.length > SHOWN && (
            <button type="button" className={an.more} onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? `Show top ${SHOWN}` : `Show all ${holders.rows.length}`}
            </button>
          )}
          <p className={an.note}>
            One funder = first ETH from one source. Bundle = 3+ first buys in the same second{bundles.whole ? " or launch minute" : ""}.
            {bundles.known && !bundles.whole ? " Buys: last 300 trades." : ""} Share of total supply.
          </p>
        </>
      )}
    </section>
  );
}
