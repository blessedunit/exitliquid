// Summary, fact badges, launch history strip and the full launch table. Server component: one cached read.
import Link from "next/link";
import { devPassport, fmtDuration, walletTags, type DevPassport } from "@/lib/devrep";
import { fmtAge, fmtEth, fmtInt, pct as pctOf } from "@/lib/format";
import LaunchTable, { type Row } from "./LaunchTable";
import HistoryStrip from "./HistoryStrip";
import Tags from "./Tags";
import { devSummary } from "./summary";
import Lead from "@/components/ui/Lead";
import SectionTabs from "@/components/ui/SectionTabs";
import Term from "@/components/ui/Term";
import { TagTip } from "../../w/ui";
import styles from "./dev.module.css";

const SECTIONS = [
  { id: "history", label: "History" },
  { id: "launches", label: "Launches" },
  { id: "linked", label: "Linked wallets" },
];
const UNK = "Unknown, not zero.";

const STAT_NAMES = ["Launches", "Graduated", "Dev sold in", "Median 1st sell", "Creator fees"];

export function PassportSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading the dev's launches">
      <p className={styles.leadSkel} aria-hidden><span className={styles.skel} /></p>
      <div className={styles.badgeRow}><span className={`${styles.tag} ${styles.tQuiet}`} role="status">Reading vibe/vibe and the chain…</span></div>
      <dl className={styles.stats}>
        {STAT_NAMES.map((s) => (
          <div key={s} className={styles.stat}>
            <dt>{s}</dt>
            <dd><span className={styles.skelStat} /></dd>
          </div>
        ))}
      </dl>
      <div className={styles.skTabs} />
      {/* sized like the loaded page (strip + filter chips + the first 10 rows), so the stream-in doesn't push the page down */}
      <div className={styles.card}>
        <div className={styles.cardHead}><h2>Launch history</h2></div>
        <div className={styles.stripWrap}><span className={styles.skelStrip} /></div>
      </div>
      <div className={styles.card}>
        <div className={styles.cardHead}><h2>Launches</h2></div>
        <div className={styles.tools}><span className={styles.skelChips} /></div>
        {Array.from({ length: 10 }, (_, i) => <div key={i} className={styles.skelRow}><span className={styles.skel} /></div>)}
      </div>
    </div>
  );
}

const wei = (s: string | null) => (s === null ? null : Number(BigInt(s)) / 1e18);

/** one launch count for the whole site: the chain's when it is above vibe's list (vibe leaves old factories out) */
export function canonicalCounts(p: DevPassport) {
  const launches = p.onChain ? p.onChain.launches : p.total; // null = more than loaded, no total given
  const graduated = p.onChain ? Math.max(p.onChain.grads, p.graduated) : p.graduated;
  // the rate needs a known base: the chain's count, or vibe's full list; otherwise it is "of the loaded ones"
  const base = p.onChain ? p.onChain.launches : p.total !== null && p.total <= p.loaded ? p.loaded : null;
  return { launches, graduated, base, label: launches === null ? `${p.loaded}+` : fmtInt(launches) };
}

const hhmm = (ms: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(ms);

function StaleNote({ p }: { p: DevPassport }) {
  if (!p.stale) return null;
  return (
    <p className={styles.staleNote} role="status">
      Stale · as of {hhmm(p.updatedAt)} UTC <span>vibe/vibe isn&apos;t answering right now; this is the last good read.</span>
    </p>
  );
}

export default async function Passport({ addr, now, from = null }: { addr: string; now: number; from?: string | null }) {
  let p: DevPassport;
  try {
    p = await devPassport(addr);
  } catch {
    return (
      <>
        <IndexTags addr={addr} />
        <div className={styles.card}>
          <div className={styles.cardHead}><h2>Launches</h2></div>
          <p className={styles.msg}>Not answering: vibe/vibe did not return this dev&apos;s launches, so they are unknown right now (not zero). Reload in a minute.</p>
        </div>
      </>
    );
  }

  if (p.loaded === 0 && p.onChain) {
    const c = p.onChain;
    return (
      <>
        <StaleNote p={p} />
        <Lead>{devSummary(p, now)}</Lead>
        <Badges p={p} />
        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt>Launches</dt>
            <dd className={styles.unk} title={UNK}>—</dd>
            <span className={styles.statNote}>vibe lists none; chain shows {fmtInt(c.launches)}</span>
          </div>
          <div className={styles.stat}>
            <dt>Graduated</dt>
            <dd className={styles.unk} title={UNK}>—</dd>
            <span className={styles.statNote}>chain shows {fmtInt(c.grads)}</span>
          </div>
        </dl>
        <div className={styles.card}>
          <div className={styles.cardHead}><h2>Launches</h2></div>
          <p className={styles.msg}>
            vibe/vibe&apos;s lists leave this wallet&apos;s factory out, so its launches can&apos;t be listed here. The chain shows {fmtInt(c.launches)} launch{c.launches === 1 ? "" : "es"} and {fmtInt(c.grads)} graduation{c.grads === 1 ? "" : "s"} (factory logs, all time). Dev sells and fees are unknown for them, not zero.
          </p>
        </div>
      </>
    );
  }

  if (p.loaded === 0 && p.coverage === "v1-only") {
    return (
      <>
        <StaleNote p={p} />
        <Lead>{devSummary(p, now)}</Lead>
        <Badges p={p} />
        <dl className={styles.stats}>
          <div className={styles.stat}>
            <dt>Launches</dt>
            <dd className={styles.unk} title={UNK}>—</dd>
            <span className={styles.statNote}>taxed v6 not covered right now</span>
          </div>
        </dl>
        <div className={styles.card}>
          <div className={styles.cardHead}><h2>Launches</h2></div>
          <p className={styles.msg}>Not covered: vibe/vibe&apos;s taxed v6 list didn&apos;t answer, so v6 launches by this wallet are unknown, not zero. No curve launches on vibe&apos;s list. Reload in a minute.</p>
        </div>
      </>
    );
  }

  if (p.loaded === 0) {
    return (
      <>
        <StaleNote p={p} />
        <Lead>{devSummary(p, now)}</Lead>
        <Badges p={p} />
        <div className={styles.card}>
          <div className={styles.cardHead}><h2>Launches</h2></div>
          <p className={styles.msg}>No launches by this wallet on vibe/vibe. Checking a trader? <Link className={styles.inlineLink} href={`/w/${addr}`}>Open its wallet profile →</Link></p>
        </div>
      </>
    );
  }

  const s = p.summary;
  const canon = canonicalCounts(p);
  const vibeCount = p.total === null ? `${p.loaded}+` : fmtInt(p.total);
  const cut = p.total === null || p.total > p.loaded;
  const rateBase = canon.base ?? p.loaded;
  const chainUnknown = p.chain !== "ok";
  // dev bags are read for curve launches only: a v6-only dev has no dev-bag numbers (unknown, not 0)
  const devUnknown = chainUnknown || s.devHeld === null;
  const taxedN = p.launches.filter((l) => l.taxed).length;
  const fees = wei(p.fees.totalWei);

  const rows: Row[] = p.launches.map((l) => ({
    token: l.token,
    symbol: l.symbol,
    name: l.name,
    createdAt: l.createdAt,
    progressBps: l.progressBps,
    graduated: l.graduated,
    graduatedAt: l.graduatedAt,
    hidden: l.hidden,
    holders: l.holders,
    feesEth: wei(l.feesWei),
    dev: l.dev
      ? {
          received: Number(BigInt(l.dev.receivedWei) / 10n ** 15n) / 1000,
          moved: Number(BigInt(l.dev.movedWei) / 10n ** 15n) / 1000,
          sells: l.dev.sells,
          soldBps: l.dev.soldBps,
          firstSellAfter: l.dev.firstSellAt !== null && l.createdAt > 0 ? Math.max(0, l.dev.firstSellAt - l.createdAt) : null,
          soldBeforeGrad: l.graduatedAt !== null && l.dev.firstSellAt !== null ? l.dev.firstSellAt < l.graduatedAt : null,
        }
      : null,
  }));

  const latest = p.launches.find((l) => !l.hidden) ?? null;

  return (
    <>
      <StaleNote p={p} />
      <Lead>{devSummary(p, now)}</Lead>
      <Badges p={p}>
        {latest && (
          <Link className={styles.latest} href={`/line/${latest.token}`} prefetch={false}>
            Latest: <b>${latest.symbol || latest.token.slice(0, 8)}</b> · {latest.createdAt ? fmtAge(now - latest.createdAt) : "—"} · {latest.graduated ? "graduated" : pctOf(latest.progressBps / 100)} <span>→ open line</span>
          </Link>
        )}
      </Badges>
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Launches</dt>
          <dd>{canon.label}</dd>
          {p.onChain ? (
            <span className={styles.statNote}>on chain · vibe lists {vibeCount}</span>
          ) : (
            cut && <span className={styles.statNote}>newest {p.loaded} read</span>
          )}
        </div>
        <div className={styles.stat}>
          <dt>Graduated</dt>
          <dd>
            {canon.graduated}
            <small>{rateBase ? `${((canon.graduated / rateBase) * 100).toFixed(canon.graduated && canon.graduated / rateBase < 0.1 ? 1 : 0)}%` : ""}</small>
          </dd>
          <span className={styles.statNote}>{canon.base === null ? `of the newest ${p.loaded} · ` : ""}curve filled → V4</span>
        </div>
        <div className={styles.stat}>
          <dt><Term id="dev-sold">Dev sold</Term> in</dt>
          <dd className={devUnknown ? styles.unk : undefined} title={devUnknown ? UNK : undefined}>
            {devUnknown ? "—" : s.soldIn}
            {!devUnknown && <small>of {s.devHeld} held</small>}
          </dd>
          <span className={styles.statNote}>{chainUnknown ? "chain read failed, retrying" : devUnknown ? "taxed v6 not read yet" : s.devHeld === 0 ? "never held own token" : taxedN ? "curve launches only" : "sold into the curve or pool"}</span>
        </div>
        <div className={styles.stat}>
          <dt>Median 1st sell</dt>
          <dd className={s.medianFirstSell === null ? styles.unk : undefined} title={s.medianFirstSell === null ? (s.soldIn === 0 ? "No sells." : UNK) : undefined}>{s.medianFirstSell === null ? "—" : fmtDuration(s.medianFirstSell)}</dd>
          <span className={styles.statNote}>
            {s.medianFirstSell !== null ? `after launch · ${s.timedSells} sell${s.timedSells === 1 ? "" : "s"}` : chainUnknown ? "chain read failed" : devUnknown ? "taxed v6 not read yet" : s.soldIn === 0 ? "no sells" : "sell times unknown"}
          </span>
        </div>
        <div className={styles.stat}>
          <dt>Creator fees</dt>
          <dd className={fees === null ? styles.unk : undefined} title={fees === null ? UNK : undefined}>
            {fees === null ? "—" : `${p.fees.status === "partial" ? "≥" : ""}${fmtEth(fees)}`}
            {fees !== null && <small>ETH</small>}
          </dd>
          <span className={styles.statNote}>
            {p.fees.status === "unknown" ? "vibe fee data unavailable" : p.fees.status === "partial" ? `vibe reports ${p.fees.tokens} of ${p.loaded} tokens` : "accrued, as vibe reports"}
          </span>
        </div>
      </dl>

      <SectionTabs items={SECTIONS} />

      <section id="history" className={styles.card} aria-labelledby="dev-history">
        <div className={styles.cardHead}>
          <h2 id="dev-history">Launch history</h2>
          <span className={styles.cardSub}>one bar per launch · height = how far the curve got</span>
        </div>
        <HistoryStrip rows={rows} now={now} from={from} />
      </section>

      <section id="launches" className={styles.card} aria-labelledby="dev-launches">
        <div className={styles.cardHead}>
          <h2 id="dev-launches">Launches</h2>
          <span className={styles.cardSub}>{p.onChain ? `${p.loaded} listed by vibe · ${canon.label} on chain` : cut ? `newest ${p.loaded} of ${vibeCount}` : `${p.loaded} total`}</span>
        </div>
        <LaunchTable rows={rows} now={now} chainKnown={!chainUnknown} from={from} />
        <p className={styles.note}>
          Dev bag = tokens that reached the creator wallet. Sold = sent back to the curve or the V4 pool; other transfers out are shown as moved, not sold.
          {chainUnknown ? " The chain read failed this time, so dev columns show — (unknown), not zero." : ""}
          {taxedN ? ` Dev columns are read for curve launches only: taxed v6 bags aren't read yet, so ${taxedN === 1 ? "that row shows" : `those ${taxedN} rows show`} — (unknown, not zero).` : ""}
          {p.coverage === "v1-only" ? " Taxed v6 launches aren't listed: vibe/vibe's v6 list didn't answer (unknown, not zero)." : ""}
          {" "}Past launches are context for a new one, not a verdict on it.
        </p>
      </section>
    </>
  );
}

/** Early Index labels alone (when the passport itself could not be read) */
function IndexTags({ addr }: { addr: string }) {
  const t = walletTags(addr);
  if (!t.sniper && t.farm === null && !t.verified) return null;
  return <div className={styles.badgeRow}><span className={styles.badges}><Tags tags={t} /></span></div>;
}

/** fact badges next to the lead; the detail opens on hover / tap. Signals, not verdicts. */
function Badges({ p, children }: { p: DevPassport; children?: React.ReactNode }) {
  return (
    <div className={styles.badgeRow}>
      {p.facts.length > 0 && (
        <ul className={styles.badges} aria-label="Facts">
          {p.facts.map((f) => (
            <li key={f.id}>
              <TagTip tip={{ term: f.label, short: f.detail }}>
                <span className={`${styles.badge} ${styles[`b_${f.tone}`]}`}>{f.label}</span>
              </TagTip>
            </li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}
