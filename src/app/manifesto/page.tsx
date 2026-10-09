import type { Metadata } from "next";
import Link from "next/link";
import Sprite from "@/components/Sprite";
import styles from "./manifesto.module.css";
import SideCast from "./SideCast";
import { TAGLINE } from "@/lib/nav";
import type { Skin } from "@/lib/skins";

export const metadata: Metadata = {
  alternates: { canonical: "/manifesto" },
  title: "Manifesto",
  description:
    "Charts show price. They hide people. Every token on vibe/vibe is a line of real holders walking to the door.",
  openGraph: { type: "website", siteName: "Exit Liquidity", title: "Exit Liquidity · Manifesto", description: "Charts show price. They hide people. Every token on vibe/vibe is a line of real holders walking to the door." },
  twitter: { card: "summary_large_image", title: "Exit Liquidity · Manifesto", description: "Charts show price. They hide people. Every token on vibe/vibe is a line of real holders walking to the door." },
};

// phones: the cast in facing pairs between the blocks (no margins to stand in)
function PhonePair({ a, b }: { a: Skin; b: Skin }) {
  return (
    <div className={styles.phonePair} aria-hidden>
      <Sprite skin={a} scale={a === "doorghost" ? 1.25 : 2} face="right" className={styles.pairSprite} />
      <Sprite skin={b} scale={b === "doorghost" ? 1.25 : 2} face="left" className={styles.pairSprite} />
    </div>
  );
}

const PILLARS: { n: string; t: string; d: string }[] = [
  {
    n: "01",
    t: "Every token is a line",
    d: "Holders, not candles. Real wallets in buy order, walking to the same door.",
  },
  {
    n: "02",
    t: "Watch the door",
    d: "Progress to graduation, time to the door, who just joined and who just left. Live.",
  },
  {
    n: "03",
    t: "See who's behind it",
    d: "The dev's history, the front of the line, wallets that move together.",
  },
];

const CAST: Skin[] = ["suit", "getaway", "bag", "hood", "plain", "doorghost"]; // left to right, the dev haunts the door

export default function Manifesto() {
  return (
    <>
      <section className={styles.sec}>
        <div className={`wrap ${styles.col}`}>
          <p className={styles.kicker}>Manifesto</p>
          <h1 className={styles.title}>
            Every token <br className={styles.br} />
            is a <span className={styles.accent}>line.</span>
          </h1>
          <p className={styles.lede}>{TAGLINE}</p>

          <div className={styles.body}>
            <p className={styles.opening}>
              Every chart has a top. Every top has a buyer. That buyer is exit liquidity. So is the next one.{" "}
              <em>So are you.</em>
            </p>
            <PhonePair a="suit" b="getaway" />
            <p>
              Charts show price. They hide people. Behind every candle is a wallet that got in at one moment and will leave
              at another. Put those wallets in order and a token stops being a chart. It becomes a line.
            </p>
            <p>
              On vibe/vibe every line walks toward the same door: graduation. Some lines are long and patient. Some are three
              wallets and a dev. Some empty out overnight.
            </p>
            <p>
              So we built the board you find in a station hall. Every departure, live: who is in line, who just walked out,
              who is really behind a token.
            </p>
          </div>

          <blockquote className={styles.quote}>
            <p>
              We put the door in the middle of the room and painted <span className={styles.accent}>EXIT</span> on it.
            </p>
          </blockquote>

          <div className={styles.body}>
            <PhonePair a="bag" b="hood" />
            <p>
              <Link href="/exit">$EXIT</Link> is our own line, and the joke that started all of it. Buy, and everyone who comes
              after you is your exit liquidity. Everyone who came before: you&apos;re theirs. All on-chain.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.sec}>
        <div className={`wrap ${styles.col}`}>
          <h2 className={styles.kicker}>What we are</h2>
          <ol className={styles.pillars}>
            {PILLARS.map((p) => (
              <li key={p.n} className={styles.pillar}>
                <span className={styles.pn} aria-hidden>{p.n}</span>
                <h3 className={styles.pt}>{p.t}</h3>
                <p>{p.d}</p>
              </li>
            ))}
          </ol>

          <div className={styles.cast} aria-hidden>
            {CAST.map((s, i) => (
              <Sprite
                key={s}
                skin={s}
                scale={s === "doorghost" ? 1.25 : 2}
                face="right"
                className={styles.castSprite}
                style={{ animationDelay: `${i * 0.14}s` }}
              />
            ))}
            <span className={styles.castDoor}>
              <span>EXIT</span>
            </span>
          </div>
          <PhonePair a="plain" b="doorghost" />

          <p className={styles.closing}>
            Just the lines, the door, and a lot of little 8-bit traders in front of it.{" "}
            <span className={styles.accent}>Thanks for the liquidity.</span>
          </p>
          <div className={styles.ctas}>
            <Link className="btn start" href="/">Open the token board</Link>
            <Link className="btn" href="/exit">Stand in the $EXIT line</Link>
          </div>
        </div>
      </section>
      {/* last child of <main>: keeps main > section:first-child intact */}
      <SideCast />
    </>
  );
}
