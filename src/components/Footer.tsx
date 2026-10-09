import Link from "next/link";
import styles from "./Footer.module.css";
import { FOOT_REF, MAIN, TAGLINE } from "@/lib/nav";
import { X_URL, X_HANDLE, X_LIVE, VIBE_APP } from "@/lib/config";

// Footer (spec §1.11): two short rows, no illustration, no link columns.
// [EXIT]Liquidity  See who's in line before you buy.     Tokens Door Wallets Devs Market   Methodology Status FAQ Manifesto   X ↗ vibe/vibe ↗
// Signals, not verdicts. Independent, testnet, not financial advice.
// Hall, Leaderboard, Roadmap, Press kit and How it works stay reachable from the burger and the FAQ.
export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`wrap ${styles.row}`}>
        <div className={styles.brand}>
          <Link href="/" className={styles.mark} aria-label="Exit Liquidity home" prefetch={false}>
            <span className={styles.plate}>EXIT</span>
            <span className={styles.liq}>Liquidity</span>
          </Link>
          <span className={styles.tag}>{TAGLINE}</span>
        </div>
        <nav className={styles.links} aria-label="Footer">
          <ul>
            {MAIN.map((l) => (
              <li key={l.href}><Link href={l.href} prefetch={false}>{l.label}</Link></li>
            ))}
          </ul>
          <ul>
            {FOOT_REF.map((l) => (
              <li key={l.href}><Link href={l.href} prefetch={false}>{l.label}</Link></li>
            ))}
          </ul>
          <ul>
            {X_LIVE && (
              <li>
                <a href={X_URL} target="_blank" rel="noreferrer" aria-label={`X · @${X_HANDLE}`}>X ↗</a>
              </li>
            )}
            <li><a href={VIBE_APP} target="_blank" rel="noreferrer">vibe/vibe ↗</a></li>
          </ul>
        </nav>
      </div>
      <div className={`wrap ${styles.fine}`}>
        Signals, not verdicts. Independent, testnet, not financial advice.
      </div>
    </footer>
  );
}
