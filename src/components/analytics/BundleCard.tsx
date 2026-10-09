"use client";
// "Bundle check": among the first 100 buys, wallets that bought in the same tx or the same block,
// with the tx hashes as proof, plus the launch rush (first-minute buyers) and the sniper count from Line Health.
// Open to everyone: the shares, the counts and every group with its wallets and tx links.
// "No same-block buys" is not a clean bill: snipers buying in separate blocks don't show here (Line Health does).
import { fmtInt, shortAddr } from "@/lib/format";
import type { BundleGroup } from "@/lib/analytics/types";
import { SNIPERS_HIGH, SNIPERS_MEDIUM } from "@/lib/health";
import { jumpTo, type AnalyticsState } from "./useTokenAnalytics";
import { Addr, Card, Pending, pct, Source, Tag, txUrl } from "./bits";
import s from "./analytics.module.css";

const KIND: Record<BundleGroup["kind"], { text: string; tone: "bad" | "warn"; hint: string }> = {
  tx: { text: "Same tx", tone: "bad", hint: "One transaction bought for several wallets" },
  launch: { text: "Launch block", tone: "bad", hint: "Bought in the block the token was created" },
  block: { text: "Same block", tone: "warn", hint: "3+ wallets (or 0.5%+ of supply) bought in one block (~0.18 s)" },
};
const SHOW_GROUPS = 8;

export default function BundleCard({ state, onSelect }: { state: AnalyticsState; onSelect?: (w: string) => void }) {
  const f = state.a?.bundle;
  const d = f?.data;
  const h = state.a?.health ?? null;
  const counts = d ? { tx: d.groups.filter((g) => g.kind === "tx").length, block: d.groups.filter((g) => g.kind !== "tx").length } : null;
  // nothing found at all: one line in words instead of a grid of zeros (a partial read says so)
  const none = !!d && !!counts && d.wallets === 0 && counts.tx === 0 && counts.block === 0 && d.launchBlockBuyers === 0;
  const snipers = h?.snipers != null && (
    <p className={s.line2}>
      Known snipers in the first {h.firstBuyers}: <b className={h.snipers >= SNIPERS_HIGH ? s.bad : h.snipers >= SNIPERS_MEDIUM ? s.strong : undefined}>{h.snipers}</b>{" "}
      <button type="button" className={s.chipNote} onClick={() => jumpTo("health-title")}>Line health →</button>
    </p>
  );
  return (
    <Card
      id="an-bundle"
      title="Bundle check"
      term="bundle"
      sub={d ? `first ${d.scanned} buys` : "first 100 buys"}
      src={f && d ? f : null}
      stale={state.stale}
      loading={!d && state.trouble === "loading"}
    >
      {!d || !f ? (
        <Pending state={state} reason={f?.reason} />
      ) : (
        <>
          {none ? (
            <div className={s.hero}>
              <p className={s.noneLine}>
                {/* partial = the start of the history couldn't be read (f.reason is about the funding lookup) */}
                {d.firstMinuteBuyers === null
                  ? <>None found so far (partial read).</>
                  : <><span className={s.tick} aria-hidden>✓</span>No bundled buys among the first {d.scanned}.</>}
              </p>
              <p className={s.line2}>
                Same-tx and same-block buys only: snipers buying in separate blocks don&apos;t show here.
                {d.firstMinuteBuyers !== null ? <> <b>{fmtInt(d.firstMinuteBuyers)}</b> wallets bought in the first minute.</> : null}
              </p>
              {snipers}
            </div>
          ) : (<>
          <div className={s.hero}>
            {d.wallets ? (
              <>
                <p className={s.big}>
                  <b className={d.heldPct >= 15 ? s.bad : undefined}>{pct(d.heldPct)}</b>
                  <span>of supply still held by grouped buyers</span>
                </p>
                <p className={s.line2}>
                  <b>{fmtInt(d.wallets)}</b> wallets bought <b>{pct(d.boughtPct)}</b> in shared txs or blocks{d.heldPct < 1 && d.boughtPct >= 1 ? " and have mostly sold" : ""}.
                </p>
              </>
            ) : (
              <>
                <p className={s.big}><b>None</b><span>no same-tx or same-block buys among the first {d.scanned}</span></p>
                <p className={s.line2}>Same-tx / same-block only: snipers buying in separate blocks don&apos;t show here.</p>
              </>
            )}
            {snipers}
          </div>

          <dl className={s.kv}>
            <div title="One transaction that bought for several wallets: the strongest bundle sign">
              <dt>Same-tx groups</dt><dd>{counts!.tx}</dd>
            </div>
            <div title="3+ wallets (or 0.5%+ of supply) in one block, dust buys left out. Blocks are ~0.18 s, so this is weaker than one tx.">
              <dt>Same-block groups</dt><dd>{counts!.block}</dd>
            </div>
            <div title="Wallets other than the creator that bought in the creation block">
              <dt>Launch-block buyers</dt><dd>{d.launchBlockBuyers}</dd>
            </div>
            <div title="Wallets (creator excluded) that bought within 60 seconds of the first buy, whole history">
              <dt>First-minute buyers</dt><dd>{d.firstMinuteBuyers === null ? <span className={s.dim} title="Start of history unknown">—</span> : d.firstMinuteBuyers}</dd>
            </div>
            <div title="Grouped wallets that are also in a top-holder funding cluster (only top holders get a funding lookup)">
              <dt>Shared funder</dt>
              <dd>{d.sameFunderWallets === null || !d.funderChecked ? <span className={s.dim} title={d.sameFunderWallets === null ? "Still reading" : "None of them is a top holder"}>—</span> : `${d.sameFunderWallets}/${d.funderChecked}`}</dd>
            </div>
            <div title="Distinct wallets among the first 100 buys">
              <dt>Buyers</dt><dd>{fmtInt(d.buyers)}</dd>
            </div>
          </dl>
          </>)}

          {d.groups.length > 0 && (
            <>
              <h4 className={s.subHead}>Groups and tx proof</h4>
              <ol className={s.list}>
                {d.groups.slice(0, SHOW_GROUPS).map((g, i) => <Group key={`${g.kind}-${g.block}-${i}`} g={g} onSelect={onSelect} />)}
              </ol>
              {d.groups.length > SHOW_GROUPS && <p className={s.note}>+{d.groups.length - SHOW_GROUPS} smaller groups</p>}
            </>
          )}
          <Source reason={f.reason} />
        </>
      )}
    </Card>
  );
}

function Group({ g, onSelect }: { g: BundleGroup; onSelect?: (w: string) => void }) {
  const k = KIND[g.kind];
  return (
    <li className={s.group}>
      <div className={s.groupTop}>
        <Tag tone={k.tone} title={k.hint}>{k.text} · block {g.block}</Tag>
        {g.sameFunder > 0 && <Tag tone="warn" title="Wallets in this group that share a first funder">{g.sameFunder} one funder</Tag>}
        <span className={s.right} title="Bought in these buys → held now, % of supply">{pct(g.boughtPct)} → {pct(g.heldPct)}</span>
      </div>
      <div className={s.txs}>
        {g.wallets.slice(0, 6).map((w) => <Addr key={w} wallet={w} onSelect={onSelect}>{shortAddr(w)}</Addr>)}
        {g.wallets.length > 6 && <span className={s.rank}>+{g.wallets.length - 6}</span>}
      </div>
      <div className={s.txs}>
        {g.txs.slice(0, 4).map((t) => <a key={t} href={txUrl(t)} target="_blank" rel="noreferrer">tx {t.slice(0, 10)} ↗</a>)}
        {g.txs.length > 4 && <span className={s.rank}>+{g.txs.length - 4} tx</span>}
      </div>
    </li>
  );
}
