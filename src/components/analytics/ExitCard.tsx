"use client";
// "Who's selling to you": how much can be sold before the price drops 10%, the current line by entry multiple,
// what happens to the price if everyone in profit sold now, break-even for a new buyer after both 1.25% fees,
// and price impact by size. Open to everyone, the full impact table included.
import { fmtCompact, fmtEth, fmtInt } from "@/lib/format";
import type { AnalyticsState } from "./useTokenAnalytics";
import { Card, Pending, pct, Source } from "./bits";
import s from "./analytics.module.css";

const wallets = (n: number) => `${fmtInt(n)} wallet${n === 1 ? "" : "s"}`;

export default function ExitCard({ state }: { state: AnalyticsState }) {
  const f = state.a?.exitMath;
  const d = f?.data;
  const mcap = state.a?.market.data?.mcapEth ?? null;
  // on a bonding curve "everyone in profit sells" only walks the curve back down: a number, not an alarm
  const dumpCls = d && d.venue === "pool" && d.dumpPricePct !== null && d.dumpPricePct <= -50 ? s.bad : undefined;
  return (
    <Card
      id="an-exit"
      title="Who's selling to you"
      term="exit-math"
      sub={d ? <span title={`${fmtInt(d.inLine)} wallets in line, priced on the ${d.venue === "pool" ? "V4 pool" : "bonding curve"}`}>{d.venue === "pool" ? "V4 pool" : "curve"}</span> : "line by entry multiple"}
      src={f && d ? f : null}
      stale={state.stale}
      loading={!d && state.trouble === "loading"}
    >
      {!d || !f ? (
        <Pending state={state} reason={f?.reason} reading="Pricing the line…" />
      ) : (
        <>
          <div className={s.hero}>
            <p className={s.big} title={d.maxSell10 ? `Selling ${fmtCompact(d.maxSell10.tokens)} tokens moves the spot price by -10%.${d.maxSell10.capped ? " The curve can't pay more than it holds." : ""}` : undefined}>
              <b>{d.maxSell10 ? `≈${fmtEth(d.maxSell10.eth)} ETH` : "—"}</b>
              <span>of sells drop the price 10%</span>
            </p>
            <p className={s.line2}>
              {d.profitHolders
                ? <><b>{fmtInt(d.profitHolders)}</b> of {fmtInt(d.inLine)} wallets in line are in profit. If they all sold now: <b className={dumpCls}>{pct(d.dumpPricePct)}</b>{d.dumpEthOut !== null && <> · ≈<b>{fmtEth(d.dumpEthOut)} ETH</b> out</>} · <b>{pct(d.profitSupplyPct)}</b> of supply.</>
                : d.dumpNote ?? "Nobody in profit after fees."}
            </p>
            {d.dumpNote && d.profitHolders > 0 && <p className={s.line2}>{d.dumpNote}</p>}
          </div>

          <div className={s.bar} role="img" aria-label={d.buckets.map((b) => `${b.label}: ${wallets(b.holders)}, ${pct(b.linePct)} of the line's tokens`).join("; ")}>
            {d.buckets.map((b) => b.linePct > 0 && <i key={b.id} className={s[`m_${b.id}`]} style={{ width: `${b.linePct}%` }} title={`${b.label}: ${wallets(b.holders)} · ${pct(b.linePct)} of tokens in line`} />)}
          </div>
          <dl className={s.legend}>
            {d.buckets.map((b) => (
              <div key={b.id} className={s[`k_${b.id}`]}>
                <dt>{b.label}</dt>
                <dd>{pct(b.linePct)}</dd>
                <dd className={s.legendSub}>{wallets(b.holders)}</dd>
              </div>
            ))}
          </dl>
          {d.noCostHolders > 0 && (
            <p className={s.line2} title="These bags came by transfer from a wallet whose cost we can't price: their multiple is unknown, so they are in neither the bar nor the dump.">
              {wallets(d.noCostHolders)} got their bag by transfer, cost unknown: left out.
            </p>
          )}

          <dl className={s.kv}>
            <div title={`A new ${d.breakEvenSize} ETH buy pays 1.25% in, 1.25% out and its own price impact. This is how far the price must rise before selling those tokens returns ${d.breakEvenSize} ETH.`}>
              <dt>Break-even · {d.breakEvenSize} ETH</dt>
              <dd>{pct(d.breakEvenPct, true)}</dd>
            </div>
            <div title="New buys from other people needed to lift the price that far (fees included).">
              <dt>New money needed</dt>
              <dd>{d.breakEvenEth === null ? <span className={s.dim}>—</span> : `≈${fmtEth(d.breakEvenEth)} ETH`}</dd>
            </div>
            <div title="The two 1.25% fees alone, with no price impact.">
              <dt>Fees alone</dt>
              <dd>{pct(d.feesOnlyPct, true)}</dd>
            </div>
          </dl>

          <h4 className={s.subHead}>Price impact by size</h4>
          <div className={s.tblWrap}>
            <table className={s.tbl}>
              <caption className="srOnly">Price impact by trade size{mcap !== null ? `, MCAP ${fmtEth(mcap)} ETH` : ""}</caption>
              <thead>
                <tr><th scope="col">Size</th><th scope="col" className={s.narrowHide}>Buy gets</th><th scope="col" title="Average price paid over spot, fee included">Buy cost</th><th scope="col" title="Spot after the buy">After buy</th><th scope="col" title="Spot after selling tokens worth this much ETH">After sell</th></tr>
              </thead>
              <tbody>
                {d.impact.map((r) => (
                  <tr key={r.eth} title={r.note ?? (r.quoted ? "Buy priced by the contract's own quote" : "Priced by the reserve model")}>
                    <td className={s.rowHead}>{r.eth} ETH</td>
                    <td className={s.narrowHide}>{r.buyTokens === null ? <span className={s.dim}>—</span> : fmtCompact(r.buyTokens)}</td>
                    <td>{pct(r.buyImpactPct, true)}</td>
                    <td className={s.up}>{pct(r.buyPriceAfterPct, true)}</td>
                    <td className={r.sellPriceAfterPct === null ? s.dim : s.down}>{pct(r.sellPriceAfterPct, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Source reason={f.reason} />
        </>
      )}
    </Card>
  );
}
