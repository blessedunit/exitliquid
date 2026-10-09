import type { Metadata } from "next";
import Link from "next/link";
import PageHead from "@/components/PageHead";
import { statusLead, statusReport, statusShort, type Level } from "@/lib/status";
import Refresh from "./Refresh";
import k from "../_kit/kit.module.css";
import styles from "./status.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status",
  description: "How fresh each data source behind Exit Liquidity is right now: chain RPC, vibe/vibe API, explorer, Early Index, State snapshot, caches.",
};

const WORD: Record<Level, string> = { ok: "Fresh", warn: "Lagging", down: "Down" };
const TONE: Record<Level, string> = { ok: k.stGood, warn: k.stMid, down: k.stBad };

// How old each number on the site may be, by design (server caches + page polling).
const CACHES: [string, string, string][] = [
  ["Line, places, trades", "Chain logs", "~20 s"],
  ["Launch board, ETA pace", "vibe/vibe API", "30 s · pace 2 min"],
  ["Sparklines", "vibe/vibe API", "5 min"],
  ["Line Health", "Chain + Early Index", "2 min · labels: index age"],
  ["Top holders & funders", "vibe/vibe + explorer", "holders 5 min · funders kept"],
  ["Dev history", "vibe/vibe API", "10 min"],
];

export default async function StatusPage() {
  const r = await statusReport();
  const fresh = r.probes.filter((p) => p.level === "ok").length;
  const why = statusShort(r.probes);
  const checked = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }).format(r.checkedAt);
  return (
    <section>
      <Refresh />
      <div className="wrap">
        <PageHead title="Status">How fresh the data behind every number is, right now.</PageHead>

        {/* one line: the count plus the worst source's reason in a few words; the rows carry the detail */}
        <p className={styles.overall} role="status" title={statusLead(r.probes)}>
          <span className={`${k.st} ${r.overall === "ok" ? k.stLive : TONE[r.overall]} ${styles.overallWord}`}>
            {fresh === r.probes.length && r.probes.length ? `All ${fresh} sources fresh` : `${fresh} of ${r.probes.length} sources fresh`}
          </span>
          {why && <span className={styles.why}>{why}</span>}
          <span className={k.meta}>
            Checked {checked} UTC{r.cacheAgeMs > 1_000 ? ` · ${Math.round(r.cacheAgeMs / 1000)}s ago` : ""} · refreshes every minute
          </span>
        </p>

        <section className={styles.block} aria-labelledby="sources-h">
          <h2 id="sources-h" className={k.h2}>Sources</h2>
          <ul className={styles.list}>
            <li className={`${styles.row} ${styles.rowHead}`} aria-hidden>
              <span className={k.label}>Source</span>
              <span className={k.label}>Affects</span>
              <span className={k.label}>State</span>
              <span className={k.label}>Age · lag</span>
              <span className={`${k.label} ${styles.r}`}>Answered in</span>
            </li>
            {r.probes.map((p) => (
              <li key={p.id} className={styles.row}>
                <span className={styles.name}>
                  <b>{p.name}</b>
                  <small>{p.detail}</small>
                </span>
                <span className={styles.affects}>{p.affects}</span>
                <span className={`${k.st} ${TONE[p.level]}`}>{WORD[p.level]}</span>
                <span className={styles.value}>
                  {p.value}
                  {p.reason && <small>{p.reason}</small>}
                </span>
                <span className={`${styles.ms} ${styles.r}`}>{p.latencyMs === null ? <span className={k.dim}>{p.local ?? "—"}</span> : `${p.latencyMs.toLocaleString("en-US")} ms`}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.block} aria-labelledby="cache-h">
          <div className={k.secHead}>
            <h2 id="cache-h" className={k.h2}>Cache windows</h2>
            <p className={k.lead}>How old a number can be, by design.</p>
          </div>
          <table className={`${k.table} ${styles.table}`}>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Source</th>
                <th scope="col" className={k.r}>Max age</th>
              </tr>
            </thead>
            <tbody>
              {CACHES.map(([what, src, age]) => (
                <tr key={what}>
                  <td data-l="Data">{what}</td>
                  <td data-l="Source" className={styles.src}>{src}</td>
                  <td data-l="Max age" className={k.n}>{age}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <p className={styles.foot}>
          A source that doesn&apos;t answer never turns into a zero: its numbers show as — with the reason. How every metric is computed:{" "}
          <Link href="/methodology">Methodology</Link>.
        </p>
      </div>
    </section>
  );
}
