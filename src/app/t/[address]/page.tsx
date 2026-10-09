import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import TicketCard from "@/components/TicketCard";
import Corridor from "@/components/Corridor";
import ShareTicket from "./ShareTicket";
import { getTicket, isAddress } from "@/lib/ticket";
import { buildState, wireEntry } from "@/lib/service";
import { short } from "@/lib/queue";
import CtaLink from "@/components/CtaLink";
import { PUBLIC_SITE_URL, X_HANDLE, X_LIVE } from "@/lib/config";
import s from "./t.module.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  if (!isAddress(address)) return { title: "Ticket" };
  const t = await getTicket(address);
  const title =
    t.status === "unknown"
      ? "Line unavailable"
      : t.status === "in_line"
      ? `#${t.entry!.place} in line`
      : t.status === "exited"
        ? `Exited at #${t.exit!.exitedAtPlace}`
        : "Not in line yet";
  const description =
    t.status === "in_line"
        ? `Exit liquidity for ${t.entry!.ahead} people ahead. ${t.entry!.behind} in line behind. Thanks for the liquidity.`
        : "Every ponzi needs exit liquidity. We made it a leaderboard.";
  const full = `${title} · ${short(address)}`;
  const canonical = `${PUBLIC_SITE_URL}/t/${address.toLowerCase()}`;
  const image = `${canonical}/twitter-image?v=${t.entry ? `p${t.entry.place}` : t.status}`;
  return {
    title: full,
    description,
    alternates: { canonical },
    openGraph: { title: full, description, url: canonical, images: [{ url: image, width: 1200, height: 630, alt: `EXIT boarding pass for ${short(address)}` }] },
    twitter: { card: "summary_large_image", title: full, description, images: [image], ...(X_LIVE ? { site: `@${X_HANDLE}` } : {}) },
  };
}

export default async function TicketView({ params }: Props) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  // one canonical URL per wallet (no duplicate pages / CDN entries for mixed case)
  if (address !== address.toLowerCase()) permanentRedirect(`/t/${address.toLowerCase()}`);
  const built = await buildState();
  const t = await getTicket(address, built);

  // people around you, so the corridor shows your neighborhood
  let around = built.state.line.slice(0, 20);
  if (t.entry) {
    const i = t.entry.place - 1;
    const from = Math.max(0, i - 4); // a few people ahead of you, the rest behind
    around = built.state.line.slice(from, from + 20);
  }

  const heading =
    t.status === "unknown"
      ? <>Can&apos;t read the line right now</>
      : t.status === "in_line"
        ? <><span>{short(t.wallet)}</span> is #{t.entry!.place.toLocaleString("en-US")} in line</>
        : t.status === "exited"
          ? <><span>{short(t.wallet)}</span> walked out</>
          : <>Not in line. Yet.</>;

  return (
    <section className={`ticketSection ${s.page}`}>
      <div className={`wrap ${s.inner}`}>
        <nav className={s.crumb} aria-label="Breadcrumb">
          <Link href="/exit">$EXIT line</Link>
          <span aria-hidden>/</span>
          <span aria-current="page">Boarding pass</span>
        </nav>
        <h1 className={s.h1}>{heading}</h1>
        <TicketCard t={t} />
        {t.status !== "unknown" && <div className={s.share}><ShareTicket t={t} /></div>}

        {t.entry && (
          <section className={s.block} aria-labelledby="t-near">
            <div className={s.blockHead}>
              <h2 id="t-near">The neighbourhood</h2>
              <span className={s.meta}>this wallet and the people around it in line</span>
            </div>
            <div className={s.stage}>
              <Corridor
                line={around.map(wireEntry)}
                inLine={around.length}
                progressBps={built.meta?.progressBps ?? 0}
                highlight={t.wallet}
                maxShown={20}
                ghosts={0}
                compact
                showRest={false}
              />
            </div>
          </section>
        )}
        {t.status === "unknown" && (
          <p className={s.unknown}>Not answering. Unknown, not zero: refresh in a minute.</p>
        )}
        {t.status !== "unknown" && (
          <section className={s.block} aria-labelledby="t-cta">
            <div className={s.blockHead}>
              <h2 id="t-cta">{t.status === "exited" ? "Come back?" : t.status === "in_line" ? "Want your own place?" : "Get in line"}</h2>
            </div>
            <p className={s.text}>
              {t.status === "exited"
                ? "A second entry starts at the end. No cutting."
                : "Buy 0.0003 ETH+ of $EXIT and you get a place in line. Everyone who buys after you stands behind you."}
            </p>
            <div className={s.ctas}>
              <CtaLink className="btn start" />
              <Link href="/how-it-works" className={s.ghost}>How it works</Link>
            </div>
          </section>
        )}
        <div className={s.links}>
          <Link href="/lines" className={s.ghost}>Check another address</Link>
          <Link href={`/w/${address.toLowerCase()}`} prefetch={false} className={s.ghost}>Wallet profile →</Link>
        </div>
      </div>
    </section>
  );
}
