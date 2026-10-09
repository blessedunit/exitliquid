"use client";
// Wallet profile. Order (spec 4.3): breadcrumb → H1 + lead → tags → KPI row → section tabs →
// Behaviour + Funding → Positions → Early entries → Launches created (→ farm peers).
// Signals, not verdicts. Unknown is shown as "—" with the reason, never as 0.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ChainCost, EntriesResponse, Entry, Position, Tag, WalletProfile, Sibling } from "@/lib/walletProfile";
import { walletSummary } from "@/lib/walletSummary";
import { fmtAge, fmtCompact, fmtEth, fmtInt, pct as pctOf, shortAddr } from "@/lib/format";
import WalletAddress from "@/components/WalletAddress";
import ShareCard from "@/components/ShareCard";
import WalletLookup from "../WalletLookup";
import Lead from "@/components/ui/Lead";
import SectionTabs from "@/components/ui/SectionTabs";
import ShowMore from "@/components/ui/ShowMore";
import Term from "@/components/ui/Term";
import { TagTip } from "../ui";
import s from "../w.module.css";

const ENTRY_POLL_MS = 1_500;
const ENTRY_POLLS = 8;
const ROWS = 10;
const UNK = "Unknown, not zero.";

const SECTIONS = [
  { id: "behaviour", label: "Behaviour" },
  { id: "funding", label: "Funding" },
  { id: "positions", label: "Positions" },
  { id: "entries", label: "Early entries" },
  { id: "launches", label: "Launches" },
];

/* ---------------- formatting ---------------- */

function signedEth(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  return `${v > 0 ? "+" : "−"}${fmtEth(Math.abs(v))}`;
}
const tone = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? s.unk : v > 0 ? s.up : v < 0 ? s.down : "");
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
/** one plain reason for the page: never an HTTP code ("vibe API error (503)" reads as a site defect) */
function plain(reason: string | null | undefined, fallback = "vibe/vibe didn't answer"): string {
  if (!reason) return fallback;
  return /\(\d{3}\)|api \d{3}|non-JSON|backing off|did not answer/i.test(reason) ? fallback : reason;
}
const seasonWhy = (r: string | null | undefined) => plain(r, "season board offline");

/** a cell that may be unknown: "—" with the title the spec asks for */
function U({ v, children }: { v: unknown; children: React.ReactNode }) {
  return v === null || v === undefined ? <span className={s.dim} title={UNK}>—</span> : <>{children}</>;
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
  // creators open their Dev Passport; everyone else their wallet profile
  return <Link className={s.addrLink} href={dev ? `/dev/${a}` : `/w/${a}`} title={dev ? `${a} · dev passport` : a}>{shortAddr(a)}</Link>;
}

/** card header: title (+ glossary icon) on the left, a muted meta (or an action) on the right */
function Head({ id, title, children }: { id: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className={s.cardHead}>
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  );
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
    setSt({ key, items: null, loading: true });
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

export default function WalletProfileView({ addr }: { addr: string }) {
  const [nonce, setNonce] = useState(0);
  const p = useProfile(addr, nonce);
  const e = useEntries(addr, nonce);
  const prof = p.data;
  const ent = e.data && e.data.status === "ok" ? e.data : null;
  const cost = useChainCost(addr, prof);

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
    const rank: Record<string, number> = { risk: 0, warn: 1, dev: 2, good: 3, info: 4 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }, [prof, ent]);

  const lead = prof ? walletSummary(prof, e.data) : null;

  return (
    <>
      <div className={s.top}>
      <div className={s.crumbRow}>
        <nav className={s.crumb} aria-label="Breadcrumb">
          <Link href="/w">Wallets</Link>
          <span aria-hidden>/</span>
          <span aria-current="page"><WalletAddress wallet={addr} /></span>
        </nav>
        <div className={s.crumbTools}>
          <button type="button" className={s.toolBtn} onClick={() => setNonce((n) => n + 1)} disabled={p.loading} ><span aria-hidden>↻</span>{p.loading && prof ? " Refreshing…" : " Refresh"}</button>
          <ShareCard kind="wallet" id={addr} className={s.toolBtn} />
          <WalletLookup target="wallet" inline />
        </div>
      </div>

      <header className={s.head}>
        <h1 className={s.h1}>Wallet <span className={s.h1Addr}>{shortAddr(addr)}</span></h1>
        {prof ? (
          <Lead>{lead ?? "Nothing on vibe/vibe to summarize for this wallet yet."}</Lead>
        ) : p.loading ? (
          <p className={s.leadSkel} aria-hidden><i className={s.skLine} /></p>
        ) : null}
      </header>
      </div>

      {p.loading && !prof ? (
        <ProfileSkeleton />
      ) : !prof ? (
        <div className={s.card} role="alert">
          <p className={s.msg}>
            {p.error ?? "This wallet can't be read right now."} Nothing is shown rather than a guess.{" "}
            <button type="button" className={s.inlineBtn} onClick={() => setNonce((n) => n + 1)}>Try again</button>
          </p>
        </div>
      ) : (
        <>
          <div className={s.badgeRow}>
            <ul className={s.tags} aria-label="Wallet tags">
              {tags.length ? (
                tags.map((t) => (
                  <li key={t.id}>
                    <TagTip tip={{ term: t.label, short: t.detail }}>
                      <span className={`${s.tag} ${s[`t_${t.tone}`]}`}>{t.label}</span>
                    </TagTip>
                  </li>
                ))
              ) : (
                <li><span className={`${s.tag} ${s.t_none}`} title="Not on a list is not the same as clean.">No flags</span></li>
              )}
            </ul>
            <span className={s.badgeMeta}>
              Signals, not verdicts · chain + vibe/vibe · {ago(Math.floor(prof.updatedAt / 1000))}
              {prof.index.stale && <> · <span className={s.warnTxt} title="Sniper and farm labels are unknown, not absent.">Early Index too old</span></>}
            </span>
          </div>
          <Tiles prof={prof} ent={ent} entErr={e.error} cost={cost} />
          <SectionTabs items={SECTIONS} />
          <div className={s.grid2}>
            <Behaviour prof={prof} />
            <Funding prof={prof} ent={ent} />
          </div>
          <div className={s.stack}>
            <Positions prof={prof} cost={cost} />
            <Entries load={e} />
            <Launches prof={prof} ent={ent} />
            {prof.index.farm && <FarmPeers farm={prof.index.farm} />}
          </div>
          <p className={s.foot}>
            Public data only: chain logs, the vibe/vibe API and the explorer. Tags are signals, not verdicts: a shared funder or an early entry is a reason to look closer, never proof.
            {prof.index.ageSec !== null && <> <Term id="early-index">Early Index</Term> as of {date(Math.floor(prof.updatedAt / 1000) - prof.index.ageSec)} ({prof.index.snipers} snipers · {prof.index.farms} farms).</>}
          </p>
          <div className={s.footLinks}>
            <Link className={s.toolBtn} href={`/lines?w=${addr.toLowerCase()}`} prefetch={false}>My lines view →</Link>
            <Link className={s.toolBtn} href={`/t/${addr.toLowerCase()}`} prefetch={false}>$EXIT ticket →</Link>
          </div>
        </>
      )}
    </>
  );
}

/* ---------------- skeletons ---------------- */
// Sized like the loaded page so the data arriving doesn't push the page down (CLS).

const TILE_NAMES = ["ETH balance", "Open positions", "Season PnL", "Trader rank", "First-20 entries", "Launches created"];

function SkelRows({ n }: { n: number }) {
  return (
    <>
      <div className={s.skHead} />
      {Array.from({ length: n }, (_, i) => <div key={i} className={s.skRow}><i className={s.skLine} /></div>)}
    </>
  );
}

function SkelCard({ title, cls }: { title: string; cls: string }) {
  return (
    <section className={s.card}>
      <div className={s.cardHead}><h2>{title}</h2></div>
      <div className={`${s.skBlock} ${cls}`} />
    </section>
  );
}

function EntriesSkeleton() {
  return (
    <>
      <dl className={s.kv3}>
        {["First 20", "First 5", "Median place", "Median entry", "Within 1 min", "After ~80 min"].map((k) => (
          <div key={k}><dt>{k}</dt><dd><i className={s.skLine} style={{ width: 56, height: 18 }} /></dd></div>
        ))}
      </dl>
      <div className={s.strip}><i className={s.skLine} style={{ width: "100%", height: 10 }} /></div>
      <SkelRows n={ROWS} />
    </>
  );
}

function ProfileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading the wallet">
      <div className={s.badgeRow}>
        <ul className={s.tags} aria-hidden><li><span className={`${s.tag} ${s.t_none}`}>Reading chain, vibe/vibe and explorer…</span></li></ul>
      </div>
      <div className={s.tiles}>
        {TILE_NAMES.map((n) => (
          <div key={n} className={s.tile}><small>{n}</small><b><i className={s.skLine} style={{ width: "60%", height: 20 }} /></b><span className={s.skTileNote}><i className={s.skLine} style={{ width: "80%" }} /></span></div>
        ))}
      </div>
      <div className={s.skTabs} />
      <div className={s.grid2}>
        <SkelCard title="Behaviour" cls={s.skBeh} />
        <SkelCard title="Funding" cls={s.skBeh} />
      </div>
      <div className={s.stack}>
        <section className={s.card}>
          <div className={s.cardHead}><h2>Open positions</h2></div>
          <SkelRows n={ROWS} />
        </section>
        <section className={s.card}>
          <div className={s.cardHead}><h2>Early entries</h2></div>
          <EntriesSkeleton />
        </section>
      </div>
    </div>
  );
}

/* ---------------- summary tiles ---------------- */

// nonce = exact sent txs; the explorer counter is approximate (it lags), so it is marked "≈"
function txLabel(sent: number | null | undefined, counter: number | null): string {
  if (sent != null) return `${fmtCompact(sent)} sent txs`;
  return counter !== null ? `≈${fmtCompact(counter)} txs` : "tx count —";
}

type CostInfo = ReturnType<typeof useChainCost>;

/** cost and unrealized summed over the rows that have both (vibe's own totals when it has them) */
function knownTotals(rows: PosView[]): { cost: number; unreal: number; n: number } | null {
  const k = rows.filter((p) => p.costEth !== null && p.unrealizedEth !== null);
  return k.length ? { cost: k.reduce((a, p) => a + p.costEth!, 0), unreal: k.reduce((a, p) => a + p.unrealizedEth!, 0), n: k.length } : null;
}

function Tiles({ prof, ent, entErr, cost }: { prof: WalletProfile; ent: EntriesResponse | null; entErr: string | null; cost: CostInfo }) {
  const pos = prof.positions;
  const chainTot = cost.used ? knownTotals(cost.rows) : null;
  const tr = prof.trader;
  const tot = pos.totals;
  const devTotal = prof.dev.status === "ok" ? prof.dev.total : null;
  // v6 not covered and nothing listed: a 0 would be a guess
  const v6Gap = prof.dev.status === "ok" && prof.dev.coverage === "v1-only" && !devTotal;
  const launched = v6Gap ? (ent?.ownLaunches ? `${ent.ownLaunches}+` : null) : devTotal !== null ? Math.max(devTotal, ent?.ownLaunches ?? 0) : ent?.ownLaunches ? `${ent.ownLaunches}+` : null;
  // first-20 is unknown until at least one launch is placed; "so far" while the rest are still being placed
  const f20Known = !!ent && ent.checked > 0;
  const f20Note = !ent
    ? (entErr ?? "checking…")
    : ent.checked === 0
      ? ent.pending ? `placing ${ent.pending}…` : ent.bought === 0 ? "no launches bought" : ent.ownLaunches > 0 && ent.ownLaunches === ent.items.length ? "only its own launches" : "none placed"
      : ent.pending ? `so far · placing ${ent.pending} more` : `${pct(ent.first20Rate)} of launches placed`;
  return (
    <div className={s.tiles}>
      <div className={s.tile}>
        <small>ETH balance</small>
        <b className={`num ${prof.eth.balance === null ? s.unk : ""}`} title={prof.eth.balance === null ? UNK : undefined}>{fmtEth(prof.eth.balance)}</b>
        <span>{prof.eth.reason ?? txLabel(prof.explorer.sentTx, prof.explorer.txCount)}</span>
      </div>
      <div className={s.tile}>
        <small>Open positions</small>
        <b className={`num ${tot?.valueEth == null ? s.unk : ""}`} title={tot?.valueEth == null ? UNK : undefined}>{tot ? fmtEth(tot.valueEth) : "—"}</b>
        <span>
          {pos.status === "unavailable" ? pos.reason : <>
            {pos.items.length}{pos.capped ? "+" : ""} tokens · {tot?.unrealizedEth != null ? (
              <><i className={tone(tot.unrealizedEth)} style={{ fontStyle: "normal" }}>{signedEth(tot.unrealizedEth)}</i> unrealized</>
            ) : chainTot ? (
              <><i className={tone(chainTot.unreal)} style={{ fontStyle: "normal" }}>{signedEth(chainTot.unreal)}</i> unrealized on {chainTot.n}</>
            ) : cost.loading ? "reading cost…" : "cost basis unknown"}
          </>}
        </span>
      </div>
      <div className={s.tile}>
        <small>Season PnL</small>
        <b className={`num ${tone(tr.pnlEth)}`} title={tr.pnlEth === null ? UNK : undefined}>{tr.status === "ok" ? signedEth(tr.pnlEth) : "—"}</b>
        <span>{tr.status === "ok" ? <>realized <i className={tone(tr.realizedEth)} style={{ fontStyle: "normal" }}>{signedEth(tr.realizedEth)}</i></> : tr.status === "absent" ? "not on the board" : seasonWhy(tr.reason)}</span>
      </div>
      <div className={s.tile}>
        <small>Trader rank</small>
        <b className={`num ${tr.rank === null ? s.unk : ""}`} title={tr.rank === null ? UNK : undefined}>{tr.rank !== null ? `#${fmtCompact(tr.rank)}` : "—"}</b>
        <span>{tr.status === "ok" ? (tr.of ? `of ${fmtCompact(tr.of)} wallets` : "of —") : tr.status === "absent" ? "not on the board" : seasonWhy(tr.reason)}</span>
      </div>
      <div className={s.tile}>
        <small>First-20 entries</small>
        <b className={`num ${f20Known ? "" : s.unk}`} title={f20Known ? undefined : UNK}>{f20Known ? `${ent!.first20}/${ent!.checked}` : "—"}</b>
        <span>{f20Note}</span>
      </div>
      <div className={s.tile}>
        <small>Launches created</small>
        <b className={`num ${launched === null ? s.unk : ""}`} title={launched === null ? UNK : undefined}>{launched ?? "—"}</b>
        <span>{prof.dev.status !== "ok" ? plain(prof.dev.reason) : v6Gap ? "taxed v6 not covered" : devTotal ? `${prof.dev.graduated ?? "—"} graduated` : ent?.ownLaunches ? "on-chain, not on vibe's list" : "per vibe/vibe"}</span>
      </div>
    </div>
  );
}

/* ---------------- behaviour ---------------- */

function Behaviour({ prof }: { prof: WalletProfile }) {
  const a = prof.activity;
  const tr = prof.trader;
  return (
    <section id="behaviour" className={s.card} aria-labelledby="w-beh">
      <Head id="w-beh" title="Behaviour">
        <span className={s.sub}>{a.status === "unavailable" ? "unavailable" : `since ${date(a.firstTs)} · last ${ago(a.lastTs)}`}</span>
      </Head>
      {a.status === "unavailable" ? (
        <p className={s.msg}>Unknown: {a.reason}.</p>
      ) : (
        <dl className={s.kv}>
          <div><dt>Launches bought</dt><dd className="num">{a.bought}{a.status === "partial" ? "+" : ""}<small>{a.launchesPerDay !== null ? `${a.launchesPerDay}/active day` : ""}</small></dd></div>
          <div><dt>Buys / sells</dt><dd className="num">{a.buys} / {a.sells}</dd></div>
          <div><dt>Still holding</dt><dd className="num">{a.holding}<small>of {a.bought}{a.status === "partial" ? " checked" : ""}</small></dd></div>
          <div><dt><Term id="walked-out">Walked out</Term></dt><dd className="num">{a.exited}<small>{a.exited ? `${a.exitedWithinHour} within 1 h` : ""}</small></dd></div>
          <div><dt>Median hold</dt><dd className="num">{a.exited ? dur(a.medianHoldSec) : <span className={s.dim} title="No exits yet.">—</span>}<small>{a.exited ? "buy → exit" : "no exits yet"}</small></dd></div>
          <div><dt>Transfers</dt><dd className="num">{fmtInt(a.giftsIn)} in / {fmtInt(a.giftsOut)} out<small>not via market</small></dd></div>
          <div><dt>Season trades</dt><dd className="num">{tr.status === "ok" ? `${tr.buys ?? "—"} / ${tr.sells ?? "—"}` : <span className={s.dim} title={UNK}>—</span>}<small>{tr.status === "ok" ? "vibe buys / sells" : tr.status === "absent" ? "not on the board" : seasonWhy(tr.reason)}</small></dd></div>
          <div><dt>Active for</dt><dd className="num"><U v={a.activeDays}>{a.activeDays === null ? null : Math.max(1, Math.round(a.activeDays))}<small>days, first → last trade</small></U></dd></div>
        </dl>
      )}
      {a.reason && a.status !== "unavailable" && <p className={s.note}>Partial: {a.reason}.</p>}
    </section>
  );
}

/* ---------------- funding + cluster ---------------- */

function Funding({ prof, ent }: { prof: WalletProfile; ent: EntriesResponse | null }) {
  const f = prof.funding;
  const sib = f.siblings;
  return (
    <section id="funding" className={s.card} aria-labelledby="w-fund">
      <Head id="w-fund" title="Funding">
        <span className={s.sub}>who sent its first ETH</span>
      </Head>
      {f.status !== "ok" ? (
        <p className={s.msg}>Funder unknown: {f.reason ?? "explorer did not answer"}.</p>
      ) : (
        <>
          <div className={s.fund}>
            {f.kind === "source" && f.from ? (
              <p className={s.fundLine}>
                Funded by <WalletLink a={f.from} />
                {f.funder?.labels.map(labelChip)}
                {f.funder?.isContract && <span className={s.mini}>Contract</span>}
                {f.amountEth !== null && <> with {fmtEth(f.amountEth)} ETH</>}
                {f.fundedAt && <>, {date(f.fundedAt)}</>}.
              </p>
            ) : f.kind === "faucet" ? (
              <p className={s.fundLine}>First ETH came from the public faucet{f.fundedAt ? `, ${date(f.fundedAt)}` : ""}. A faucet links no wallets together.</p>
            ) : f.kind === "bridge" ? (
              <p className={s.fundLine}>First ETH was bridged from L1 by the same address{f.fundedAt ? `, ${date(f.fundedAt)}` : ""}.</p>
            ) : (
              <p className={s.fundLine}>No incoming ETH in its oldest transactions: funder unknown.</p>
            )}
            {f.funder && (
              <p className={s.fundLine}>
                Funder: {f.funder.name ? `${f.funder.name}, ` : ""}{txLabel(f.funder.sentTx, f.funder.txCount)}
                {f.funder.busy ? " (busy: a hub, siblings may be unrelated)" : ""}
                {ent && ent.funderLaunches !== null ? `; created ${ent.funderLaunches} of the launches this wallet bought` : f.funder.launches !== null ? `; ${f.funder.launches} launches on vibe's list` : ""}.
              </p>
            )}
          </div>
          {f.kind === "source" && (
            sib.status === "ok" ? (
              <>
                <p className={s.note}>
                  Siblings: the funder also sent ETH to <b>{sib.total}{sib.capped ? "+" : ""}</b> other wallet{sib.total === 1 ? "" : "s"}
                  {sib.total ? <> ({sib.snipers} sniper{sib.snipers === 1 ? "" : "s"}, {sib.farm} farm)</> : null}
                  {sib.capped ? ` in its oldest ${sib.scanned} transfers` : ""}.
                </p>
                {sib.list.length > 0 && (
                  <ShowMore count={sib.list.length} initial={6} label="siblings" className={s.more}>
                    {(n) => (
                      <ul className={s.sibs}>
                        {sib.list.slice(0, n).map((x: Sibling) => (
                          <li key={x.address} className={s.sib}>
                            <WalletLink a={x.address} />
                            <span>{x.labels.map(labelChip)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </ShowMore>
                )}
              </>
            ) : sib.status === "unavailable" ? (
              <p className={s.note}>Siblings unknown: {sib.reason}.</p>
            ) : null
          )}
        </>
      )}
    </section>
  );
}

/* ---------------- positions ---------------- */

type PosSort = "value" | "pnl" | "x";
const SORTS: { k: PosSort; label: string }[] = [
  { k: "value", label: "Value" },
  { k: "pnl", label: "PnL" },
  { k: "x", label: "× entry" },
];

function Positions({ prof, cost }: { prof: WalletProfile; cost: CostInfo }) {
  const pos = prof.positions;
  const items = cost.rows;
  const [sortPick, setSort] = useState<PosSort>("value");
  // a sort with no value to sort by is switched off, never an arbitrary order
  const has = {
    value: true,
    pnl: items.some((p) => p.unrealizedEth !== null),
    x: items.some((p) => p.multiple !== null),
  };
  const sort: PosSort = has[sortPick] ? sortPick : "value";
  const rows = useMemo(() => {
    const key = (p: Position) => (sort === "value" ? p.valueEth : sort === "pnl" ? p.unrealizedEth : p.multiple) ?? -Infinity;
    return [...items].sort((a, b) => key(b) - key(a));
  }, [items, sort]);
  // while the chain cost loads the columns stay (cells read "…"), so rows don't grow when it lands
  const showCost = items.some((p) => p.costEth !== null) || cost.loading;
  const pend = (v: unknown) => cost.loading && (v === null || v === undefined);
  const unpriced = items.filter((p) => p.valueEth === null).length;
  const tot = pos.totals;
  const vibeCost = tot?.costEth != null;
  const chainTot = cost.used ? knownTotals(items) : null;
  const costWhy = pos.indexerBehind ? "vibe's indexer is behind" : pos.status === "fallback" ? "vibe API unavailable" : "vibe has no price history";
  return (
    <section id="positions" className={s.card} aria-labelledby="w-pos">
      <Head id="w-pos" title="Open positions">
        <span className={s.sub}>
          {pos.status === "unavailable" ? "unavailable" : <>
            {pos.items.length}{pos.capped ? "+" : ""} {pos.status === "fallback" ? "chain balances" : "positions"}
            {vibeCost && tot ? <> · <span className={tone(tot.unrealizedEth)}>{signedEth(tot.unrealizedEth)}</span> unrealized</>
              : chainTot ? <> · <span className={tone(chainTot.unreal)}>{signedEth(chainTot.unreal)}</span> unrealized on {chainTot.n}</>
              : pos.items.length ? <> · cost basis {cost.loading ? "loading…" : `unavailable: ${costWhy}`}</> : null}
          </>}
        </span>
      </Head>
      {pos.status === "unavailable" ? (
        <p className={s.msg}>Positions unknown: {pos.reason}.</p>
      ) : !pos.items.length ? (
        <p className={s.msg}>No open vibe/vibe positions{pos.status === "fallback" ? " found on chain" : ""}.</p>
      ) : (
        <>
          <div className={s.tools} role="group" aria-label="Sort positions">
            <span className={s.toolsLabel}>Sort</span>
            {SORTS.map((o) => (
              <button
                key={o.k}
                type="button"
                className={s.chip}
                aria-pressed={sort === o.k}
                disabled={!has[o.k]}
                title={has[o.k] ? undefined : "No cost basis yet, so nothing to sort by."}
                onClick={() => setSort(o.k)}
              >
                {o.label}{sort === o.k ? " ↓" : ""}
              </button>
            ))}
          </div>
          <ShowMore count={rows.length} initial={ROWS} label="positions" className={s.more}>
            {(n) => (
              <table className={`${s.table} ${s.rt}`}>
                <thead>
                  <tr>
                    <th scope="col">Token</th>
                    <th scope="col" aria-sort={sort === "value" ? "descending" : undefined}>Value</th>
                    {showCost && <>
                      <th scope="col">Cost</th>
                      <th scope="col" aria-sort={sort === "pnl" ? "descending" : undefined}>Unrealized</th>
                      <th scope="col" aria-sort={sort === "x" ? "descending" : undefined}>× entry</th>
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
                      <td className={`num ${s.cMain} ${p.valueEth === null ? s.dim : ""}`} title={p.valueEth === null ? UNK : undefined}><span className={s.cl}>Value</span>{fmtEth(p.valueEth)}</td>
                      {showCost && <>
                        <td className={`num ${p.costEth === null ? s.dim : ""}`} title={p.costEth === null ? UNK : p.chainCost ? "From the chain: ETH paid for the bought part of the bag." : undefined}><span className={s.cl}>Cost</span>{pend(p.costEth) ? "…" : fmtEth(p.costEth)}{p.chainCost && <span className={s.dim} aria-label="from the chain">*</span>}</td>
                        <td className={`num ${tone(p.unrealizedEth)}`}>
                          <span className={s.cl}>PnL</span>
                          {pend(p.unrealizedEth) ? "…" : signedEth(p.unrealizedEth)}
                          {p.costEth && p.unrealizedEth !== null ? <span className={s.dim}> {pctOf((p.unrealizedEth / p.costEth) * 100, true)}</span> : null}
                        </td>
                        <td className={`num ${p.multiple === null ? s.dim : ""}`}><span className={s.cl}>×</span>{pend(p.multiple) ? "…" : p.multiple === null ? "—" : `${p.multiple.toFixed(2)}×`}</td>
                      </>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ShowMore>
        </>
      )}
      {pos.reason && pos.status !== "unavailable" && <p className={s.note}>{pos.reason}{/[.!]$/.test(pos.reason) ? "" : "."}</p>}
      {cost.loading && <p className={s.note}>Reading cost basis from the chain for the top {cost.asked} positions…</p>}
      {!cost.loading && cost.used > 0 && (
        <p className={s.note}>
          * Cost read from the chain for {cost.used} of the top {cost.asked} positions: ETH paid for the bought part of the bag still held (tokens sent in by another wallet carry no cost). vibe&apos;s own figures return when its indexer catches up.
        </p>
      )}
      {pos.status === "ok" && tot && (
        <p className={s.note}>
          Totals: value {fmtEth(tot.valueEth)} ETH{unpriced ? ` (${pos.items.length - unpriced} priced of ${pos.items.length}, ${unpriced} without a price left out)` : ""}
          {vibeCost ? <> · cost {fmtEth(tot.costEth)} · unrealized <span className={tone(tot.unrealizedEth)}>{signedEth(tot.unrealizedEth)}</span></> : chainTot ? <> · cost {fmtEth(chainTot.cost)} · unrealized <span className={tone(chainTot.unreal)}>{signedEth(chainTot.unreal)}</span> on {chainTot.n} positions</> : null}
          {pos.capped ? " (vibe sends the first 100 positions only)" : ""}. Value at the current curve or pool price, before the 1.25% sell fee.
        </p>
      )}
    </section>
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
  const placed = d && d.status === "ok" ? d.items.length - d.pending - d.errors : 0;
  const meta = d && d.status === "ok"
    ? d.pending
      ? `placed ${placed} of ${d.items.length}`
      : d.checked
        ? <>First 20: {d.first20}/{d.checked}{d.medianRank !== null ? ` · median place #${Math.round(d.medianRank)}` : ""}</>
        : "its place in each launch's line"
    : "its place in each launch's line";
  const head = (
    <Head id="w-entries" title="Early entries">
      <span className={s.sub}>{meta}</span>
    </Head>
  );
  if (!d || d.status !== "ok") {
    return (
      <section id="entries" className={s.card} aria-labelledby="w-entries">
        {head}
        {load.loading ? (
          <div aria-busy="true"><p className={s.note}>Reading its first buy in each launch…</p><EntriesSkeleton /></div>
        ) : (
          <p className={s.msg}>{`Entries unknown: ${load.error ?? d?.reason ?? "chain did not answer"}.`}</p>
        )}
      </section>
    );
  }
  const strip = [...d.items].reverse(); // oldest -> newest
  // nothing placed yet: every count is unknown (—), not 0; with some placed, a "+" says more may come
  const known = d.checked > 0;
  const soFar = d.pending > 0 ? <span className={s.dim} title="So far: more launches are still being placed.">+</span> : null;
  const unk = <span className={s.unk} title={UNK}>—</span>;
  return (
    <section id="entries" className={s.card} aria-labelledby="w-entries">
      {head}
      {d.items.length === 0 ? (
        <p className={s.msg}>
          {d.bought === 0
            ? "It hasn't bought any vibe/vibe launch."
            : `None of the ${d.considered} launches checked could be placed: no vibe/vibe factory we read launched them.`}
        </p>
      ) : (
        <>
          <dl className={s.kv3}>
            <div><dt>First 20</dt><dd className="num">{known ? <>{d.first20}/{d.checked}{soFar}<small>{pct(d.first20Rate)}</small></> : unk}</dd></div>
            <div><dt>First 5</dt><dd className="num">{known ? <>{d.first5}{soFar}</> : unk}</dd></div>
            <div><dt>Median <Term id="place">place</Term></dt><dd className="num">{d.medianRank !== null ? `#${Math.round(d.medianRank)}` : <span className={s.dim} title={UNK}>—</span>}</dd></div>
            <div><dt>Median entry</dt><dd className="num">{d.medianDelaySec !== null ? <>{dur(d.medianDelaySec)}<small>after launch</small></> : <span className={s.dim} title={UNK}>—</span>}</dd></div>
            <div><dt>Within 1 min</dt><dd className="num">{known ? <>{d.withinMinute}{soFar}</> : unk}</dd></div>
            <div><dt>After ~80 min</dt><dd className="num">{known ? <>{d.late}{soFar}<small>not ranked</small></> : unk}</dd></div>
          </dl>
          <div className={s.strip} role="img" aria-label={`Place in each of ${strip.length} launches, oldest to newest`}>
            {strip.map((e) => <i key={e.token} className={`${s.cell} ${cellClass(e)}`} title={`$${e.symbol}: ${e.own ? "own launch" : e.status === "ranked" ? `#${e.rank}${e.rankCapped ? "+" : ""}` : e.status}`} />)}
          </div>
          <div className={s.legend} aria-hidden>
            <span><i className={s.c5} />#1–5</span>
            <span><i className={s.c20} />#6–20</span>
            <span><i className={s.c50} />#21–50</span>
            <span><i className={s.cell} />later</span>
            <span><i className={s.cLate} />80 min+</span>
            <span><i className={s.cOwn} />own launch</span>
            <span><i className={s.cPend} />pending</span>
            <span className={s.legendAxis}>oldest → newest</span>
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
                        {e.funders && <span className={`${s.flag} ${s.fFunder}`} title="Created by the wallet that funded this one">funder&apos;s</span>}
                        {e.own && <span className={`${s.flag} ${s.fOwn}`}>own</span>}
                        <span className={s.tokName}>{date(e.buyTs)}</span>
                      </td>
                      <td className={`num ${s.cMain} ${e.rank !== null && !e.rankCapped && e.rank <= 5 ? s.rank1 : e.rank !== null && !e.rankCapped && e.rank <= 20 ? s.rank2 : s.dim}`}>
                        <span className={s.cl}>Place</span>
                        {e.status === "pending" ? <i className={s.pendBar} aria-label="placing" /> : e.status === "error" ? <span title={UNK}>—</span> : e.own ? "dev" : e.status === "late" ? "late" : e.rank !== null ? `#${e.rank}${e.rankCapped ? "+" : ""}` : "—"}
                      </td>
                      <td className={`num ${e.delaySec === null ? s.dim : ""}`}><span className={s.cl}>After</span>{e.status === "late" ? "80m+" : dur(e.delaySec)}</td>
                      <td><span className={s.cl}>Creator</span>{e.creator ? <WalletLink a={e.creator} dev /> : <span className={s.dim} title={UNK}>—</span>}</td>
                      <td className={s.dim}><span className={s.cl}>Now</span>{e.holding ? "holds" : e.exited ? "exited" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ShowMore>
          {d.topCreators.length > 0 && (
            <>
              <p className={s.subHead}>Creators it buys most</p>
              <ul className={s.rows}>
                {d.topCreators.map((c) => (
                  <li key={c.creator} className={s.rowItem}>
                    <span><WalletLink a={c.creator} dev />{c.labels.map(labelChip)}{d.funder === c.creator && <span className={`${s.mini} ${s.risk}`}>its funder</span>}</span>
                    <span className="num">{c.launches} launches</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <p className={s.note}>
        Place = order among distinct market buyers after the creator, from the factory launch event and the token&apos;s transfers.
        {d.bought > d.considered ? ` Only the newest ${d.considered} of ${d.bought} launches bought are checked.` : ""}
        {d.skipped ? ` ${d.skipped} of them ${d.skipped === 1 ? "isn't a launch" : "aren't launches"} from a vibe/vibe factory we read, so ${d.skipped === 1 ? "it isn't" : "they aren't"} placed.` : ""}
        {d.errors ? ` ${d.errors} couldn't be read now (retried later).` : ""}
        {d.reason ? ` Note: ${d.reason}.` : ""}
      </p>
    </section>
  );
}

/* ---------------- launches created ---------------- */

function Launches({ prof, ent }: { prof: WalletProfile; ent: EntriesResponse | null }) {
  const d = prof.dev;
  const addr = prof.wallet;
  // the profile carries the newest few only; the passport has them all
  const listCut = d.status === "ok" && d.launches.length > 0 && (d.total ?? Infinity) > d.launches.length;
  return (
    <section id="launches" className={s.card} aria-labelledby="w-dev">
      <Head id="w-dev" title="Launches created">
        <Link className={s.headLink} href={`/dev/${addr}`}>{listCut ? `Latest ${d.launches.length} of ${d.total ?? `${d.loaded}+`} · all on the dev passport →` : "Dev passport →"}</Link>
      </Head>
      {d.status !== "ok" ? (
        <p className={s.msg}>Unknown: {plain(d.reason)}.</p>
      ) : d.launches.length === 0 && d.coverage === "v1-only" ? (
        <p className={s.msg}>
          <span className={s.unk} title={UNK}>—</span> Not covered: taxed v6 launches couldn&apos;t be read right now, so this is unknown, not zero. No curve launches on vibe/vibe&apos;s list.
        </p>
      ) : d.launches.length === 0 ? (
        <p className={s.msg}>
          No launches on vibe/vibe&apos;s list.
          {ent?.ownLaunches ? ` But ${ent.ownLaunches} launch${ent.ownLaunches === 1 ? "" : "es"} it bought were created by this wallet (factory events): vibe's API hides some launches.` : ""}
        </p>
      ) : (
        <ShowMore count={d.launches.length} initial={ROWS} label={listCut ? "latest launches" : "launches"} className={s.more}>
          {(n) => (
            <ul className={s.rows}>
              {d.launches.slice(0, n).map((l) => (
                <li key={l.token} className={s.rowItem}>
                  <span>
                    {l.hidden ? <span className={s.dim}>${l.symbol || shortAddr(l.token)}</span> : <Link className={s.sym} href={`/line/${l.token}`}>${l.symbol || shortAddr(l.token)}</Link>}
                    <span className={s.tokName}>{date(l.createdAt)}{l.hidden ? " · hidden by vibe" : ""}</span>
                  </span>
                  <span className="num">
                    {l.graduated ? <span className={s.gradWord}>Graduated</span> : <><span className={s.bar}><i style={{ width: `${Math.max(2, l.progressBps / 100)}%` }} /></span>{pctOf(l.progressBps / 100)}</>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ShowMore>
      )}
      {d.status === "ok" && (d.total ?? 0) > 0 && (
        <p className={s.note}>
          {d.total} launch{d.total === 1 ? "" : "es"}, {d.graduated} graduated{d.reason ? ` (${d.reason})` : ""}. <Term id="graduation">Graduation</Term>: the curve reached its target (5 ETH, 4 ETH on taxed v6). Dev sells, timing and linked wallets are on the dev passport.
        </p>
      )}
    </section>
  );
}

/* ---------------- farm peers ---------------- */

function FarmPeers({ farm }: { farm: { id: number; size: number; peers: string[] } }) {
  return (
    <section className={s.card} aria-labelledby="w-farm">
      <Head id="w-farm" title={<>Farm #{farm.id}</>}>
        <span className={s.sub}>{farm.size} wallets</span>
      </Head>
      <p className={s.note}><Term id="farm">Farm wallets</Term> keep buying the first minutes of the same launches together. Often one operator.</p>
      <ShowMore count={farm.peers.length} initial={8} label="wallets" className={s.more}>
        {(n) => (
          <ul className={s.sibs}>
            {farm.peers.slice(0, n).map((a) => <li key={a} className={s.sib}><WalletLink a={a} /></li>)}
          </ul>
        )}
      </ShowMore>
    </section>
  );
}
