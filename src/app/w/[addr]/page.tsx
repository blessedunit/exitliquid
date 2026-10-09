import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { PUBLIC_SITE_URL } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import WalletProfileView from "./WalletProfileView";
import s from "../w.module.css";

type Props = { params: Promise<{ addr: string }> };

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { addr } = await params;
  if (!isAddr(addr)) return { title: "Wallet" };
  const a = addr.toLowerCase();
  return {
    title: `Wallet ${shortAddr(a)}`,
    description: "Tags, positions, PnL, early entries and funding of one vibe/vibe wallet. Signals, not verdicts.",
    alternates: { canonical: `${PUBLIC_SITE_URL}/w/${a}` },
    robots: { index: false }, // any address is a page: keep them out of search
  };
}

export default async function WalletPage({ params }: Props) {
  const { addr } = await params;
  if (!isAddr(addr)) notFound();
  // one canonical URL per wallet (no duplicate pages / CDN entries for mixed case)
  if (addr !== addr.toLowerCase()) permanentRedirect(`/w/${addr.toLowerCase()}`);
  return (
    <section className={s.page}>
      <div className="wrap">
        <WalletProfileView key={addr} addr={addr} />
      </div>
    </section>
  );
}
