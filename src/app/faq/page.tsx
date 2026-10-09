import type { Metadata } from "next";
import Link from "next/link";
import { DISCLAIMER, EXIT_CREATOR, EXPLORER, IS_LIVE, VIBE_APP } from "@/lib/config";
import { ABOUT, TAGLINE } from "@/lib/nav";
import PageHead from "@/components/PageHead";
import { GLOSSARY, GLOSSARY_ORDER } from "@/lib/glossary";
import styles from "./faq.module.css";

export const metadata: Metadata = {
  alternates: { canonical: "/faq" },
  title: "FAQ & glossary",
  description: "Every term on Exit Liquidity in one line, plus short answers about the site, $EXIT and the line.",
};

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "What is Exit Liquidity?",
    a: (
      <>
        {TAGLINE} {ABOUT} Start on the <Link href="/">token board</Link>, look up a <Link href="/w">wallet</Link> or a{" "}
        <Link href="/dev">dev</Link>, or read the <Link href="/manifesto">manifesto</Link>.
      </>
    ),
  },
  {
    q: "What is $EXIT?",
    a: "A meme token on the vibe/vibe testnet (Robinhood Chain testnet) with a live, on-chain line attached. Buy 0.0003 ETH+ and you get a place. Everyone who buys after you is your exit liquidity. That's the joke, and the leaderboard.",
  },
  {
    q: "Is this a ponzi?",
    a: "A parody of one. FOMO3D and PoWH3D (2018) paid ETH to earlier players. $EXIT copies only the line and the scoreboard: the line pays nobody and nothing is pooled.",
  },
  {
    q: "What does the dev hold?",
    a: (
      <>
        One public Dev buy of 0.003 ETH. No team allocation, no presale. The no-sell pledge is public, not a contract lock.{" "}
        {IS_LIVE && EXIT_CREATOR ? (
          <>
            Check it any time:{" "}
            <Link href={`/t/${EXIT_CREATOR}`}>the dev&apos;s ticket</Link> ·{" "}
            <a href={`${EXPLORER}/address/${EXIT_CREATOR}`} target="_blank" rel="noreferrer">
              explorer
            </a>
            .
          </>
        ) : (
          "The dev wallet goes up here and on X at launch."
        )}
      </>
    ),
  },
  {
    q: "How do I get in line?",
    a: (
      <>
        Add Robinhood Chain testnet to your wallet, grab free testnet ETH from the{" "}
        <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">
          Robinhood Chain testnet faucet
        </a>
        , and buy $EXIT on{" "}
        <a href={VIBE_APP} target="_blank" rel="noreferrer">
          vibe/vibe
        </a>
        {" "}once the line opens (the only real address goes up here and on X). Your ticket appears with your buy.
      </>
    ),
  },
  {
    q: "What happens when I sell?",
    a: "Sell part and you keep your place; your trader may rank down. Sell 95%+ of your peak bag (or drop under 5,000 tokens) and you walk out: your points go to the people behind you, and they move up.",
  },
  {
    q: "What are Liquidity Points?",
    a: "A wallet's first buy of 0.003 ETH+ gives +1 point to everyone already ahead (not to the buyer). If that newcomer exits within ~1 h, the +1 is revoked. Re-entries earn nothing. On exit, points split among those behind. Points can't be transferred.",
  },
  {
    q: "How is my rank decided?",
    a: "By your bag at the curve price (after graduation: the final curve price): Broke Degen (any bag), Retail (0.0008 ETH+), Chart Guy (0.004 ETH+), Crypto Bro (0.012 ETH+), The Suit (0.03 ETH+). Place #1 is The Dev, the ghost by the door. Everyone who walks out becomes a Ghost.",
  },
  {
    q: "What do stocks have to do with it?",
    a: "Market Mood: every 30 min we check the day's move of TSLA, AMZN, PLTR, NFLX and AMD; an average below −0.5% is a red day, panic at the door. Stock pockets: testnet stock tokens (incl. SPCX) add a badge to your ticket.",
  },
  {
    q: "What happens when the door opens?",
    a: "When the bonding curve hits its target, the token graduates to a DEX pool. That's the door. The line keeps running on pool trades; ranks stay at the final curve price.",
  },
  {
    q: "Is there an airdrop?",
    a: "Nothing is announced. News comes only from this site and our X. An $EXIT airdrop DM is a scam.",
  },
  {
    q: "Can I game the line?",
    a: (
      <>
        Splitting across wallets is possible. Only a bought bag gets a place, and a newcomer who leaves within ~1 h takes back its point.
        Everything is on-chain (<Link href="/how-it-works">How it works</Link>). Please don&apos;t: vibe/vibe treats sybil wallets as abuse.
      </>
    ),
  },
];

export default function FaqPage() {
  return (
    <section>
      <div className="wrap"><div className="prose">
        <PageHead title="FAQ & glossary">
          Every word the site uses, in one line each. Short answers below.
        </PageHead>
        <section className={styles.gloss} aria-labelledby="glossary" id="glossary-section">
          <h2 id="glossary" className={styles.secTitle}>Glossary</h2>
          <dl className={styles.terms}>
            {GLOSSARY_ORDER.map((id) => {
              const g = GLOSSARY[id];
              return (
                <div key={id} id={id} className={styles.termRow}>
                  <dt>{g.term}</dt>
                  <dd>
                    {g.short}
                    {g.more && !g.more.startsWith("/faq") && (
                      <>
                        {" "}
                        <Link href={g.more} prefetch={false} className={styles.more}>More →</Link>
                      </>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
        <section className={styles.gloss} aria-labelledby="questions">
          <h2 className={styles.secTitle} id="questions">Questions</h2>
          <div className={styles.list}>
            {FAQ.map((f) => (
              <div key={f.q} className={styles.item}>
                <h3 className={styles.q}>{f.q}</h3>
                <div className={styles.a}>{f.a}</div>
              </div>
            ))}
          </div>
        </section>
        <div className={styles.legal} role="region" aria-labelledby="disclaimer">
          <h2 id="disclaimer" className={styles.legalHead}>Disclaimer</h2>
          <p>{DISCLAIMER}</p>
        </div>
      </div></div>
    </section>
  );
}
