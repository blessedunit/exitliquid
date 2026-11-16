import Link from "next/link";
import styles from "./Footer.module.css";
import { FOOT, TAGLINE } from "@/lib/nav";
import { X_URL, X_HANDLE, X_LIVE, VIBE_APP, GITHUB_URL, IS_LIVE, EXIT_TOKEN } from "@/lib/config";

// Footer: the wide pixel corridor (banner_site) stretched across the bottom, darkened so the credits read,
// with the brand and two short link columns laid over its dark ceiling. The line itself shows below them.
// link icons: 16 px, currentColor, so they light up with the link on hover
const IconX = () => (
  <svg className={styles.ico} viewBox="0 0 24 24" aria-hidden>
    <path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
  </svg>
);
const IconGitHub = () => (
  <svg className={styles.ico} viewBox="0 0 24 24" aria-hidden>
    <path fill="currentColor" d="M12 1.5a10.5 10.5 0 0 0-3.3 20.5c.5.1.7-.2.7-.5v-1.9c-2.9.6-3.5-1.3-3.5-1.3-.5-1.2-1.2-1.5-1.2-1.5-.9-.7.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.1 3.1.8.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.8 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.6 1.4.2 2.5.1 2.8.7.7 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5Z" />
  </svg>
);
// vibe/vibe: their own app icon (favicon.svg from testnet.vibevibe.fun), marks the link that leaves for their site
const IconVV = () => (
  // eslint-disable-next-line @next/next/no-img-element
  <img className={styles.ico} src="/brands/vibevibe.svg" alt="" width={18} height={18} decoding="async" />
);
const GH_REPO = GITHUB_URL.replace(/^https?:\/\/github\.com\//, "");

export default function Footer() {
  const exit = IS_LIVE
    ? { href: `${VIBE_APP}/token/${EXIT_TOKEN}`, label: "$EXIT on vibe/vibe", external: true }
    : { href: "/exit", label: "$EXIT line", external: false };
  return (
    <footer className={styles.footer}>
      <div className={styles.bg} aria-hidden />
      <div className={`wrap ${styles.inner}`}>
        <div className={styles.brand}>
          <Link href="/" className={styles.mark} aria-label="Exit Liquidity home" prefetch={false}>
            <span className={styles.plate}>EXIT</span>
            <span className={styles.liq}>Liquidity</span>
          </Link>
          <p className={styles.tag}>{TAGLINE}</p>
        </div>
        <nav className={styles.cols} aria-label="Footer">
          <div>
            <h2 className={styles.h}>Explore</h2>
            <ul>
              {FOOT.map((l) => (
                <li key={l.href}><Link href={l.href} prefetch={false}>{l.label}</Link></li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className={styles.h}>Links</h2>
            <ul>
              {X_LIVE && (
                <li><a href={X_URL} target="_blank" rel="noreferrer"><IconX />@{X_HANDLE}</a></li>
              )}
              <li><a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label={`Source code on GitHub: ${GH_REPO}`}><IconGitHub />GitHub</a></li>
              <li>
                {exit.external ? (
                  <a href={exit.href} target="_blank" rel="noreferrer"><IconVV />{exit.label}</a>
                ) : (
                  <Link href={exit.href} prefetch={false}><IconVV />{exit.label}</Link>
                )}
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </footer>
  );
}
