"use client";
// Line health: who stands at the front of this line (sniper bots, farm groups, dev exits, early walk-outs).
// One read (useHealth) and the first 20 buyers (FirstBuyersCard). The grade and its reasons live in the report
// at the top of the page. Open to everyone. Signals, not verdicts.
import { useEffect, useState, type CSSProperties } from "react";
import { shortAddr } from "@/lib/format";
import ProfileLink from "./ProfileLink";
import { CardHead } from "./ui/CardHead";
import Unreadable from "./token/Unreadable";
import Loader from "./ui/Loader";
import { useTries, type Failed } from "./useTries";
import an from "./analytics/analytics.module.css";
import styles from "./HealthCard.module.css";

type Severity = "good" | "info" | "low" | "medium" | "high" | "unknown";
type Reason = { id: string; label: string; detail: string; severity: Severity; points: number };
export type Buyer = { wallet: string; tag: string | null; stillHolds: boolean };
export type Health = {
  token: string;
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
  verdict: string;
  partial?: boolean;
  reasons: Reason[];
  firstBuyers: Buyer[];
  indexAge: number | null;
  indexStale: boolean;
  indexWindowDays?: number;
};

const REFRESH_MS = 120_000; // the check is CDN-cached 2 min (api/health)

function tagLabel(tag: string | null): { text: string; tone: string } | null {
  if (!tag) return null;
  if (tag === "sniper") return { text: "Sniper", tone: an.t_bad };
  if (tag === "verified") return { text: "Verified early", tone: an.t_ok };
  if (tag.startsWith("farm:")) return { text: `Farm ${tag.slice(5)}`, tone: an.t_warn };
  return null;
}

/** trouble: "failed" = gave up after MAX_TRIES (see `failed`); no res and no trouble = still reading */
export type HealthRead = { res: Health | null; trouble: "failed" | "notvibe" | null; failed: Failed | null };

/** The Line health read for one token (null: nothing is asked). Refreshed every 2 min while the tab is visible. */
export function useHealth(token: string | null, { retryMissing = false }: { retryMissing?: boolean } = {}): HealthRead {
  const [got, setRes] = useState<Health | null>(null);
  // a result for another token (the page switched tokens) is never shown: derived, no reset in the effect
  const res = token && got && got.token === token.toLowerCase() ? got : null;
  const [notVibe, setNotVibe] = useState(false);
  const { failed, round, start, fail, ok } = useTries(token);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let have = false; // an answer is on screen: failed refreshes keep it and keep asking
    start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = token.toLowerCase();
    let first = true;
    let fails = 0;
    // a failed read asks again soon at first (a cold server answers in seconds), then every 30 s
    const again = () => (++fails <= 3 ? 8_000 : 30_000);
    const load = () => {
      // hidden browser tab: no request, look again in a few seconds (the first read always goes)
      if (!first && document.visibilityState !== "visible") {
        timer = setTimeout(load, 5_000);
        return;
      }
      first = false;
      fetch(`/api/health/${t}`)
        .then(async (r) => {
          if (!alive) return;
          if (!r.ok) {
            // retryMissing (v6): a 404 may only mean "not read yet", so it stays unknown and is asked again
            if (r.status === 404 && !retryMissing) return setNotVibe(true); // a final answer
            if (have || fail(token)) timer = setTimeout(load, r.status === 404 ? 60_000 : again());
            return;
          }
          const j = (await r.json()) as Health;
          if (!alive) return;
          setRes(j.token === t ? j : null);
          have = j.token === t;
          ok();
          setNotVibe(false);
          fails = 0;
          timer = setTimeout(load, REFRESH_MS);
        })
        .catch(() => {
          if (!alive) return;
          if (have || fail(token)) timer = setTimeout(load, again());
        });
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [token, retryMissing, round, start, fail, ok]);

  return { res, trouble: notVibe ? "notvibe" : !res && failed ? "failed" : null, failed: res ? null : failed };
}

type Props = {
  health: HealthRead;
  /** the wallet whose ticket is open on this page */
  selected?: string | null;
  /** open this wallet's ticket on the page */
  onSelect?: (wallet: string) => void;
};

/** The first 20 buyers with their labels: a full-width block under Line health + Bundle check. */
export function FirstBuyersCard({ health, selected = null, onSelect }: Props) {
  const { res, trouble, failed } = health;
  if (trouble === "notvibe") return null;
  const buyers = res?.firstBuyers ?? [];
  const holding = buyers.filter((b) => b.stillHolds).length;
  const meta = !res ? "who bought first" : buyers.length ? `${holding} of ${buyers.length} still hold` : undefined;
  return (
    <section id="an-first" className={an.card} aria-labelledby="first-title" data-loading={!res && !failed ? true : undefined}>
      <CardHead id="first-title" title={buyers.length ? `First ${buyers.length} buyers` : "First buyers"} meta={meta} className={an.head} />
      {!res ? (
        failed ? (
          <Unreadable failed={failed} className={an.msg} />
        ) : (
          <Loader caption="Reading the first 20 buyers…" />
        )
      ) : !buyers.length ? (
        <p className={an.msg}>No buyers yet.</p>
      ) : (
        <FirstBuyers buyers={buyers} selected={selected} onSelect={onSelect} />
      )}
    </section>
  );
}

function FirstBuyers({ buyers, selected, onSelect }: { buyers: Buyer[]; selected: string | null; onSelect?: (wallet: string) => void }) {
  return (
    <>
      <ol className={styles.bList} style={{ "--rows": Math.ceil(buyers.length / 2) } as CSSProperties}>
        {buyers.map((b, i) => {
          const tag = tagLabel(b.tag);
          const picked = selected === b.wallet;
          return (
            <li key={b.wallet} className={`${styles.bRow} ${picked ? styles.picked : ""}`}>
              <span className={styles.bPlace}>{i + 1}</span>
              <span className={styles.bWho}>
                {onSelect ? (
                  <button type="button" className={styles.addr} onClick={() => onSelect(b.wallet)} aria-label={`Open the ticket of ${b.wallet}`} aria-pressed={picked}>
                    {shortAddr(b.wallet)}
                  </button>
                ) : (
                  <span className={styles.addr}>{shortAddr(b.wallet)}</span>
                )}
                <ProfileLink addr={b.wallet} />
              </span>
              <span className={styles.bTag}>{tag && <span className={`${an.tag} ${tag.tone}`}>{tag.text}</span>}</span>
              <span className={b.stillHolds ? styles.hold : styles.gone}>{b.stillHolds ? "Holds" : "Left"}</span>
            </li>
          );
        })}
      </ol>
    </>
  );
}
