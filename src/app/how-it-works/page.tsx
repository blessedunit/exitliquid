import type { Metadata } from "next";
import Link from "next/link";
import { EXIT_TOKEN, EXPLORER, IS_LIVE, X_LIVE, X_URL } from "@/lib/config";
import { TIERS } from "@/lib/queue";
import PageHead from "@/components/PageHead";
import { Portrait } from "@/components/Sprite";
import k from "../_kit/kit.module.css";

export const metadata: Metadata = {
  alternates: { canonical: "/how-it-works" },
  title: "How it works on-chain",
  description: "Where every line comes from and how places and points are computed.",
};

function Sec({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className={k.sec} aria-labelledby={id}>
      <h2 id={id} className={k.h2}>{title}</h2>
      <div className={k.doc}>{children}</div>
    </section>
  );
}

export default function HowItWorks() {
  return (
    <section>
      <div className="wrap">
        <div className={k.prose}>
          <PageHead title="How it works">Where the lines come from and how places and points are counted.</PageHead>

          <Sec id="try" title="Test it in 60 seconds">
            <ol>
              <li>
                Open the <Link href="/">token board</Link> and pick any token: its holders line up in buy order.
              </li>
              <li>
                Open <Link href="/lines">My lines</Link> and paste any holder&apos;s address.
              </li>
              <li>
                Watch the <Link href="/exit">$EXIT line</Link>: buys and sells hit the tape within ~30 s.
              </li>
            </ol>
            {(IS_LIVE || X_LIVE) && (
              <p className={k.meta}>
                {IS_LIVE && (
                  <>
                    Token:{" "}
                    <a className={k.code} href={`${EXPLORER}/token/${EXIT_TOKEN}`} target="_blank" rel="noreferrer">
                      {EXIT_TOKEN}
                    </a>
                  </>
                )}
                {IS_LIVE && X_LIVE && " · "}
                {X_LIVE && (
                  <>
                    X: <a href={X_URL} target="_blank" rel="noreferrer">{X_URL.replace("https://", "")}</a>
                  </>
                )}
              </p>
            )}
          </Sec>

          <Sec id="source" title="Data source">
            <ul>
              <li>Chain: Robinhood Chain testnet, read directly.</li>
              <li>
                ERC-20 <span className={k.code}>Transfer</span> events from the token&apos;s creation block. Transfers are locked until graduation, so every
                balance change is a buy or a sell against the curve (later, the DEX pool).
              </li>
              <li>
                Door %: read from the curve contract, <span className={k.code}>curveTokensRemaining()</span> against the curve supply.
              </li>
            </ul>
          </Sec>

          <Sec id="line" title="The line">
            <ol>
              <li>Events replay in order (block, then log index). Transfers of one wallet inside one transaction are netted, so routers never stand in line.</li>
              <li>A wallet joins the end once the ETH paid for the tokens it still holds reaches 0.0003. Only bought tokens count. Partial sells lower that amount pro rata. In the first hour the place holds only at 0.00015 ETH+.</li>
              <li>A first entry of 0.003 ETH+ gives +1 point to everyone already in line. A 0.0003 ETH buy gets a place but no points. If the newcomer walks out within ~1 h, the point is taken back.</li>
              <li>
                Sell 95% of the peak bag (or drop under 5,000 tokens) and you exit: your points split evenly among everyone behind, they move up, and the exit
                goes to the Hall of Exits (walk-ins who left within the hour are skipped).
              </li>
              <li>Buying again after an exit = a new entry at the end, 0 points, no points for anyone.</li>
              <li>Protocol contracts (curve, pool manager, router, locker, treasury, zero address) are never people.</li>
              <li>Points can&apos;t be transferred. The funded-entry rule and one-hour clawback make farming costly.</li>
            </ol>
          </Sec>

          <Sec id="ranks" title="Ranks, by what your bag is worth now">
            <table className={k.table}>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Trader</th>
                  <th scope="col" className={k.r}>Bag</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((t) => (
                  <tr key={t.tier}>
                    <td>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
                        <Portrait skin={t.skin} size={28} />
                        <span className={`${k.num} ${k.dim}`}>{t.tier}</span>
                      </span>
                    </td>
                    <td>{t.name}</td>
                    <td className={k.n}>{t.minEth === 0 ? "any bag" : `≥ ${t.minEth} ETH`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Sec>

          <Sec id="mood" title="Market Mood and stock pockets">
            <p>
              Daily change of TSLA, AMZN, PLTR, NFLX and AMD (Yahoo Finance, CNBC fallback). An average below −0.5% is a red day: panic at the door. Wallets
              holding testnet stock tokens from the faucet get a Stock pockets badge (read with <span className={k.code}>balanceOf</span>).
            </p>
          </Sec>

          <Sec id="never" title="What the site never does">
            <ul>
              <li>It never asks you to send a transaction. Connecting only shares your address.</li>
              <li>It never holds or moves your tokens.</li>
            </ul>
          </Sec>
        </div>
      </div>
    </section>
  );
}
