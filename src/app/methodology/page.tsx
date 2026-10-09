import type { Metadata } from "next";
import Link from "next/link";
import PageHead from "@/components/PageHead";
import SectionTabs from "@/components/ui/SectionTabs";
import { DISCLAIMER, EXPLORER, GITHUB_URL, PUBLIC_RPC_URL, VIBE_APP } from "@/lib/config";

import { earlyIndex } from "@/lib/earlyIndex";
import styles from "./methodology.module.css";

export const metadata: Metadata = {
  title: "Methodology",
  description: "How Exit Liquidity computes Line Health, sniper and farm labels, bundles, exit math, real volume and graduation ETA. Signals, not verdicts.",
};

// the Early Index numbers below come from the file ops/early_index.py rewrites every hour (lib/earlyIndex):
// the page is regenerated at most every 10 min instead of being frozen at build time
export const revalidate = 600;

const fmt = (n: number) => n.toLocaleString("en-US");

const TOC: [string, string][] = [
  ["principles", "Principles"],
  ["line", "The line"],
  ["health", "Line Health"],
  ["index", "Early Index"],
  ["clusters", "Bundles & funders"],
  ["exit", "Exit math"],
  ["volume", "Real volume"],
  ["eta", "Graduation ETA"],
  ["sources", "Sources & freshness"],
];

function Card({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className={styles.card} aria-labelledby={`${id}-h`}>
      <div className={styles.head}>
        <h2 id={`${id}-h`}>{title}</h2>
        <a href={`#${id}`} className={styles.anchor} aria-label={`Link to ${title}`}>#</a>
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  const IX = earlyIndex();
  const builtOn = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(IX.generatedAt * 1000);
  return (
    <section>
      <div className="wrap">
        <PageHead title="Methodology">How every number is computed, where it comes from, and what it can&apos;t tell you.</PageHead>

        {/* phones: the side contents become a sticky, sideways-scrolling tab row */}
        <SectionTabs items={TOC.map(([id, label]) => ({ id, label }))} label="On this page" className={styles.phoneTabs} />

        <div className={styles.layout}>
          <nav className={styles.toc} aria-label="On this page">
            <p className={styles.tocHead}>On this page</p>
            <ol>
              {TOC.map(([id, label]) => (
                <li key={id}><a href={`#${id}`}>{label}</a></li>
              ))}
            </ol>
            <Link href="/status" className={styles.statusLink}>Live status →</Link>
          </nav>

          <div className={styles.main}>
            {/* inside the content column: lines up with the cards, not with the contents list */}
            <aside className={styles.tldr} aria-label="In 30 seconds">
              <p className={styles.tldrHead}>In 30 seconds</p>
              <p>
                We read every vibe/vibe launch from the chain and flag four things: <b>who bought first</b> (snipers, farms, bundles), <b>what the dev did with their bag</b>,
                <b> whether the volume is real</b>, and <b>what selling would return</b>. A flag is a reason to look closer, not a verdict.
              </p>
            </aside>
            <Card id="principles" title="Principles">
              <ul className={styles.list}>
                <li><b>Signals, not verdicts.</b> A flag is a reason to look closer, never proof of intent. Plenty of fine tokens carry flags.</li>
                <li><b>Unknown is never zero.</b> When a source doesn&apos;t answer, the number shows as <span className={styles.mono}>—</span> with the reason, and a missing signal is never scored as clean.</li>
                <li><b>On-chain first.</b> Places, trades and balances are read from the chain&apos;s own logs, not from a third-party indexer.</li>
                <li><b>No advice.</b> Nothing here says buy or sell. Testnet tokens have no value.</li>
              </ul>
            </Card>

            <Card id="line" title="The line">
              <p>Every holder of a token is placed by their first real buy. A place needs <span className={styles.mono}>0.0003 ETH+</span> paid for tokens still held.</p>
              <p>A holder <b>walks out</b> when the bag falls to 5% of its peak or less, or under 5,000 tokens. Partial sells keep the place. Re-entries start a new place at the back.</p>
              <p className={styles.dim}>Source: Transfer logs of the token from its launch block, replayed in order. ~1 h is measured as 22,000 blocks (0.165 s per block).</p>
            </Card>

            <Card id="health" title="Line Health · A–F">
              <p>Who stands at the front of the line: the first 20 distinct buyers (the creator excluded). The score starts at 100.</p>
              <table className={styles.table}>
                <thead><tr><th scope="col">Signal</th><th scope="col">Points</th></tr></thead>
                <tbody>
                  <tr><td>Known sniper bots in the first 20 (6+ medium, 12+ high)</td><td className={styles.num}>−3 each, max −45</td></tr>
                  <tr><td>Wallets from a known farm group in the first 20</td><td className={styles.num}>−5 each (2+), max −25</td></tr>
                  <tr><td>Dev sold on the curve or pool</td><td className={styles.num}>−15</td></tr>
                  <tr><td>Dev moved tokens to other wallets</td><td className={styles.num}>−10</td></tr>
                  <tr><td>First 20 who sold 95%+ within ~1 h</td><td className={styles.num}>up to −20, by share</td></tr>
                  <tr><td>Under 30% of the first 20 still hold</td><td className={styles.num}>−10</td></tr>
                  <tr><td>Verified-early wallets in the first 50</td><td className={styles.num}>+5 each, max +10</td></tr>
                </tbody>
              </table>
              <p className={styles.scale}>
                <span className={styles.gA}>A ≥85</span><span className={styles.gB}>B ≥70</span><span className={styles.gC}>C ≥55</span><span className={styles.gD}>D ≥40</span><span className={styles.gF}>F &lt;40</span>
              </p>
              <p>Any <b>high</b>-severity reason (12+ snipers, dev sold, a big farm group, half the first 20 out within an hour) caps the letter at <b>C</b>, whatever the score.</p>
              <p>A signal that can&apos;t be read (fewer than 5 buyers, launch block unknown, labels too old) scores 0 and marks the grade <b>Partial</b>.</p>
            </Card>

            <Card id="index" title="Early Index · snipers & farms">
              <p>A wallet index rebuilt every hour from every launch in a {IX.windowDays}-day window. Current build: <b>{fmt(IX.tokensScanned)}</b> launches, <b>{fmt(IX.snipers.length)}</b> sniper wallets, <b>{fmt(IX.farms.length)}</b> farm groups, built {builtOn} UTC.</p>
              <ul className={styles.list}>
                <li><b>Sniper</b>: bought among the first 20 of {IX.sniperMinTokens ?? 50}+ launches in the window, and picked graduating tokens no better than chance (base rate {((IX.baseGradRate ?? 0) * 100).toFixed(2)}%).</li>
                <li><b>Farm group</b>: wallets that keep entering the first minutes of the same launches together. Often one operator.</li>
                <li><b>Verified early</b>: early entries that graduated well above chance.</li>
              </ul>
              <p className={styles.dim}>Hourly, not live: a new bot trades before it is labelled. Labels older than 14 days are not used at all.</p>
            </Card>

            <Card id="clusters" title="Bundle · one funder · fresh wallet">
              <p><b>Bundle</b>: 3+ top holders whose first buy landed in the same second. When the whole trade history is loaded, 3+ first buys in the launch minute count too.</p>
              <p><b>One funder</b> (a funding cluster): top-30 holders whose first incoming ETH came from the same wallet (read from the explorer, oldest transactions first). Public faucets and hubs (50+ funded wallets or 1,000+ sent transactions, read from the account nonce) are not clusters. ETH bridged from L1 counts as self-funded.</p>
              <p><b>Fresh wallet</b>: a holder whose first ETH arrived less than 24 h before its first buy of the token.</p>
              <p className={styles.dim}>Same funder or same second is common for friends, bots and airdrop hunters alike. A wallet still being checked is shown as pending, never as &ldquo;no cluster&rdquo;.</p>
            </Card>

            <Card id="exit" title="Exit math">
              <p>What selling a bag would return right now: the bonding-curve price integrated over the tokens sold (your own sell moves the price down as it goes), minus the 1.25% vibe/vibe fee.</p>
              <pre className={styles.formula}>{"ETH out ≈ ∫ price(s) ds over the bag  ×  (1 − 0.0125)"}</pre>
              <p><b>Sell wall</b>: how far the price would drop if every holder in profit sold now. The token page flags it for graduated pools only, from a 50% drop.</p>
              <p className={styles.dim}>A quote at the latest block, not a promise: every sell ahead of yours lowers it. The curve fills at 5 ETH; after graduation trades move to the Uniswap V4 pool and the curve quote no longer applies.</p>
            </Card>

            <Card id="volume" title="Real volume">
              <p>Raw volume counts every buy and sell. Real volume sets apart trades that don&apos;t bring new money: one wallet buying and selling around the same moment (round trips), the dev trading its own token, and wallets of one funding cluster trading with each other. Those trades are labelled <b>wash</b>: they move volume but bring no new money.</p>
              <p className={styles.dim}>Wash trading can&apos;t be proven from the chain; the split is a lower bound of what looks organic. When the trade history isn&apos;t fully loaded, the share is marked partial.</p>
            </Card>

            <Card id="eta" title="Graduation ETA">
              <p><b>Graduation</b>: the curve reaches 5 ETH and trading moves to a Uniswap V4 pool. <b>To grad</b> is how far the curve is toward that target.</p>
              <p><b>ETA</b>: ETH still missing to the 5 ETH target, divided by the slower of two paces:</p>
              <ul className={styles.list}>
                <li>net ETH inflow over the last 24 h (or since launch, if younger);</li>
                <li>the last hour&apos;s volume (buys + sells, an upper bound of the last hour&apos;s net inflow).</li>
              </ul>
              <pre className={styles.formula}>{"ETA = ETH remaining / min(net 24 h pace, last-hour pace)"}</pre>
              <p><b>Stalled</b>, no ETA: no buys in the last hour, a flat or draining day, or a last hour under 10% of the day&apos;s pace. Lines younger than 1 h get no ETA: that is noise, not a rate.</p>
            </Card>

            <Card id="sources" title="Sources & freshness">
              <table className={styles.table}>
                <thead><tr><th scope="col">Source</th><th scope="col">Used for</th></tr></thead>
                <tbody>
                  <tr><td>Robinhood Chain testnet RPC<span className={styles.src}>{PUBLIC_RPC_URL.replace("https://", "")}</span></td><td>Lines, trades, balances, curve progress, exit math</td></tr>
                  <tr><td>vibe/vibe API<span className={styles.src}>{VIBE_APP.replace("https://", "")}</span></td><td>Launch list, names, logos, 24 h stats, holder lists, dev history</td></tr>
                  <tr><td>Blockscout explorer<span className={styles.src}>{EXPLORER.replace("https://", "")}</span></td><td>Who first funded each top holder (funding clusters)</td></tr>
                  <tr><td>Early Index<span className={styles.src}>rebuilt hourly from chain logs</span></td><td>Sniper, farm and verified-early labels</td></tr>
                </tbody>
              </table>
              <p>The vibe/vibe indexer can lag the chain by minutes to hours; curve progress is therefore read on-chain. Live freshness of every source: <Link href="/status">Status</Link>.</p>
              <p>The site is open source: every formula on this page is in the code on <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub ↗</a>.</p>
            </Card>



            <p className={styles.legal}>{DISCLAIMER} Not affiliated with Blockscout either. Nothing on this site is financial advice.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
