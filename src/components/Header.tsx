import Link from "next/link";
import styles from "./Header.module.css";
import WalletHeader from "./WalletHeader";
import MenuCloser from "./MenuCloser";
import NavLinks, { HeaderSearch } from "./NavLinks";
import { IS_LIVE } from "@/lib/config";
import { ABOUT_LINKS, DATA_LINKS, MAIN, MY_LINES } from "@/lib/nav";

// $EXIT is a secondary action: a ghost text link to the $EXIT line page, never a framed green button.
const EXIT_LINK = IS_LIVE
  ? { label: "Buy $EXIT", title: "The $EXIT line: our own token on vibe/vibe" }
  : { label: "$EXIT", title: "The $EXIT line opens at launch: see the rules" };
// burger: the main list, then My lines and the $EXIT line
const SHEET_MAIN = [...MAIN, MY_LINES, { href: "/exit", label: "$EXIT line" }];

// The /exit preview note is rendered by the layout under the header (it scrolls away, the bar stays 56/52px).
export const previewClass = styles.preview;

// Header (spec §1.10), one row, 56px.
// 1440: [EXIT]Liquidity  Tokens Door Wallets Devs Market        [⌕ search  /]  My lines  $EXIT  [Connect]
// ≤1180: the search box becomes a ⌕ button (sheet). ≤900: the nav moves into the burger.
// Phones: [EXIT] · ⌕ · Connect · ≡
export default function Header() {
  return (
    <header className={styles.header}>
      <div className={`wrap ${styles.inner}`}>
        <Link href="/" className={styles.brand} aria-label="Exit Liquidity home">
          <span className={styles.plate}>EXIT</span>
          <span className={styles.liq}>Liquidity</span>
        </Link>
        <nav className={styles.nav} aria-label="Main">
          <NavLinks items={MAIN} />
        </nav>
        <HeaderSearch className={styles.search} hotkey />

        {/* narrow screens: search opens as a full-width sheet; it sits before the secondary group */}
        <details className={styles.findSheet} id="site-search">
          <summary aria-label="Search">
            <span aria-hidden>⌕</span>
          </summary>
          <div className={styles.findPanel}>
            <HeaderSearch size="lg" id="site-search-input" placeholder="Token, wallet or $ticker" />
            <p className={styles.findHint}>Paste a token or wallet address, or type a $ticker.</p>
          </div>
        </details>

        <div className={styles.links}>
          <NavLinks items={[MY_LINES]} className={styles.ghostLink} />
          <Link href="/exit" className={styles.ghostLink} prefetch={false} title={EXIT_LINK.title}>
            {EXIT_LINK.label}
          </Link>
        </div>

        <WalletHeader />

        {/* burger sheet (narrow screens): opens without JS */}
        <details className={styles.menu} id="site-menu">
          <summary aria-label="Menu">
            <i aria-hidden />
          </summary>
          <div className={styles.sheet}>
            <nav aria-label="Main (menu)" className={styles.sheetNav}>
              <NavLinks items={SHEET_MAIN} />
            </nav>
            <div className={styles.sheetGroups}>
              <nav aria-label="Data" className={styles.sheetGroup}>
                <span className={styles.groupHead}>Data</span>
                <NavLinks items={DATA_LINKS} />
              </nav>
              <nav aria-label="About" className={styles.sheetGroup}>
                <span className={styles.groupHead}>About</span>
                <NavLinks items={ABOUT_LINKS} />
              </nav>
            </div>
          </div>
        </details>
        <MenuCloser />
      </div>
    </header>
  );
}
