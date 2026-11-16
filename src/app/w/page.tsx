import type { Metadata } from "next";
import WalletLookup from "./WalletLookup";
import { TopTraders } from "./Top";
import s from "./w.module.css";

// /w: one wallet search, then the Known snipers board (Top.tsx). Profiles live at /w/<addr>.
export const metadata: Metadata = {
  title: "Wallets",
  description: "Look up any vibe/vibe wallet: sniper or farm tags, open positions, season PnL, entry timing, funding and its own launches.",
  alternates: { canonical: "/w" },
};

export default function WalletsPage() {
  return (
    <section className={s.page}>
      <div className="wrap">
        <header className={s.research}>
          <h1 id="w-h1" className={s.researchH1}>Research a wallet</h1>
          <p className={s.researchSub}>Paste a wallet address</p>
          <WalletLookup />
        </header>
        <TopTraders />
      </div>
    </section>
  );
}
