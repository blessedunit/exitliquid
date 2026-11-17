import type { Metadata } from "next";
import Link from "next/link";
import PageHead from "@/components/PageHead";
import { GLOSSARY, GLOSSARY_ORDER, type GlossaryId } from "@/lib/glossary";
import { POINTS, RULES } from "@/lib/screener-rules";
import { GRADE_WORD, NO_GRADE_WORD } from "@/lib/screener-types";
import styles from "./methodology.module.css";

// The one reference page: how the grade is computed (the numbers come from lib/screener-rules.ts, so the page
// can't drift from the code), what each tile on a token page means, and the rest of the site's words.
export const metadata: Metadata = {
  title: "How grades work",
  description: "How Exit Liquidity grades a vibe/vibe token A–F: the risk of becoming someone's exit liquidity, the red flags, the gates, what each tile means and the terms the site uses.",
  alternates: { canonical: "/methodology" },
};

const R = RULES;
const X = POINTS;

// finding -> level and points off. Red caps the letter at D; critical (or two reds) makes it F.
const COSTS: [string, string, string][] = [
  [`The dev bought ${R.PUMP_BOUGHT}%+ of supply and sold ${R.PUMP_SOLD}%+ of it (a dev pump)`, "critical", `−${X.devPump}`],
  [`Dev holds ${R.DEV_HOLDS_CRIT}%+ of supply`, "critical", `−${X.devHoldsCrit}`],
  [`Dev holds ${R.DEV_HOLDS_BAD}%+ of supply`, "red", `−${X.devHoldsBad}`],
  [`Dev holds ${R.DEV_HOLDS_WARN}%+ of supply`, "warning", `−${X.devHoldsWarn}`],
  [`Dev sold ${R.DEV_SOLD_WARN}%+ of supply`, "warning", `−${X.devSoldWarn}`],
  [`... and took ${R.DEV_ETH_OUT_BAD}+ ETH more out than he put in`, "red", `−${X.devSoldBad}`],
  ["Dev moved tokens to other wallets", "warning", `−${X.devMoved}`],
  [`Another wallet bought ${R.PUMP_BOUGHT}%+ of supply and sold ${R.PUMP_SOLD}%+ of it (a pump)`, "red + gate", `−${X.pump}`],
  [`One wallet made ${R.GATE_TOP1}%+ of the volume`, "warning + gate", `−${X.top1Gate}`],
  [`One wallet made ${R.TOP1_WARN}%+ of the volume`, "warning", `−${X.top1Warn}`],
  [`Under ${R.REAL_BAD}% of volume is real while one wallet makes ${R.TOP1_WARN}%+ of it`, "red", `−${X.realBad}`],
  [`Under ${R.REAL_WARN}% of volume is real (${R.MIN_VOL_TRADES}+ trades)`, "warning", `−${X.realWarn}`],
  [`One holder (not the dev, not the curve or pool) has ${R.WHALE_BAD}%+ of supply`, "red", `−${X.whale}`],
  [`Top 10 hold ${R.TOP10_CIRC_WARN}%+ of what holders hold (${R.GATE_HOLDERS}+ real holders)`, "warning", `−${X.top10Circ}`],
  [`Snipers and farm wallets still hold ${R.SNIPERS_HOLD_WARN}%+ of supply`, "warning", `−${X.snipersHold}`],
  [`Bundled wallets still hold ${R.BUNDLE_HELD_WARN}%+ of supply`, "warning", `−${X.bundleHeld}`],
  [`Late entry: price ${R.LATE_X}× launch or more, holders in profit`, "warning", `−${X.late}`],
  [`Graduated with a dead pool: under ${R.POOL_MIN_ETH} ETH, no trade in 24 h, or under ${R.POOL_MIN_HOLDERS} real holders`, "warning + gate", `−${X.deadPool}`],
  [`Under ${R.GATE_HOLDERS} real holders or under ${R.GATE_TRADES24} trades in 24 h`, "warning + gate", `−${X.thinActivity}`],
];

// the six tiles of a token page; a row with a glossary id is that word's anchor (the glossary below skips it)
const TILES: [string, string, GlossaryId | null][] = [
  ["Snipers", "Known sniper and farm wallets among the first 20 buyers.", "snipers"],
  ["Bundled", "Share of supply bought by 2+ wallets in the same transaction or block, among the first 100 buys.", "bundle"],
  ["Top 10", "Share of supply the ten largest holders have. The curve, the pool and burned tokens are not holders.", null],
  ["Dev holds", "Share of supply the creator still has, and whether the creator ever sold.", "dev-bag"],
  ["Real vol", "Share of 24 h volume left after wash trades and known-bot trades are taken out.", "real-volume"],
  ["In profit", "Share of supply held by wallets that would sell above their cost after the fee.", null],
];
const IN_TILES = new Set<GlossaryId>(TILES.flatMap(([, , id]) => (id ? [id] : [])));

const FAQ: [string, React.ReactNode][] = [
  ["Where does the data come from?", "Trades, balances and curve progress are read from Robinhood Chain testnet logs. Names, logos and launch lists come from the vibe/vibe API. Funders come from the Blockscout explorer."],
  ["How fresh are sniper labels?", <>The wallet index is rebuilt every hour. A new bot can trade before it is labelled. Labels older than 14 days are not used. Source freshness is on <Link href="/status">Status</Link>.</>],
];

function Sec({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className={styles.card} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <section>
      <div className="wrap">
        <PageHead title="How grades work">One grade per token, A to F. The same letter on Launches, in Rankings and on the token page.</PageHead>

        <div className={styles.main}>
          <Sec id="grade" title="The grade">
            <p>The letter is the risk of becoming someone&rsquo;s exit liquidity if you buy now. A reads &ldquo;{GRADE_WORD.A}&rdquo;, B &ldquo;{GRADE_WORD.B}&rdquo;, C &ldquo;{GRADE_WORD.C}&rdquo;, D &ldquo;{GRADE_WORD.D}&rdquo;, F &ldquo;{GRADE_WORD.F}&rdquo;. Next to it: <b>Full check</b> when every input was read, or <b>Partial</b> with what wasn&rsquo;t checked.</p>
            <table className={styles.table}>
              <thead><tr><th scope="col">Finding</th><th scope="col">Level</th><th scope="col">Points</th></tr></thead>
              <tbody>
                {COSTS.map(([what, level, cost]) => (
                  <tr key={what}><td>{what}</td><td>{level}</td><td className={styles.num}>{cost}</td></tr>
                ))}
              </tbody>
            </table>
            <p>Points are counted by family (dev, volume, concentration, front, price, activity): the biggest finding of a family counts in full, the rest a quarter, at most {R.FAMILY_CAP} per family. Then the letter:</p>
            <p className={styles.scale}>
              <span className={styles.gA}>A 85+</span><span className={styles.gB}>B 70+</span><span className={styles.gC}>C 55+</span><span className={styles.gD}>D under 55</span>
            </p>
            <ul className={styles.list}>
              <li>A critical finding, or two red ones: F. F is never given for points alone.</li>
              <li>One red finding: D at best.</li>
              <li>Any gate: C at best. A and B also need every gate read: holders, 24 h trades, the volume split and the biggest seller.</li>
              <li>A needs a full check and no warning at all. Otherwise B at best.</li>
            </ul>
            <p>A <b>pump</b> is one wallet buying a big share of the curve and dumping it back, often into the fresh pool seconds after graduation. It leaves an empty pool, a handful of holders and a price below launch. Most tokens that used to look clean were exactly this.</p>
            <p><b>Late entry</b>: the further the price already runs above launch, the more likely it drops next. In our backtest a 20%+ drop followed in 76–87% of tokens priced 1.3–2.4× launch, and in 3–15% of those still near it.</p>
            <p><b>Real holders</b> bought on the market and hold more than dust. Airdrop-only and dust wallets are left out everywhere a holder count is shown; the full count is in the tooltip.</p>
            <p>Snipers, bundles and the dev&rsquo;s other launches are shown as information. In our backtest they went with demand, not against it, so they cost points only while snipers or bundles still hold a big share of supply.</p>
            <p>No letter: &ldquo;{NO_GRADE_WORD.young}&rdquo; (under {R.MIN_AGE_MIN} minutes old), &ldquo;{NO_GRADE_WORD.thin}&rdquo; (under {R.THIN_HOLDERS} real holders, {R.THIN_TRADES} trades or {R.MIN_FRONT} first buyers), &ldquo;{NO_GRADE_WORD.unread}&rdquo; (holders, trades or first buyers could not be read). A red finding grades the token anyway.</p>
            <p>A read that failed takes no points, earns no praise and never passes a gate. Praise needs a full read: &ldquo;N% of volume is real&rdquo; only when no wallet makes {R.TOP1_WARN}%+ of it and wash was timed.</p>
          </Sec>

          <Sec id="tiles" title="The tiles">
            <dl className={styles.terms}>
              {TILES.map(([k, v, id]) => (
                <div key={k} id={id ?? undefined}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </Sec>

          <Sec id="glossary" title="Glossary">
            <dl className={styles.terms}>
              {GLOSSARY_ORDER.filter((id) => !IN_TILES.has(id)).map((id) => (
                <div key={id} id={id}><dt>{GLOSSARY[id].term}</dt><dd>{GLOSSARY[id].short}</dd></div>
              ))}
            </dl>
          </Sec>

          <Sec id="faq" title="Questions">
            <dl className={styles.terms}>
              {FAQ.map(([q, a]) => (
                <div key={q}><dt>{q}</dt><dd>{a}</dd></div>
              ))}
            </dl>
          </Sec>
        </div>
      </div>
    </section>
  );
}
