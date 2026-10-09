"use client";
// "Supply": the top-10 share without the curve / pool / protocol, gifted bags (came by transfer, not a buy),
// fresh wallets (first ETH < 24 h before their first buy), low-nonce wallets and the dev's record.
// One top-10 figure on the page: the share of what HOLDERS hold (curve and pool left out); the share of total
// supply is only in the tooltip. The wallet rows live in ONE list on the page: Top holders (TopHolders.tsx),
// which also carries these per-wallet flags. Open to everyone.
import { fmtInt, shortAddr } from "@/lib/format";
import type { AnalyticsState } from "./useTokenAnalytics";
import { Addr, Card, Pending, pct, Source, Tag } from "./bits";
import s from "./analytics.module.css";


const times = (n: number) => `${n}×`;
const Dash = ({ why }: { why: string }) => <span className={`${s.dim}`} title={`${why}. Unknown, not zero.`}>—</span>;

export default function SupplyCard({ state, onSelect }: { state: AnalyticsState; onSelect?: (w: string) => void }) {
  const f = state.a?.supply;
  const d = f?.data;
  // funding (fresh) not read yet for the top holders (holders.ts still loading): only then is "checking" true.
  // Otherwise an unknown top-10 wallet is faucet / bridge funded or gifted: no later check will change it.
  const checking = !!f?.reason?.includes("Funding");
  const top = d?.top10.length ?? 0;
  const freshUnknown = d ? Math.max(0, top - d.freshChecked) : 0;
  const nonceUnknown = d ? Math.max(0, top - d.lowNonceChecked) : 0;
  const venue = state.a?.graduated ? "pool" : "curve";
  return (
    <Card id="an-supply" title="Supply" term="dev-bag" sub={d ? `${fmtInt(d.holders)} holders` : "who holds it"} src={f && d ? f : null} stale={state.stale} loading={!d && state.trouble === "loading"}>
      {!d || !f ? (
        <Pending state={state} reason={f?.reason} reading="Reading holders…" />
      ) : (
        <>
          <div className={s.hero}>
            <p className={s.big} title={`${pct(d.top10Pct)} of total supply. The ${venue} holds ${pct(d.marketPct)} and is left out.`}>
              <b className={d.top10OfCirculatingPct >= 60 ? s.bad : undefined}>{pct(d.top10OfCirculatingPct)}</b>
              <span>of what holders hold sits with the top 10</span>
            </p>
            <p className={s.line2}><b>{pct(d.marketPct)}</b> of supply sits in the {venue}, not with people.</p>
          </div>
          <dl className={s.kv}>
            <div title="Tokens that reached a wallet by transfer rather than a buy">
              <dt>Gifted</dt><dd className={d.giftedPct >= 10 ? s.strong : undefined}>{pct(d.giftedPct)}<small>{fmtInt(d.giftedHolders)} wallet{d.giftedHolders === 1 ? "" : "s"}</small></dd>
            </div>
            <div title="Top 10 wallets whose first ETH arrived less than 24 h before their first buy. Unknown: funded by the faucet or a bridge (no funding block), a gifted bag with no buy, or not read yet. Unknown is not 'not fresh'.">
              <dt>Fresh · top 10</dt>
              <dd>
                {d.freshTop10 === null ? (checking ? <Dash why="Still reading" /> : <Dash why="Funding unknown for every top holder (faucet / bridge funded or not read)" />) : `${d.freshTop10} fresh`}
                {top > 0 && freshUnknown > 0 && <small>{checking ? `${freshUnknown} still checking` : `${freshUnknown} unknown`}</small>}
              </dd>
            </div>
            <div title="Top 10 wallets that sent 2 transactions or fewer. Unknown: nonce not read.">
              <dt>≤2 tx · top 10</dt>
              <dd>
                {d.lowNonceTop10 === null ? <Dash why="Nonce not read" /> : `${d.lowNonceTop10}`}
                {d.lowNonceTop10 !== null && nonceUnknown > 0 && <small>{nonceUnknown} not read</small>}
              </dd>
            </div>
            <div title="What the creator holds now, % of total supply">
              <dt>Dev holds</dt><dd className={d.creatorPct !== null && d.creatorPct >= 5 ? s.strong : undefined}>{d.creatorPct === null ? <Dash why="Creator balance not read" /> : pct(d.creatorPct)}</dd>
            </div>
            <div title="The creator's sells, whole history">
              <dt>Dev sold</dt><dd className={d.devSells ? s.down : undefined}>{d.devSells === null ? <Dash why="Start of history unknown" /> : times(d.devSells)}</dd>
            </div>
            <div title="Wallets the creator handed tokens to (not a sale), whole history. Can be a quiet way to sell later.">
              <dt>Dev moved to</dt><dd className={d.devMovedTo ? s.strong : undefined}>{d.devMovedTo === null ? <Dash why="Start of history unknown" /> : `${d.devMovedTo}`}{d.devMovedTo !== null && <small>wallet{d.devMovedTo === 1 ? "" : "s"}</small>}</dd>
            </div>
          </dl>

          {d.gifters.length > 0 && (
            <>
              <h4 className={s.subHead}>Handed tokens to 3+ wallets</h4>
              <ol className={s.list}>
                {d.gifters.map((g, i) => (
                  <li key={g.wallet} className={s.row}>
                    <span className={s.rank}>{i + 1}</span>
                    <span className={s.who}>
                      <Addr wallet={g.wallet} onSelect={onSelect}>{shortAddr(g.wallet)}</Addr>
                      {g.isCreator && <Tag>Dev</Tag>}
                    </span>
                    <span className={s.right}>→ {g.to} wallets <span className={s.rank}>{pct(g.pct)}</span></span>
                  </li>
                ))}
              </ol>
            </>
          )}

          <Source reason={f.reason} />
        </>
      )}
    </Card>
  );
}
