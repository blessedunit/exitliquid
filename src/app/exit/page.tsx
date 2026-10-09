import type { Metadata } from "next";
import { X_HANDLE, X_LIVE } from "@/lib/config";
import Link from "next/link";
import LiveHero from "@/components/LiveHero";
import Sprite from "@/components/Sprite";
import styles from "./home.module.css";
import { RULES } from "@/lib/copy";
import { SPRITES, type Skin } from "@/lib/skins";

const FAUCET = "https://faucet.testnet.chain.robinhood.com";

const RANKS: [Skin, string][] = [
  ["plain", "any bag"],
  ["hood", "0.0008 ETH+"],
  ["bag", "0.004 ETH+"],
  ["getaway", "0.012 ETH+"],
  ["suit", "0.03 ETH+"],
];

export const metadata: Metadata = {
  alternates: { canonical: "/exit" },
  title: "$EXIT line",
  description:
    "A live on-chain line to the door on the vibe/vibe testnet. Buy and you get a place; everyone after you stands behind you.",
  openGraph: { type: "website", siteName: "Exit Liquidity", title: "The $EXIT line", description: "Every ponzi needs exit liquidity. We made it a leaderboard. A live on-chain line to the door." },
  twitter: { card: "summary_large_image", ...(X_LIVE ? { site: `@${X_HANDLE}` } : {}), title: "The $EXIT line", description: "Every ponzi needs exit liquidity. We made it a leaderboard. A live on-chain line to the door." },
};

export default function ExitLine() {
  return (
    <>
      <LiveHero />

      {/* below the fold: the rules and the cast, nothing else */}
      <section className={styles.sec} aria-labelledby="h-rules">
        <div className="wrap">
          <h2 id="h-rules" className={styles.h2}>Four rules. No cutting.</h2>
          <ol className={styles.cols4}>
            {RULES.map(([n, t, d]) => (
              <li key={n} className={styles.item}>
                <span className={styles.num}>{n.padStart(2, "0")}</span>
                <h3 className={styles.h3}>{t}</h3>
                <p>{d}</p>
              </li>
            ))}
          </ol>
          <p className={styles.fine}>
            Testnet only, no real money. Need test ETH? The{" "}
            <a href={FAUCET} target="_blank" rel="noreferrer">Robinhood Chain faucet <span aria-hidden>↗</span></a> has it. More in the <Link href="/faq">FAQ</Link>.
          </p>
        </div>
      </section>

      <section className={styles.sec} aria-labelledby="h-ranks">
        <div className="wrap">
          <h2 id="h-ranks" className={styles.h2}>Your bag decides your trader</h2>
          <ol className={styles.ranks}>
            {RANKS.map(([s, req], i) => (
              <li key={s} className={styles.rank}>
                <span className={styles.rankPic} aria-hidden><Sprite skin={s} scale={1} face="right" /></span>
                <span className={styles.num}>Rank {i + 1}</span>
                <b>{SPRITES[s].name}</b>
                <span className={styles.req}>{req}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </>
  );
}
