"use client";
// Line health: who stands at the front of this line (sniper bots, farm groups, dev exits, early walk-outs).
// The grade itself lives in the summary at the top of the page. One read (useHealth), two blocks: the reasons
// behind the grade (HealthCard, beside Bundle check) and the first 20 buyers (FirstBuyersCard, a full-width row
// under them, the same as on /exit). Open to everyone. Signals, not verdicts.
import { useEffect, useState, type CSSProperties } from "react";
import { shortAddr } from "@/lib/format";
import ProfileLink from "./ProfileLink";
import { CardHead } from "./ui/CardHead";
import Term from "./ui/Term";
import an from "./analytics/analytics.module.css";
import styles from "./HealthCard.module.css";

type Severity = "good" | "info" | "low" | "medium" | "high" | "unknown";
type Reason = { id: string; label: string; detail: string; severity: Severity; points: number };
type Buyer = { wallet: string; tag: string | null; stillHolds: boolean };
type Health = {
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
const SEV_TEXT: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low", unknown: "Unknown", info: "Info", good: "OK" };

function tagLabel(tag: string | null): { text: string; tone: string } | null {
  if (!tag) return null;
  if (tag === "sniper") return { text: "Sniper", tone: an.t_bad };
  if (tag === "verified") return { text: "Verified early", tone: an.t_ok };
  if (tag.startsWith("farm:")) return { text: `Farm ${tag.slice(5)}`, tone: an.t_warn };
  return null;
}

// the wallet index is rebuilt every hour (the hourly index job): say how fresh it is, from its generatedAt
function asOfText(sec: number | null): string {
  if (sec === null) return "labels unavailable";
  const min = Math.max(0, Math.floor(sec / 60));
  if (min < 1) return "labels just now";
  if (min < 90) return `labels ${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `labels ${h}h ago` : `labels ${Math.round(h / 24)}d ago`;
}

export type HealthRead = { res: Health | null; trouble: "rate" | "down" | "notvibe" | null };

/** The Line health read for one token (null: nothing is asked). Refreshed every 2 min while the tab is visible. */
export function useHealth(token: string | null): HealthRead {
  const [got, setRes] = useState<Health | null>(null);
  // a result for another token (the page switched tokens) is never shown: derived, no reset in the effect
  const res = token && got && got.token === token.toLowerCase() ? got : null;
  const [trouble, setTrouble] = useState<"rate" | "down" | "notvibe" | null>(null);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = token.toLowerCase();
    let first = true;
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
            setTrouble(r.status === 429 ? "rate" : r.status === 404 ? "notvibe" : "down");
            if (r.status !== 404) timer = setTimeout(load, 30_000);
            return;
          }
          const j = (await r.json()) as Health;
          if (!alive) return;
          setRes(j.token === t ? j : null);
          setTrouble(null);
          timer = setTimeout(load, REFRESH_MS);
        })
        .catch(() => {
          if (!alive) return;
          setTrouble("down");
          timer = setTimeout(load, 30_000);
        });
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  return { res, trouble };
}

type Props = {
  health: HealthRead;
  /** the wallet whose ticket is open on this page */
  selected?: string | null;
  /** open this wallet's ticket on the page */
  onSelect?: (wallet: string) => void;
};

export default function HealthCard({ health }: { health: HealthRead }) {
  const { res, trouble } = health;
  if (trouble === "notvibe") return null;

  const meta = res ? (
    <span title="Sniper and farm labels come from a wallet index built from the last 7 days of launches. It is rebuilt every hour, not in real time.">
      first 20 buyers + dev · <Term id="early-index">{asOfText(res.indexAge)}</Term>
      {res.indexStale && <b className={an.staleTag}> · stale</b>}
      {res.partial && <> · <Term id="partial">partial</Term></>}
    </span>
  ) : trouble ? <span>Retrying…</span> : "first 20 buyers + dev";

  return (
    <section className={an.card} aria-labelledby="health-title" data-loading={!res && !trouble ? true : undefined}>
      <CardHead id="health-title" title="Line health" term="health" meta={meta} className={an.head} />

      {!res ? (
        trouble ? (
          <p className={an.msg} role="status">Retrying… Line health unknown, not clean.</p>
        ) : (
          <div className={an.skel} role="status" aria-label="Reading the first 20 buyers">
            <i className={an.skLine} /><i className={an.skLine} /><i className={an.skLine} /><i className={an.skLine} />
          </div>
        )
      ) : (
        <>
          {res.reasons.length > 0 ? (
            <ul className={styles.reasons}>
              {res.reasons.map((r) => (
                <li key={r.id} className={`${styles.reason} ${styles[`s_${r.severity}`] ?? ""}`}>
                  <span className={styles.sq} aria-hidden />
                  <div className={styles.rBody}>
                    <p className={styles.rLabel}>
                      <span className="srOnly">{SEV_TEXT[r.severity]}: </span>{r.label}
                    </p>
                    {r.detail && <p className={styles.rDetail}>{r.detail}</p>}
                  </div>
                  {r.points !== 0 && (
                    <span className={styles.pts} title={`${r.points > 0 ? "Adds" : "Takes"} ${Math.abs(r.points)} point${Math.abs(r.points) === 1 ? "" : "s"} ${r.points > 0 ? "to" : "from"} the score of 100`}>
                      {r.points > 0 ? `+${r.points}` : `−${-r.points}`}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className={an.noneLine}><span className={an.tick} aria-hidden>✓</span>No warning signs at the front of this line.</p>
          )}
        </>
      )}
    </section>
  );
}

/** The first 20 buyers with their labels: a full-width block under Line health + Bundle check. */
export function FirstBuyersCard({ health, selected = null, onSelect }: Props) {
  const { res, trouble } = health;
  if (trouble === "notvibe") return null;
  const buyers = res?.firstBuyers ?? [];
  const holding = buyers.filter((b) => b.stillHolds).length;
  const meta = !res ? (trouble ? "Retrying…" : "who bought first") : buyers.length ? `${holding} of ${buyers.length} still hold` : undefined;
  return (
    <section id="an-first" className={an.card} aria-labelledby="first-title" data-loading={!res && !trouble ? true : undefined}>
      <CardHead id="first-title" title={buyers.length ? `First ${buyers.length} buyers` : "First buyers"} meta={meta} className={an.head} />
      {!res ? (
        trouble ? (
          <p className={an.msg} role="status">Retrying… First buyers unknown for now.</p>
        ) : (
          <div className={an.skel} role="status" aria-label="Reading the first 20 buyers">
            <i className={an.skLine} /><i className={an.skLine} /><i className={an.skLine} /><i className={an.skLine} />
          </div>
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
