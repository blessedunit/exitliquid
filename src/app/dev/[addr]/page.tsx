import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import WalletAddress from "@/components/WalletAddress";
import ShareCard from "@/components/ShareCard";
import { devReputation } from "@/lib/devrep";
import { shortAddr } from "@/lib/format";
import { PUBLIC_SITE_URL, X_HANDLE, X_LIVE } from "@/lib/config";
import Passport, { PassportSkeleton } from "./Passport";
import Linked, { LinkedSkeleton } from "./Linked";
import WalletLookup from "../../w/WalletLookup";
import styles from "./dev.module.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ addr: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** metadata never waits long: a slow vibe gives the plain title */
async function quickRep(addr: string) {
  return Promise.race([devReputation(addr).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 2_500))]);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { addr } = await params;
  if (!isAddress(addr)) return { title: "Dev passport" };
  const a = addr.toLowerCase();
  const rep = await quickRep(a);
  // vibe's lists leave the first and legacy factories out: the chain's count wins when it is higher
  // v6 not covered and nothing else listed: no count rather than a made-up 0
  const n = rep && !(rep.coverage === "v1-only" && rep.loaded === 0 && !rep.onChain) ? (rep.onChain ? String(rep.onChain.launches) : rep.total === null ? `${rep.loaded}+` : String(rep.total)) : null;
  const title = `Dev ${shortAddr(a)}${n ? ` · ${n} launch${n === "1" ? "" : "es"}` : ""}`;
  const complete = rep && rep.total !== null && rep.total <= rep.loaded;
  const description = rep?.onChain
    ? `${n} launches · ${rep.onChain.grads} graduated on vibe/vibe (chain). Dev sells, timing, fees and linked wallets.`
    : rep
    ? `${n} launches · ${rep.graduated} graduated${complete ? "" : ` (last ${rep.loaded})`} on vibe/vibe. Dev sells, timing, fees and linked wallets.`
    : "Every launch by this creator on vibe/vibe: dev sells, timing, fees and linked wallets.";
  const canonical = `${PUBLIC_SITE_URL}/dev/${a}`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title, description, url: canonical },
    twitter: { card: "summary_large_image", title, description, ...(X_LIVE ? { site: `@${X_HANDLE}` } : {}) },
  };
}

export default async function DevPage({ params, searchParams }: Props) {
  const { addr } = await params;
  if (!isAddress(addr)) notFound();
  // one canonical URL per wallet
  if (addr !== addr.toLowerCase()) permanentRedirect(`/dev/${addr.toLowerCase()}`);
  const sp = (await searchParams) ?? {};
  const fromRaw = Array.isArray(sp.from) ? sp.from[0] : sp.from;
  const from = fromRaw && isAddress(fromRaw) ? fromRaw.toLowerCase() : null; // the token page that sent us here
  const now = Math.floor(Date.now() / 1000);

  return (
    <section className={styles.page}>
      <div className={`wrap ${styles.inner}`}>
        <div className={styles.top}>
          <div className={styles.crumbRow}>
            <nav className={styles.crumb} aria-label="Breadcrumb">
              <Link href="/dev">Devs</Link>
              <span aria-hidden>/</span>
              <span aria-current="page" className={styles.crumbAddr}><WalletAddress wallet={addr} /></span>
            </nav>
            <div className={styles.crumbTools}>
              <Link className={styles.profileLink} href={`/w/${addr}`} prefetch={false}>Wallet profile →</Link>
              <ShareCard kind="dev" id={addr} className={styles.profileLink} />
              <WalletLookup target="dev" inline />
            </div>
          </div>
          <header className={styles.head}>
            <h1 className={styles.h1}>Dev passport <span className={styles.h1Addr}>{shortAddr(addr)}</span></h1>
          </header>
        </div>

        <Suspense fallback={<PassportSkeleton />}>
          <Passport addr={addr} now={now} from={from} />
        </Suspense>
        <div id="linked">
          <Suspense fallback={<LinkedSkeleton />}>
            <Linked addr={addr} />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
