"use client";
// The home hero (minimal spec §3.1): the display headline, one lead sentence, the paste field, one stats
// line, and a small pixel crowd walking to the EXIT door. No frame, no feature cards (the nav already
// says where everything is). From the second visit it folds to the search row + stats line. The choice
// lives in localStorage["el.intro"] (and a mirror cookie, so the server renders the folded hero straight
// away and nothing jumps). Storage blocked: the full hero, no error.
import Link from "next/link";
import { useEffect, useState } from "react";
import SearchSuggest from "@/components/SearchSuggest";
import Term from "@/components/ui/Term";
import styles from "./HomeIntro.module.css";

export type IntroMarket = { launches7d: number | null; grads7d: number | null } | null;
export type IntroMode = "full" | "min";

const KEY = "el.intro";
const COOKIE = "el_intro";

const n = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v.toLocaleString("en-US"));

function save(v: "seen" | "min" | "open") {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage blocked: the hero simply shows in full next time */
  }
  try {
    document.cookie = `${COOKIE}=${v}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* same */
  }
}

/** first visit: full, and remembered as seen; any later visit: folded, unless the viewer asked for it open.
 * Decided once per page load (a second effect run, or a remount, must not read its own "seen" back). */
let decided: { mode: IntroMode | null } | null = null;
function decide(): IntroMode | null {
  if (!decided) decided = { mode: read() };
  return decided.mode;
}
function read(): IntroMode | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "open") return "full";
    if (v === "seen" || v === "min") {
      if (v === "seen") save("min");
      return "min";
    }
    save("seen");
    return "full";
  } catch {
    return null; // storage blocked: keep what the server rendered
  }
}

// the crowd: five travellers walking to the door, each on its own slow loop (CSS only)
const CROWD = ["plain", "suit", "bag", "hood", "getaway"] as const;

function Scene() {
  return (
    <div className={styles.scene} aria-hidden>
      <span className={styles.floor} />
      {CROWD.map((s, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={s} src={`/sprites/${s}.png`} alt="" className={styles.walker} style={{ ["--i" as string]: i }} />
      ))}
      <span className={styles.door}>
        <em>EXIT</em>
      </span>
    </div>
  );
}

export default function HomeIntro({ market: served, initial }: { market: IntroMarket; initial: IntroMode }) {
  const [mode, setMode] = useState<IntroMode>(initial);
  // the server waits 300 ms at most for the market numbers: a cold snapshot is fetched here once instead
  const [market, setMarket] = useState<IntroMarket>(served);
  useEffect(() => {
    if (served && (served.launches7d !== null || served.grads7d !== null)) return;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20_000);
    fetch("/api/state", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { snapshot?: { totals?: { launches7d?: number | null; grads7d?: number | null } } } | null) => {
        const tt = j?.snapshot?.totals;
        if (tt) setMarket({ launches7d: tt.launches7d ?? null, grads7d: tt.grads7d ?? null });
      })
      .catch(() => {
        /* unknown stays unknown: the line keeps its dashes */
      })
      .finally(() => clearTimeout(t));
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [served]);

  useEffect(() => {
    const m = decide();
    if (m && m !== initial) {
      const t = setTimeout(() => setMode(m), 0);
      return () => clearTimeout(t);
    }
  }, [initial]);

  const hide = () => {
    decided = { mode: "min" };
    save("min");
    setMode("min");
  };
  const show = () => {
    decided = { mode: "full" };
    save("open");
    setMode("full");
  };

  const l7 = n(market?.launches7d);
  const g7 = n(market?.grads7d);
  const unknownTitle = "Unknown right now, not zero.";
  const stats = (
    <p className={styles.stats}>
      <span className={styles.nums}>
        <span>
          <b title={l7 ? undefined : unknownTitle}>{l7 ?? "—"}</b> launches<span className={styles.wk}> this week</span>
        </span>
        <span className={styles.dot} aria-hidden>·</span>
        <span>
          <b title={g7 ? undefined : unknownTitle}>{g7 ?? "—"}</b> graduated
        </span>
        <span className={styles.dot} aria-hidden>·</span>
        <Link href="/state" className={styles.more}>
          Market →
        </Link>
      </span>
      <span className={styles.live}>
        <i aria-hidden />
        live · Robinhood Chain testnet
      </span>
      {mode === "min" ? (
        <button type="button" className={styles.textBtn} onClick={show}>
          Show intro
        </button>
      ) : (
        <button type="button" className={styles.textBtn} onClick={hide} aria-label="Hide the intro">
          Hide intro
        </button>
      )}
    </p>
  );

  const search = (
    // #home-search: the shell hides the header's search while this one is on screen (MenuCloser).
    // Same slot in both modes, so folding/unfolding keeps this node (and the shell's observer on it).
    <div className={styles.searchWrap}>
      <SearchSuggest className={styles.search} size="lg" placeholder="Token, wallet or $ticker" id="home-search" />
    </div>
  );

  if (mode === "min")
    return (
      <section className={`${styles.root} ${styles.min}`} aria-label="About Exit Liquidity">
        <h1 className={styles.sr}>See who&apos;s in line before you buy</h1>
        {search}
        {stats}
      </section>
    );

  return (
    <section className={styles.root} aria-labelledby="home-h1">
      <div className={styles.top}>
        <div className={styles.copy}>
          <h1 id="home-h1" className={styles.h1}>
            See who&apos;s in line <span className={styles.br}>before you buy</span>
          </h1>
          <p className={styles.lead}>
            Live checks for every <Term id="vibe">vibe/vibe</Term> launch: snipers, bundles, dev bag, real volume, time to <Term id="graduation">graduation</Term>.
          </p>
        </div>
        <Scene />
      </div>
      {search}
      {stats}
    </section>
  );
}
