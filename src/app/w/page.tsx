import type { Metadata } from "next";
import Link from "next/link";
import { exampleSniper, recentDevs } from "@/lib/devrep";
import WalletLookup, { type LookupExample } from "./WalletLookup";
import Lead from "@/components/ui/Lead";
import s from "./w.module.css";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Wallet lookup",
  description: "See what any vibe/vibe wallet does: sniper or farm tags, open positions, season PnL, how early it buys and who funded it.",
};

const WHAT = [
  { k: "Tags", v: "Sniper, farm, dev, holder: signals from the Early Index and its own trades." },
  { k: "Money", v: "ETH balance, open positions, season PnL and trader rank." },
  { k: "Early entries", v: "Its place in each launch's line, and how soon after launch it buys." },
  { k: "Funding", v: "Who sent its first ETH, and which other wallets that funder fed." },
];

export default async function WalletIndex() {
  const examples: LookupExample[] = [];
  const sniper = exampleSniper();
  if (sniper) examples.push({ label: "a known sniper", address: sniper });
  const devs = await recentDevs(5).catch(() => []);
  const busy = devs.filter((d) => d.launches !== null && d.launches >= 2).sort((a, b) => (b.launches ?? 0) - (a.launches ?? 0))[0];
  if (busy) examples.push({ label: `a dev with ${busy.launches} launches`, address: busy.creator });
  else if (devs[0]) examples.push({ label: "a recent dev", address: devs[0].creator });

  return (
    <section className={s.page}>
      <div className="wrap">
        <header className={s.landHead}>
          <h1>Wallets</h1>
          <Lead>See what any wallet does on vibe/vibe: sniper or farm tags, open positions, season PnL, how early it buys and who funded it. Read-only.</Lead>
        </header>
        <WalletLookup target="wallet" examples={examples} />
        <ul className={s.what} aria-label="What a wallet profile shows">
          {WHAT.map((w) => (
            <li key={w.k}><b>{w.k}</b><span>{w.v}</span></li>
          ))}
        </ul>
        <p className={s.aside}>
          Checking who launched a token? <Link href="/dev">Open a dev passport →</Link>
        </p>
      </div>
    </section>
  );
}
