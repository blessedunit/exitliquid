"use client";
// Wallet profile (redesign 15.10): identity header (address + short tags) → 3-4 key numbers →
// blocks: Open positions · Activity + Funding · Early entries · Launches created (DevLaunches) · Farm.
// A block (or a number) with no data is left out; an unknown value inside a shown block reads "—", never 0.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import type { ChainCost, EntriesResponse, Entry, Position, Tag, WalletProfile, Sibling } from "@/lib/walletProfile";
import { fmtAge, fmtCompact, fmtInt, pct as pctOf, shortAddr } from "@/lib/format";
import WalletAddress from "@/components/WalletAddress";
import ShareCard from "@/components/ShareCard";
import WalletLookup from "../WalletLookup";
import ShowMore from "@/components/ui/ShowMore";
import { TagTip } from "../ui";
import DevLaunches from "./DevLaunches";
import { eth } from "./fmt";
import Loader, { shimmer } from "@/components/ui/Loader";
import s from "./profile.module.css";

const ENTRY_POLL_MS = 1_500;
const ENTRY_POLLS = 8;
const ROWS = 10;
const UNK = "Unknown, not zero.";

/* ---------------- formatting ---------------- */

function signedEth(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return `${v > 0 ? "+" : "−"}${eth(Math.abs(v))}`;
}
const tone = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? s.dim : v > 0 ? s.up : v < 0 ? s.down : "");
const pct = (x: number | null) => (x === null ? "—" : pctOf(x * 100));
const dur = (sec: number | null | undefined) => (sec === null || sec === undefined ? "—" : fmtAge(sec));
function date(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(ts * 1000);
}
function ago(ts: number | null | undefined): string {
  if (!ts) return "—";
  return `${fmtAge(Date.now() / 1000 - ts)} ago`;
}
/** one plain reason: never an HTTP code ("vibe API error (503)" reads as a site defect) */
function plain(reason: string | null | undefined, fallback = "vibe/vibe didn't answer"): string {
  if (!reason) return fallback;
  return /\(\d{3}\)|api \d{3}|non-JSON|backing off|did not answer/i.test(reason) ? fallback : reason;
}
// nonce = exact sent txs; the explorer counter is approximate (it lags), so it is marked "≈"
function txLabel(sent: number | null | undefined, counter: number | null): string | null {
  if (sent != null) return `${fmtCompact(sent)} sent tx${sent === 1 ? "" : "s"}`;
  return counter !== null ? `≈${fmtCompact(counter)} txs` : null;
}

function labelChip(l: string) {
  if (l === "sniper") return <span key={l} className={`${s.mini} ${s.risk}`}>Sniper</span>;
  if (l.startsWith("farm:")) return <span key={l} className={`${s.mini} ${s.warn}`}>Farm #{l.slice(5)}</span>;
  if (l === "verified") return <span key={l} className={`${s.mini} ${s.good}`}>Verified</span>;
  if (l === "faucet") return <span key={l} className={s.mini}>Faucet</span>;
  if (l === "plumbing") return <span key={l} className={s.mini}>Protocol</span>;
  return null;
}

function WalletLink({ a, dev = false }: { a: string; dev?: boolean }) {
  // creators open on their launches; everyone else at the top of the profile
  return <Link className={s.addr} href={dev ? `/w/${a}#launches` : `/w/${a}`} title={dev ? `${a} · launches created` : a}>{shortAddr(a)}</Link>;
}

function Card({ id, title, aside, children }: { id: string; title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className={s.card} aria-labelledby={`${id}-h`}>
      <div className={s.cardHead}>
        <h2 id={`${id}-h`}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** one label → value row; nothing rendered for a value that isn't there */
function Row({ k, children, title, txt = false }: { k: React.ReactNode; children: React.ReactNode; title?: string; txt?: boolean }) {
  return <div><dt>{k}</dt><dd className={txt ? s.txt : "num"} title={title}>{children}</dd></div>;
}

/* ---------------- data ---------------- */

type Load<T> = { data: T | null; error: string | null; loading: boolean };

function useProfile(addr: string, nonce: number): Load<WalletProfile> {
  const [st, setSt] = useState<Load<WalletProfile> & { key: string }>({ data: null, error: null, loading: true, key: "" });
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    setSt((p) => (p.key === addr ? { ...p, loading: true } : p));
    (async () => {
      try {
        const r = await fetch(`/api/wprofile/${addr}`, { signal: ctl.signal, cache: "no-store" });
        if (r.status === 429) throw new Error("Too many lookups. Try again in a minute.");
        if (!r.ok) throw new Error("This wallet can't be read right now.");
        const j = (await r.json()) as WalletProfile;
        if (live) setSt({ data: j, error: null, loading: false, key: addr });
      } catch (e) {
        if (live && !ctl.signal.aborted) setSt((p) => ({ data: p.key === addr ? p.data : null, error: (e as Error).message, loading: false, key: addr }));
      }
    })();
    return () => {
      live = false;
      ctl.abort();
    };
  }, [addr, nonce]);
  return st.key === addr || st.key === "" ? st : { data: null, error: null, loading: true };
}

function useEntries(addr: string, nonce: number): Load<EntriesResponse> {
  const [st, setSt] = useState<Load<EntriesResponse> & { key: string }>({ data: null, error: null, loading: true, key: "" });
  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    let t: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/wprofile/${addr}/entries`, { signal: ctl.signal, cache: "no-store" });
        if (r.status === 429) throw new Error("Too many lookups. Try again in a minute.");
        if (!r.ok) throw new Error("Entries can't be read right now.");
        const j = (await r.json()) as EntriesResponse;
        if (!live) return;
        setSt({ data: j, error: null, loading: false, key: addr });
        // the server ranks a batch per call: ask again until every launch is placed
        if (j.status === "ok" && j.pending > 0 && ++polls < ENTRY_POLLS) t = setTimeout(tick, ENTRY_POLL_MS);
      } catch (e) {
        if (live && !ctl.signal.aborted) setSt((p) => ({ data: p.key === addr ? p.data : null, error: (e as Error).message, loading: false, key: addr }));
      }
    };
    tick();
    return () => {
      live = false;
      ctl.abort();
      clearTimeout(t);
    };
  }, [addr, nonce]);
  return st.key === addr || st.key === "" ? st : { data: null, error: null, loading: true };
}

/* chain cost basis: vibe's positions came back without cost (indexer behind, or the chain fallback),
   so ask the token lines for what this wallet paid. Top 10 positions by value; a miss stays unknown. */
const COST_TOKENS = 10;
type CostState = { key: string; items: Record<string, ChainCost> | null; loading: boolean };
type PosView = Position & { chainCost?: boolean };

function useChainCost(addr: string, prof: WalletProfile | null): { rows: PosView[]; loading: boolean; used: number; asked: number } {
  const items = useMemo(() => prof?.positions.items ?? [], [prof]);
  const need = !!prof && prof.positions.status !== "unavailable" && items.length > 0 && items.every((p) => p.costEth === null);
  const tokens = need
    ? [...items].sort((a, b) => (b.valueEth ?? -1) - (a.valueEth ?? -1)).slice(0, COST_TOKENS).map((p) => p.token).join(",")
    : "";
  const key = tokens ? `${addr}:${tokens}` : "";
  const [st, setSt] = useState<CostState>({ key: "", items: null, loading: false });
  useEffect(() => {
    if (!key) return;
    let live = true;
    const ctl = new AbortController();
    // no "loading" write here: an answer for another key already reads as loading (st.key !== key below)
    fetch(`/api/wprofile/${addr}/cost?tokens=${tokens}`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ items: Record<string, ChainCost> }>) : null))
      .then((j) => { if (live) setSt({ key, items: j?.items ?? null, loading: false }); })
      .catch(() => { if (live && !ctl.signal.aborted) setSt({ key, items: null, loading: false }); });
    return () => {
      live = false;
      ctl.abort();
    };
  }, [key, addr, tokens]);
  const cc = st.key === key ? st.items : null;
  const rows = useMemo<PosView[]>(() => {
    if (!cc) return items;
    return items.map((p) => {
      const c = cc[p.token];
      if (!c || c.costEth === null || p.costEth !== null) return p;
      const value = p.valueEth;
      return { ...p, costEth: c.costEth, unrealizedEth: value === null ? null : value - c.costEth, multiple: value === null ? null : value / c.costEth, chainCost: true };
    });
  }, [items, cc]);
  return { rows, loading: !!key && (st.key !== key || st.loading), used: rows.filter((p) => p.chainCost).length, asked: tokens ? tokens.split(",").length : 0 };
}

/* ---------------- page ---------------- */

const onHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export default function WalletProfileView({ addr }: { addr: string }) {
  const [nonce, setNonce] = useState(0);
  const p = useProfile(addr, nonce);
  const e = useEntries(addr, nonce);
  const prof = p.data;
  const ent = e.data && e.data.status === "ok" ? e.data : null;
  const cost = useChainCost(addr, prof);
  // someone sent here for the launches (old /dev/<addr> links land on #launches): read them whatever the profile says
  const asked = useSyncExternalStore(onHash, () => window.location.hash === "#launches", () => false);
  const d = prof?.dev;
  const launched = asked || (ent?.ownLaunches ?? 0) > 0 || (!!d && (d.status !== "ok" || d.loaded > 0 || (d.total ?? 0) > 0 || (d.onChain ?? 0) > 0));

  // tags that only the on-chain entry check can see (vibe's API misses hidden launches)
  const tags = useMemo(() => {
    const out: Tag[] = [...(prof?.tags ?? [])];
    if (ent) {
      const has = (id: string) => out.some((t) => t.id === id);
      if (ent.funderLaunches && ent.funderLaunches > 0) {
        const i = out.findIndex((t) => t.id === "buys_funder");
        const tag: Tag = { id: "buys_funder", label: `Buys funder's launches · ${ent.funderLaunches}`, tone: "risk", detail: `${ent.funderLaunches} of the ${ent.checked + ent.ownLaunches} launches checked were created by the wallet that funded it (factory launch events). A dev buying their own launch through a second wallet looks like this.` };
        if (i >= 0) out[i] = tag;
        else out.push(tag);
        if (!has("funder_dev")) out.push({ id: "funder_dev", label: "Funded by a dev", tone: "warn", detail: "Its first ETH came from a wallet that creates launches." });
      }
      if (ent.ownLaunches > 0 && !has("dev")) out.push({ id: "dev", label: `Dev · ${ent.ownLaunches}+ on-chain`, tone: "dev", detail: `Created at least ${ent.ownLaunches} of the launches it bought (factory launch events). vibe's API may not list them.` });
      if (ent.checked >= 10 && ent.first20Rate !== null && ent.first20Rate >= 0.5 && !has("sniper")) out.push({ id: "early", label: "Early buyer", tone: "warn", detail: `Among the first 20 buyers in ${ent.first20} of ${ent.checked} launches checked.` });
    }
    if (prof?.index.stale) out.push({ id: "stale", label: "Early Index outdated", tone: "info", detail: "The sniper / farm index is too old: those labels are unknown here, not absent." });
    const rank: Record<string, number> = { risk: 0, warn: 1, dev: 2, good: 3, info: 4 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [prof, ent]);

  return (
    <>
      <div className={s.top}>
        <div className={s.crumbRow}>
          <nav className={s.crumb} aria-label="Breadcrumb">
            <Link href="/w">Wallets</Link>
            <span aria-hidden>/</span>
            <span aria-current="page"><WalletAddress wallet={addr} /></span>
          </nav>
          <div className={s.tools}>
            <button type="button" className={s.toolBtn} onClick={() => setNonce((n) => n + 1)} disabled={p.loading} title={prof ? `Read ${ago(Math.floor(prof.updatedAt / 1000))}` : undefined}>
              <span aria-hidden>↻</span>{p.loading && prof ? " Refreshing…" : " Refresh"}
            </button>
            <ShareCard kind="wallet" id={addr} className={s.toolBtn} />
            <WalletLookup inline />
          </div>
        </div>
        <h1 className={s.h1}>Wallet <span className={s.h1Addr}>{shortAddr(addr)}</span></h1>
        {prof && tags.length > 0 && (
          <ul className={s.tags} aria-label="Wallet tags">
            {tags.map((t) => (
              <li key={t.id}>
                <TagTip tip={{ term: t.label, short: t.detail }}>
                  <span className={`${s.tag} ${s[`t_${t.tone}`]}`}>{t.label}</span>
                </TagTip>
              </li>
            ))}
          </ul>
        )}
      </div>

      {p.loading && !prof ? (
        <ProfileSkeleton />
      ) : !prof ? (
        <div className={s.stack}>
          <div className={s.card} role="alert">
            <p className={s.msg}>
              {p.error ?? "This wallet can't be read right now."}{" "}
              <button type="button" className={s.toolBtn} onClick={() => setNonce((n) => n + 1)}>Try again</button>
            </p>
          </div>
          {launched && <DevLaunches addr={addr} />}
        </div>
      ) : (
        <>
          <Kpis prof={prof} ent={ent} cost={cost} />
          <div className={s.stack}>
            <Positions prof={prof} cost={cost} />
            <div className={s.grid2}>
              <Activity prof={prof} />
              <Funding prof={prof} ent={ent} />
            </div>
            <Entries load={e} />
            {launched && <DevLaunches addr={addr} />}
            {prof.index.farm && <FarmPeers farm={prof.index.farm} />}
          </div>
        </>
      )}
    </>
  );
}

/* ---------------- skeleton ---------------- */
// Sized like the loaded page so the data arriving doesn't push the page down (CLS).

function ProfileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading the wallet">
      <dl className={s.kpis} style={{ "--n": 4 } as React.CSSProperties}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={s.kpi}>
            <dt><i className={`${s.sk} ${shimmer}`} style={{ width: 80 }} /></dt>
            <dd><i className={`${s.sk} ${shimmer}`} style={{ width: "60%", height: 24, marginTop: 3 }} /></dd>
            <span className={s.kpiNote} />
          </div>
        ))}
      </dl>
      <div className={s.stack}>
        <section className={s.card}><div className={s.cardHead}><h2>Open positions</h2></div><div className={s.skBlock} style={{ height: 96 }}><Loader caption="Reading the wallet…" /></div></section>
        <div className={s.grid2}>
          <section className={s.card}><div className={s.cardHead}><h2>Activity</h2></div><div className={s.skBlock}><Loader size="mini" /></div></section>
          <section className={s.card}><div className={s.cardHead}><h2>Funding</h2></div><div className={s.skBlock}><Loader size="mini" /></div></section>
        </div>
      </div>
    </div>
  );
}

/* ---------------- key numbers ---------------- */

type CostInfo = ReturnType<typeof useChainCost>;

/** cost and unrealized summed over the rows that have both */
function knownTotals(rows: PosView[]): { cost: number; unreal: number; n: number } | null {
  const k = rows.filter((p) => p.costEth !== null && p.unrealizedEth !== null);
  return k.length ? { cost: k.reduce((a, p) => a + p.costEth!, 0), unreal: k.reduce((a, p) => a + p.unrealizedEth!, 0), n: k.length } : null;
}

type Kpi = { k: string; v: React.ReactNode; cls?: string; note?: React.ReactNode; title?: string };

function Kpis({ prof, ent, cost }: { prof: WalletProfile; ent: EntriesResponse | null; cost: CostInfo }) {
  const pos = prof.positions;
  const tot = pos.totals;
  const chainTot = cost.used ? knownTotals(cost.rows) : null;
  const tr = prof.trader;
  const a = prof.activity;

  const out: Kpi[] = [];
  out.push({ k: "ETH balance", v: eth(prof.eth.balance), cls: prof.eth.balance === null ? s.dim : undefined, note: txLabel(prof.explorer.sentTx, prof.explorer.txCount), title: prof.eth.balance === null ? UNK : undefined });
  if (pos.status !== "unavailable" && pos.items.length) {
    const unreal = tot?.unrealizedEth ?? chainTot?.unreal ?? null;
    const n = `${pos.items.length}${pos.capped ? "+" : ""}`;
    // no price: the count is the number we know, never a value of "—"
    out.push(tot?.valueEth != null ? {
      k: "Open positions",
      v: eth(tot.valueEth),
      note: unreal !== null ? <><span className={tone(unreal)}>{signedEth(unreal)}</span> unrealized</> : `${n} token${pos.items.length === 1 ? "" : "s"}`,
    } : { k: "Open positions", v: n, note: "value not priced yet" });
  }
  if (tr.status === "ok" && tr.pnlEth !== null) {
    out.push({ k: "Season PnL", v: signedEth(tr.pnlEth), cls: tone(tr.pnlEth), note: tr.rank !== null ? `rank #${fmtCompact(tr.rank)}${tr.of ? ` of ${fmtCompact(tr.of)}` : ""}` : undefined });
  }
  if (ent && ent.checked > 0) {
    out.push({ k: "First-20 entries", v: <>{ent.first20}<small>/ {ent.checked}</small></>, note: ent.pending ? `placing ${ent.pending} more…` : `${pct(ent.first20Rate)} of launches` });
  }
  // launches created and graduated: once, in the "Launches created" block's own numbers
  if (out.length < 4 && a.status !== "unavailable") {
    out.push({ k: "Launches bought", v: `${a.bought}${a.status === "partial" ? "+" : ""}`, note: a.bought ? `${a.holding} still held` : undefined });
  }
  const shown = out.slice(0, 4);
  return (
    <dl className={s.kpis} style={{ "--n": shown.length } as React.CSSProperties}>
      {shown.map((x) => (
        <div key={x.k} className={s.kpi}>
          <dt>{x.k}</dt>
          <dd className={x.cls} title={x.title}>{x.v}</dd>
          <span className={s.kpiNote}>{x.note}</span>
        </div>
      ))}
    </dl>
  );
}

/* ---------------- activity ---------------- */

function Activity({ prof }: { prof: WalletProfile }) {
  const a = prof.activity;
  const tr = prof.trader;
  if (a.status === "unavailable") {
    return <Card id="activity" title="Activity"><p className={s.msg}>Unknown right now: {plain(a.reason)}.</p></Card>;
  }
  const plus = a.status === "partial" ? "+" : "";
  return (
    <Card id="activity" title="Activity" aside={a.lastTs ? <span className={s.meta}>last trade {ago(a.lastTs)}</span> : undefined}>
      <dl className={s.kv}>
        <Row k="Launches bought">{a.bought}{plus}</Row>
        <Row k="Buys / sells">{a.buys} / {a.sells}</Row>
        <Row k="Still holding">{a.holding}<small>of {a.bought}{plus}</small></Row>
        <Row k="Walked out">{a.exited}{a.exited && a.exitedWithinHour ? <small>{a.exitedWithinHour} within 1 h</small> : null}</Row>
        {a.exited > 0 && a.medianHoldSec !== null && <Row k="Median hold">{dur(a.medianHoldSec)}</Row>}
        {(a.giftsIn > 0 || a.giftsOut > 0) && <Row k="Transfers in / out" title="Token transfers outside the market">{fmtInt(a.giftsIn)} / {fmtInt(a.giftsOut)}</Row>}
        {tr.status === "ok" && (tr.buys !== null || tr.sells !== null) && <Row k="Season trades">{tr.buys ?? "—"} / {tr.sells ?? "—"}</Row>}
        {a.activeDays !== null && <Row k="Active">{Math.max(1, Math.round(a.activeDays))} day{Math.max(1, Math.round(a.activeDays)) === 1 ? "" : "s"}<small>since {date(a.firstTs)}</small></Row>}
      </dl>
      {a.reason && <p className={s.note}>Partial: {plain(a.reason)}.</p>}
    </Card>
  );
}

/* ---------------- funding ---------------- */

function Funding({ prof, ent }: { prof: WalletProfile; ent: EntriesResponse | null }) {
  const f = prof.funding;
  const sib = f.siblings;
  if (f.status !== "ok") {
    return <Card id="funding" title="Funding"><p className={s.msg}>Funder unknown: {plain(f.reason, "the explorer didn't answer")}.</p></Card>;
  }
  const funderLaunches = ent && ent.funderLaunches !== null ? ent.funderLaunches : f.funder?.launches ?? null;
  const fTx = f.funder ? txLabel(f.funder.sentTx, f.funder.txCount) : null;
  return (
    <Card id="funding" title="Funding">
      <dl className={s.kv}>
        <Row k="First ETH from" txt={f.kind !== "source"}>
          {f.kind === "source" && f.from ? (
            <>
              <WalletLink a={f.from} />
              {f.funder?.labels.map(labelChip)}
              {f.funder?.isContract && <span className={s.mini}>Contract</span>}
              {f.funder?.busy && <span className={s.mini} title="A busy hub: wallets it funded may be unrelated">Hub</span>}
            </>
          ) : f.kind === "faucet" ? "Public faucet" : f.kind === "bridge" ? "Own bridge from L1" : <span className={s.dim}>—</span>}
        </Row>
        {f.kind === "source" && f.amountEth !== null && <Row k="Amount">{eth(f.amountEth)} ETH</Row>}
        {f.fundedAt ? <Row k="Date">{date(f.fundedAt)}</Row> : null}
        {f.funder?.name && <Row k="Funder" txt>{f.funder.name}</Row>}
        {fTx && <Row k="Funder activity">{fTx}</Row>}
        {f.kind === "source" && funderLaunches !== null && funderLaunches > 0 && (
          <Row k={ent && ent.funderLaunches !== null ? "Funder's launches it bought" : "Funder's launches"}><span className={ent && ent.funderLaunches ? s.down : undefined}>{funderLaunches}</span></Row>
        )}
        {f.kind === "source" && sib.status === "ok" && (
          <Row k="Same-funder wallets">
            {sib.total}{sib.capped ? "+" : ""}
            {sib.snipers > 0 && <small className={s.down}>{sib.snipers} sniper{sib.snipers === 1 ? "" : "s"}</small>}
            {sib.farm > 0 && <small>{sib.farm} farm</small>}
          </Row>
        )}
      </dl>
      {f.kind === "source" && sib.status === "ok" && sib.list.length > 0 && (
        <>
          <p className={s.sub}>Same funder</p>
          <ShowMore count={sib.list.length} initial={5} label="wallets" className={s.more}>
            {(n) => (
              <ul className={`${s.rows} ${s.rowsTop}`}>
                {sib.list.slice(0, n).map((x: Sibling) => (
                  <li key={x.address}>
                    <WalletLink a={x.address} />
                    <span>{x.labels.map(labelChip)}</span>
                  </li>
                ))}
              </ul>
            )}
          </ShowMore>
        </>
      )}
    </Card>
  );
}

/* ---------------- positions ---------------- */

type PosSort = "value" | "pnl" | "x";

function Positions({ prof, cost }: { prof: WalletProfile; cost: CostInfo }) {
  const pos = prof.positions;
  const items = cost.rows;
  const [sortPick, setSort] = useState<PosSort>("value");
  const has = { value: true, pnl: items.some((p) => p.unrealizedEth !== null), x: items.some((p) => p.multiple !== null) };
  const sort: PosSort = has[sortPick] ? sortPick : "value";
  const rows = useMemo(() => {
    const key = (p: Position) => (sort === "value" ? p.valueEth : sort === "pnl" ? p.unrealizedEth : p.multiple) ?? -Infinity;
    return [...items].sort((a, b) => key(b) - key(a));
  }, [items, sort]);

  if (pos.status === "unavailable") {
    return <Card id="positions" title="Open positions"><p className={s.msg}>Unknown right now: {plain(pos.reason)}.</p></Card>;
  }
  if (!pos.items.length) {
    return <Card id="positions" title="Open positions"><p className={s.msg}>No open positions.</p></Card>;
  }
  // while the chain cost loads the columns stay (cells read "…"), so rows don't grow when it lands
  const showCost = items.some((p) => p.costEth !== null) || cost.loading;
  // a column with nothing in it is dropped, not filled with "—"
  const showPnl = showCost && (items.some((p) => p.unrealizedEth !== null) || cost.loading);
  const showX = showCost && (items.some((p) => p.multiple !== null) || cost.loading);
  const pend = (v: unknown) => cost.loading && (v === null || v === undefined);
  const tot = pos.totals;
  const chainTot = cost.used ? knownTotals(items) : null;
  const totCost = tot?.costEth ?? chainTot?.cost ?? null;
  const totUnreal = tot?.unrealizedEth ?? chainTot?.unreal ?? null;
  const sortTh = (k: PosSort, label: React.ReactNode, title?: string) => (
    <th scope="col" aria-sort={sort === k ? "descending" : undefined} title={title}>
      {has[k] && rows.length > 1 ? <button type="button" className={`${s.sortBtn} ${sort === k ? s.sortOn : ""}`} onClick={() => setSort(k)}>{label}{sort === k ? " ↓" : ""}</button> : label}
    </th>
  );
  return (
    <Card id="positions" title={<>Open positions<span className={s.meta}> · {pos.items.length}{pos.capped ? "+" : ""}</span></>}>
      <ShowMore count={rows.length} initial={ROWS} label="positions" className={s.more}>
        {(n) => (
          <table className={`${s.table} ${s.rt}`}>
            <thead>
              <tr>
                <th scope="col">Token</th>
                {sortTh("value", "Value", "At the current curve or pool price, before the 1.25% sell fee")}
                {showCost && <>
                  <th scope="col">Cost</th>
                  {showPnl && sortTh("pnl", "Unrealized")}
                  {showX && sortTh("x", "× entry")}
                </>}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, n).map((p) => (
                <tr key={p.token}>
                  <td className={s.cTok}>
                    <Link className={s.sym} href={`/line/${p.token}`}>${p.symbol || shortAddr(p.token)}</Link>
                    {p.name && <span className={s.tokName}>{p.name}</span>}
                  </td>
                  <td className={`${s.cMain} ${p.valueEth === null ? s.dim : ""}`} title={p.valueEth === null ? UNK : undefined}>{eth(p.valueEth)}</td>
                  {showCost && <>
                    <td className={p.costEth === null ? s.dim : undefined} title={p.chainCost ? "Read from the chain" : undefined}><span className={s.cl}>Cost</span>{pend(p.costEth) ? "…" : eth(p.costEth)}{p.chainCost && <span className={s.dim}>*</span>}</td>
                    {showPnl && <td className={tone(p.unrealizedEth)}>
                      <span className={s.cl}>PnL</span>
                      {pend(p.unrealizedEth) ? "…" : signedEth(p.unrealizedEth)}
                      <span className={s.pc}>{p.costEth && p.unrealizedEth !== null ? pctOf((p.unrealizedEth / p.costEth) * 100, true) : ""}</span>
                    </td>}
                    {showX && <td className={p.multiple === null ? s.dim : undefined}><span className={s.cl}>×</span>{pend(p.multiple) ? "…" : p.multiple === null ? "—" : `${p.multiple.toFixed(2)}×`}</td>}
                  </>}
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && tot?.valueEth != null && (
              <tfoot>
                <tr>
                  <td className={s.cTok}>Total</td>
                  <td className={s.cMain}>{eth(tot.valueEth)}</td>
                  {showCost && <>
                    <td><span className={s.cl}>Cost</span>{eth(totCost)}</td>
                    {showPnl && <td className={tone(totUnreal)}><span className={s.cl}>PnL</span>{signedEth(totUnreal)}<span className={s.pc}>{totCost && totUnreal !== null ? pctOf((totUnreal / totCost) * 100, true) : ""}</span></td>}
                    {showX && <td />}
                  </>}
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </ShowMore>
      {items.every((x) => x.valueEth === null) && <p className={s.note}>Prices unavailable right now.</p>}
      {!cost.loading && cost.used > 0 && <p className={s.note}>* Cost read from the chain while vibe&apos;s indexer catches up.</p>}
      {pos.capped && <p className={s.note}>vibe returns the first 100 positions only.</p>}
    </Card>
  );
}

/* ---------------- early entries ---------------- */

function cellClass(e: Entry) {
  if (e.status === "pending" || e.status === "error") return s.cPend;
  if (e.own) return s.cOwn;
  if (e.status === "late") return s.cLate;
  if (e.rank !== null && !e.rankCapped) return e.rank <= 5 ? s.c5 : e.rank <= 20 ? s.c20 : e.rank <= 50 ? s.c50 : "";
  return "";
}

function Entries({ load }: { load: Load<EntriesResponse> }) {
  const d = load.data;
  // empty, unknown or not placed yet: no block (never a heading over nothing)
  if (!d || d.status !== "ok" || !d.items.length || d.checked === 0) return null;
  const strip = [...d.items].reverse(); // oldest -> newest
  // while launches are still being placed a count is a floor: "2+" says something, "0+" is unknown, not zero
  const placing = d.pending > 0;
  const count = (n: number) => (placing ? (n > 0 ? `${n}+` : null) : String(n));
  const first20 = count(d.first20);
  const first5 = count(d.first5);
  // every launch placed and none of them early: a real zero, said in words (the medians below still mean something)
  const none = !placing && d.first20 === 0;
  const placingTitle = "Still placing launches. Unknown, not zero.";
  return (
    <Card id="entries" title="Early entries" aside={<span className={s.meta}>{d.pending ? `placed ${d.items.length - d.pending - d.errors} of ${d.items.length}` : `${d.checked} launches`}</span>}>
      {none && <p className={s.msg} style={{ marginBottom: 12 }}>Never among the first 20 buyers of a launch it bought.</p>}
      {(!none || d.medianRank !== null || d.medianDelaySec !== null) && (
        <dl className={`${s.kpis} ${s.kpisFlat}`} style={{ "--n": none ? 2 : 4 } as React.CSSProperties}>
          {!none && (
            <>
              <div className={s.kpi}><dt>First 20</dt>{first20 === null ? <dd className={s.dim} title={placingTitle}>—</dd> : <dd>{first20}<small>{pct(d.first20Rate)}</small></dd>}</div>
              <div className={s.kpi}><dt>First 5</dt>{first5 === null ? <dd className={s.dim} title={placingTitle}>—</dd> : <dd>{first5}</dd>}</div>
            </>
          )}
          <div className={s.kpi}><dt>Median place</dt><dd className={d.medianRank === null ? s.dim : undefined}>{d.medianRank !== null ? `#${Math.round(d.medianRank)}` : "—"}</dd></div>
          <div className={s.kpi}><dt>Median entry</dt><dd className={d.medianDelaySec === null ? s.dim : undefined}>{d.medianDelaySec !== null ? dur(d.medianDelaySec) : "—"}</dd></div>
        </dl>
      )}
      <div className={s.strip} role="img" aria-label={`Place in each of ${strip.length} launches, oldest to newest`}>
        {strip.map((e) => <i key={e.token} className={`${s.cell} ${cellClass(e)}`} title={`$${e.symbol}: ${e.own ? "own launch" : e.status === "ranked" ? `#${e.rank}${e.rankCapped ? "+" : ""}` : e.status}`} />)}
      </div>
      <div className={s.legend} aria-hidden>
        <span><i className={s.c5} />#1–5</span>
        <span><i className={s.c20} />#6–20</span>
        <span><i className={s.cell} />later</span>
        <span><i className={s.cOwn} />own</span>
      </div>
      <ShowMore count={d.items.length} initial={ROWS} label="launches" className={s.more}>
        {(n) => (
          <table className={`${s.table} ${s.rt}`}>
            <thead>
              <tr>
                <th scope="col">Launch</th>
                <th scope="col">Place</th>
                <th scope="col">After launch</th>
                <th scope="col">Creator</th>
                <th scope="col">Now</th>
              </tr>
            </thead>
            <tbody>
              {d.items.slice(0, n).map((e) => (
                <tr key={e.token}>
                  <td className={s.cTok}>
                    <Link className={s.sym} href={`/line/${e.token}`}>${e.symbol || shortAddr(e.token)}</Link>
                    {e.funders && <span className={`${s.flag} ${s.flagRisk}`} title="Created by the wallet that funded this one">funder&apos;s</span>}
                    <span className={s.tokName}>{date(e.buyTs)}</span>
                  </td>
                  <td className={`${s.cMain} ${e.rank !== null && !e.rankCapped && e.rank <= 5 ? s.down : e.rank !== null && !e.rankCapped && e.rank <= 20 ? "" : s.dim}`}>
                    <span className={s.cl}>Place</span>
                    {e.status === "pending" ? <i className={`${s.pend} ${shimmer}`} aria-label="placing" /> : e.status === "error" ? "—" : e.own ? "own" : e.status === "late" ? "late" : e.rank !== null ? `#${e.rank}${e.rankCapped ? "+" : ""}` : "—"}
                  </td>
                  <td className={e.delaySec === null ? s.dim : undefined}><span className={s.cl}>After</span>{e.status === "late" ? "80m+" : dur(e.delaySec)}</td>
                  <td><span className={s.cl}>Creator</span>{e.creator ? <WalletLink a={e.creator} dev /> : <span className={s.dim}>—</span>}</td>
                  <td className={s.dim}><span className={s.cl}>Now</span>{e.holding ? "holds" : e.exited ? "exited" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ShowMore>
      {d.topCreators.length > 0 && (
        <>
          <p className={s.sub}>Creators it buys most</p>
          <ul className={`${s.rows} ${s.rowsTop}`}>
            {d.topCreators.map((c) => (
              <li key={c.creator}>
                <span><WalletLink a={c.creator} dev />{c.labels.map(labelChip)}{d.funder === c.creator && <span className={`${s.mini} ${s.risk}`}>its funder</span>}</span>
                <span>{c.launches}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.bought > d.considered && <p className={s.note}>Newest {d.considered} of {d.bought} launches checked.</p>}
    </Card>
  );
}

/* ---------------- farm peers ---------------- */

function FarmPeers({ farm }: { farm: { id: number; size: number; peers: string[] } }) {
  return (
    <Card id="farm" title={<>Farm #{farm.id}<span className={s.meta}> · {farm.size} wallets</span></>}>
      <p className={s.msg}>Wallets that keep buying the first minutes of the same launches together.</p>
      <ShowMore count={farm.peers.length} initial={8} label="wallets" className={s.more}>
        {(n) => (
          <ul className={`${s.rows} ${s.rowsTop}`} style={{ marginTop: 12 }}>
            {farm.peers.slice(0, n).map((a) => <li key={a}><WalletLink a={a} /></li>)}
          </ul>
        )}
      </ShowMore>
    </Card>
  );
}
