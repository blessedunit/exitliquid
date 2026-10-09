import type { Metadata } from "next";
import Link from "next/link";
import { recentDevs } from "@/lib/devrep";
import { fmtAge, pct } from "@/lib/format";
import WalletLookup from "../w/WalletLookup";
import Lead from "@/components/ui/Lead";
import s from "../w/w.module.css";

export const revalidate = 120;

export const metadata: Metadata = {
  title: "Dev passport",
  description: "Every launch by a vibe/vibe creator wallet and what the dev did with their own bag: sells, timing, fees, linked wallets.",
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default async function DevIndex() {
  const devs = await recentDevs(5).catch(() => []);
  const now = Math.floor(Date.now() / 1000);
  return (
    <section className={s.page}>
      <div className="wrap">
        <header className={s.landHead}>
          <h1>Devs</h1>
          <Lead>Dev passport: every launch by a wallet and what the dev did with their own bag. Read-only.</Lead>
        </header>
        <WalletLookup target="dev" />

        {devs.length > 0 && (
          <section className={s.recent} aria-labelledby="recent-devs">
            <div className={s.recentHead}>
              <h2 id="recent-devs">Recent devs</h2>
              <span className={s.sub}>creators of the newest launches</span>
            </div>
            <ul className={s.recentList}>
              {devs.map((d) => (
                <li key={d.creator}>
                  <Link className={s.recentRow} href={`/dev/${d.creator}`} prefetch={false}>
                    <span className={s.recentAddr}>{short(d.creator)}</span>
                    <span className={s.recentFacts}>
                      <span><b className={d.launches === null ? s.unk : ""} title={d.launches === null ? "Unknown, not zero." : undefined}>{d.launches ?? "—"}</b> launch{d.launches === 1 ? "" : "es"}</span>
                      <span><b className={d.graduated === null ? s.unk : d.graduated > 0 ? s.up : ""} title={d.graduated === null ? "Unknown, not zero." : undefined}>{d.graduated ?? "—"}</b> graduated</span>
                      <span className={s.recentLast}>
                        last <b>${d.last.symbol || short(d.last.token)}</b> · {d.last.createdAt ? `${fmtAge(now - d.last.createdAt)} ago` : "—"} · {d.last.graduated ? "graduated" : pct(d.last.progressBps / 100)}
                      </span>
                    </span>
                    <span className={s.recentGo} aria-hidden>→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <ul className={s.what} aria-label="What a dev passport shows">
          <li><b>History</b><span>Every launch, oldest to newest, and how far each curve got.</span></li>
          <li><b>Dev bag</b><span>Did the dev hold their own token, sell it, and how soon after launch.</span></li>
          <li><b>Fees</b><span>Creator fees the dev&apos;s launches earned, as vibe/vibe reports them.</span></li>
          <li><b>Linked wallets</b><span>Who funded the dev, and who else that funder fed.</span></li>
        </ul>
        <p className={s.aside}>
          Looking at a trader instead? <Link href="/w">Open a wallet profile →</Link>
        </p>
      </div>
    </section>
  );
}
