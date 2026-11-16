import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { PUBLIC_SITE_URL } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { isAddress as isAddr } from "@/lib/ticket";
import WalletProfileView from "./WalletProfileView";
import s from "./profile.module.css";

type Props = { params: Promise<{ addr: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { addr } = await params;
  if (!isAddr(addr)) return { title: "Wallet" };
  const a = addr.toLowerCase();
  return {
    title: `Wallet ${shortAddr(a)}`,
    description: "Tags, positions, PnL, early entries, funding and launches of one vibe/vibe wallet.",
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
