"use client";
// "Launches created" on the wallet profile (the former dev passport): the track record in 2-4 numbers, the fact
// tags, then every launch with its outcome. One read of /api/dev/<addr>/passport, asked only for a wallet that
// launched something (or when the visitor came for #launches). A number that isn't known is left out, never 0.
import { useEffect, useRef, useState } from "react";
import type { DevPassport } from "@/lib/devrep";
import { useDevPassport } from "@/components/token/useDevPassport";
import { fmtAge, fmtInt, pct as pctOf } from "@/lib/format";
import LaunchTable, { type Row } from "./LaunchTable";
import { TagTip } from "../ui";
import { eth } from "./fmt";
import Loader from "@/components/ui/Loader";
import s from "./profile.module.css";

const wei = (v: string | null) => (v === null ? null : Number(BigInt(v)) / 1e18);
const hhmm = (ms: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(ms);
/** 42s, 7 min, 3.4 h, 2.1 d */
function fmtDuration(sec: number) {
  if (sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(sec < 36_000 ? 1 : 0)} h`;
  return `${(sec / 86_400).toFixed(1)} d`;
}

/** one launch count: the chain's when it is above vibe's list (vibe leaves old factories out) */
function counts(p: DevPassport) {
  const launches = p.onChain ? p.onChain.launches : p.total; // null = more than loaded, no total given
  const graduated = p.onChain ? Math.max(p.onChain.grads, p.graduated) : p.graduated;
  // the rate needs a known base: the chain's count, or vibe's full list; otherwise it is "of the loaded ones"
  const base = p.onChain ? p.onChain.launches : p.total !== null && p.total <= p.loaded ? p.loaded : null;
  return { graduated, base, label: launches === null ? `${p.loaded}+` : fmtInt(launches) };
}

function rowsOf(p: DevPassport): Row[] {
  return p.launches.map((l) => ({
    token: l.token,
    symbol: l.symbol,
    name: l.name,
    createdAt: l.createdAt,
    progressBps: l.progressBps,
    graduated: l.graduated,
    graduatedAt: l.graduatedAt,
    hidden: l.hidden,
    holders: l.holders,
    feesEth: wei(l.feesWei),
    dev: l.dev
      ? {
          received: Number(BigInt(l.dev.receivedWei) / 10n ** 15n) / 1000,
          moved: Number(BigInt(l.dev.movedWei) / 10n ** 15n) / 1000,
          sells: l.dev.sells,
          soldBps: l.dev.soldBps,
          firstSellAfter: l.dev.firstSellAt !== null && l.createdAt > 0 ? Math.max(0, l.dev.firstSellAt - l.createdAt) : null,
          soldBeforeGrad: l.graduatedAt !== null && l.dev.firstSellAt !== null ? l.dev.firstSellAt < l.graduatedAt : null,
        }
      : null,
  }));
}

type Kpi = { k: string; v: React.ReactNode; note?: string };

/** `meta`: the counts in the heading, only for a wallet whose launches can't be listed (no numbers row below) */
function Section({ meta, children }: { meta?: React.ReactNode; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // the block arrives after the page: a visitor sent to #launches is taken to it once
  useEffect(() => {
    if (window.location.hash === "#launches") ref.current?.scrollIntoView({ block: "start" });
  }, []);
  return (
    <section ref={ref} id="launches" className={s.card} aria-labelledby="launches-h">
      <div className={s.cardHead}>
        <h2 id="launches-h">Launches created{meta ? <span className={s.meta}> · {meta}</span> : null}</h2>
      </div>
      {children}
    </section>
  );
}

export default function DevLaunches({ addr }: { addr: string }) {
  const { p, loading } = useDevPassport(addr);
  const [now] = useState(() => Math.floor(Date.now() / 1000)); // ages are "as of when the block opened"
  if (loading) return <Section><div className={s.skBlock} aria-busy="true"><Loader caption="Reading the launches…" /></div></Section>;
  if (!p) return <Section><p className={s.msg}>Unknown right now: vibe/vibe didn&apos;t answer. Reload in a minute.</p></Section>;

  if (p.loaded === 0) {
    const c = p.onChain;
    return (
      <Section meta={c ? `${fmtInt(c.launches)} · ${fmtInt(c.grads)} graduated` : undefined}>
        <p className={s.msg}>
          {c
            ? "vibe/vibe doesn't list this wallet's factory, so its launches can't be listed here. Dev sells and fees are unknown for them."
            : p.coverage === "v1-only"
              ? "No curve launches. Taxed v6 launches couldn't be read right now. Reload in a minute."
              : "No launches by this wallet on vibe/vibe."}
        </p>
      </Section>
    );
  }

  const sum = p.summary;
  const canon = counts(p);
  const cut = p.total === null || p.total > p.loaded;
  const chainUnknown = p.chain !== "ok";
  // dev bags are read for curve launches only: a v6-only dev has no dev-bag numbers (unknown, not 0)
  const devUnknown = chainUnknown || sum.devHeld === null;
  const taxedN = p.launches.filter((l) => l.taxed).length;
  const fees = wei(p.fees.totalWei);
  const rows = rowsOf(p);
  const devCols = !chainUnknown && rows.some((r) => r.dev !== null);
  const gradPct = (canon.base ?? p.loaded) ? (canon.graduated / (canon.base ?? p.loaded)) * 100 : null;
  const facts = p.facts.filter((f) => f.id !== "grad");

  const kpis: Kpi[] = [
    { k: "Launches", v: canon.label, note: p.onChain ? `on chain · vibe lists ${p.total === null ? `${p.loaded}+` : fmtInt(p.total)}` : cut ? `newest ${p.loaded} read` : undefined },
    { k: "Graduated", v: <>{canon.graduated}{gradPct !== null && <small>{pctOf(gradPct)}</small>}</>, note: canon.base === null ? `of the newest ${p.loaded}` : undefined },
  ];
  if (!devUnknown && sum.devHeld) kpis.push({ k: "Dev sold in", v: <>{sum.soldIn}<small>/ {sum.devHeld}</small></>, note: "launches with a dev bag" });
  else if (!devUnknown && sum.devHeld === 0) kpis.push({ k: "Dev bag", v: "none", note: "never held own token" });
  if (!devUnknown && sum.medianFirstSell !== null) kpis.push({ k: "Median 1st sell", v: fmtDuration(sum.medianFirstSell), note: "after launch" });
  const times = p.launches.map((l) => l.createdAt).filter((t) => t > 0);
  if (kpis.length < 4 && times.length && !cut && !p.onChain) kpis.push({ k: "First launch", v: `${fmtAge(now - Math.min(...times))} ago` });
  if (fees !== null && fees > 0) kpis.push({ k: "Creator fees", v: <>{p.fees.status === "partial" ? "≥" : ""}{eth(fees)}<small>ETH</small></> });
  const shown = kpis.slice(0, 4);

  return (
    <Section>
      {p.stale && <p className={s.note} role="status">Last good read {hhmm(p.updatedAt)} UTC: vibe/vibe isn&apos;t answering right now.</p>}
      <dl className={`${s.kpis} ${s.kpisFlat}`} style={{ "--n": shown.length } as React.CSSProperties}>
        {shown.map((x) => (
          <div key={x.k} className={s.kpi}>
            <dt>{x.k}</dt>
            <dd>{x.v}</dd>
            <span className={s.kpiNote}>{x.note}</span>
          </div>
        ))}
      </dl>
      {facts.length > 0 && (
        <ul className={`${s.tags} ${s.factTags}`} aria-label="Facts">
          {facts.map((f) => (
            <li key={f.id}>
              <TagTip tip={{ term: f.label, short: f.detail }}>
                <span className={`${s.tag} ${s[`t_${f.tone}`]}`}>{f.label}</span>
              </TagTip>
            </li>
          ))}
        </ul>
      )}
      <LaunchTable rows={rows} now={now} chainKnown={!chainUnknown} />
      {(chainUnknown || taxedN > 0 || p.coverage === "v1-only") && (
        <p className={s.note}>
          {chainUnknown ? "Dev bags couldn't be read from the chain this time." : taxedN ? (devCols ? "Dev columns cover curve launches only." : "Dev bags aren't read for taxed v6 launches yet.") : ""}
          {p.coverage === "v1-only" ? " Taxed v6 launches aren't listed: vibe/vibe's v6 list didn't answer." : ""}
        </p>
      )}
    </Section>
  );
}
