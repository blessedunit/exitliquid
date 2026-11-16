"use client";
// Home = Launches: one title line and the paste field (address or $ticker -> the token report).
// The full launch board follows below (rendered by the page). Cleanest / Red flags live in Rankings (/lines).
import SearchSuggest from "@/components/SearchSuggest";
import GradeScale from "@/components/screener/GradeScale";
import styles from "./HomeIntro.module.css";

export type IntroMarket = { launches7d: number | null; grads7d: number | null } | null;
export type IntroMode = "full" | "min";

export default function HomeIntro(props: { market?: IntroMarket; initial?: IntroMode }) {
  void props; // the board page still passes the old hero props; the search does not need them
  return (
    <div className={styles.root}>
      <section className={styles.hero} aria-labelledby="home-h1">
        <h1 id="home-h1" className={styles.h1}>
          Every vibe/vibe launch, <span className={styles.accent}>graded</span>
        </h1>
        <p className={styles.lead}>Check a token before you buy.</p>
        <div className={styles.searchWrap}>
          <SearchSuggest className={styles.search} size="lg" placeholder="Check a token: address or $ticker" id="home-search" hotkey />
        </div>
        <GradeScale className={styles.scale} />
      </section>
    </div>
  );
}
