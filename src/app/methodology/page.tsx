import type { Metadata } from "next";
import Link from "next/link";
import PageHead from "@/components/PageHead";
import { GLOSSARY, GLOSSARY_ORDER, type GlossaryId } from "@/lib/glossary";
import { RULES } from "@/lib/screener-rules";
import styles from "./methodology.module.css";

// The one reference page: how the grade is computed (the numbers come from lib/screener-rules.ts, so the page
// can't drift from the code), what each tile on a token page means, and the rest of the site's words.
export const metadata: Metadata = {
  title: "How grades work",
  description: "How Exit Liquidity grades a vibe/vibe token A–F: the score, the caps, what each tile means and the terms the site uses.",
  alternates: { canonical: "/methodology" },
};

const R = RULES;
const share = (v: number) => `${Math.round(v * 100)}%`;

// finding -> points off; "red" findings also cap the letter
const COSTS: [string, string][] = [
  [`Dev sold ${R.DEV_SOLD_SOME}%+ of the bag`, `−5 · ${R.DEV_SOLD_WARN}%+ −15 · ${R.DEV_SOLD_BAD}%+ −30 (red)`],
  ["Dev moved tokens to other wallets", "−5"],
  [`Dev holds ${R.DEV_HOLDS_WARN}%+ of supply`, `−10 · ${R.DEV_HOLDS_BAD}%+ −20 (red)`],
  ["Each known sniper among the first 20 buyers", `−3, up to −36 · ${R.SNIPERS_BAD}+, or ${share(R.SNIPERS_SHARE_BAD)} of 10+ buyers, is red`],
  [`${R.FARM_WARN}+ farm wallets among the first buyers`, `−10 · ${R.FARM_BAD}+ −20 (red)`],
  [`Bundles bought ${R.BUNDLE_WARN}%+ of supply`, `−10 · ${R.BUNDLE_BAD}%+ −20 (red)`],
  [`Top 10 hold ${R.TOP10_WARN}%+ of supply (${R.MIN_HOLDERS}+ holders)`, `−10 · ${R.TOP10_BAD}%+ −20 (red)`],
  [`Under ${R.REAL_WARN}% of volume is real (${R.MIN_VOL_TRADES}+ trades)`, `−10 · under ${R.REAL_BAD}% −20 (red)`],
  [`Dev has ${R.TRACK_WARN_LAUNCHES}+ other launches, none graduated`, `−8 · ${R.TRACK_BAD_LAUNCHES}+ with under ${share(R.TRACK_BAD_RATE)} graduated −15 (red)`],
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
            <p>Every token starts at 100. Each finding takes points off.</p>
            <table className={styles.table}>
              <thead><tr><th scope="col">Finding</th><th scope="col">Points</th></tr></thead>
              <tbody>
                {COSTS.map(([what, cost]) => (
                  <tr key={what}><td>{what}</td><td className={styles.num}>{cost}</td></tr>
                ))}
              </tbody>
            </table>
            <p className={styles.scale}>
              <span className={styles.gA}>A 85+</span><span className={styles.gB}>B 70+</span><span className={styles.gC}>C 55+</span><span className={styles.gD}>D 40+</span><span className={styles.gF}>F under 40</span>
            </p>
            <p>A and B read “Looks clean”, C “Caution”, D and F “High risk”. Then the caps apply:</p>
            <ul className={styles.list}>
              <li>Any red finding: C at best.</li>
              <li>{R.SNIPERS_WARN}+ snipers, or {share(R.SNIPERS_SHARE_WARN)} of {R.MIN_FRONT}+ first buyers: C at best.</li>
              <li>Fewer than {R.MIN_HOLDERS} holders: C at best.</li>
              <li>Snipers not checked (the token is older than the sniper labels cover, or the labels are unavailable): B at best.</li>
              <li>Dev history not checked: B at best.</li>
              <li>Dev sold {R.DEV_DUMPED}%+ of the bag: D at best.</li>
            </ul>
            <p>No grade (“Too early to grade”): under {R.MIN_AGE_MIN} minutes old, fewer than {R.MIN_TRADES} trades, fewer than {R.MIN_FRONT} first buyers, or the holders could not be read.</p>
            <p>A read that failed takes no points and earns no praise. Good reasons need a sample: {R.MIN_FRONT}+ first buyers for “No known snipers”, {R.TOP10_GOOD_HOLDERS}+ holders for a low top 10, {R.TRACK_GOOD_LAUNCHES}+ other launches for a good dev record.</p>
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
