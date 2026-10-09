import type { Metadata } from "next";
import Link from "next/link";
import Sprite from "@/components/Sprite";
import SearchSuggest from "@/components/SearchSuggest";

export const metadata: Metadata = {
  title: "Wrong door",
  description: "This page doesn't exist. Search a token, a wallet or a $ticker.",
};

// 404: one ghost by the EXIT sign, a Grotesk H1, the big search, three ghost links.
export default function NotFound() {
  return (
    <section>
      <div className="wrap" style={{ maxWidth: 640, display: "grid", justifyItems: "center", textAlign: "center", gap: 16, paddingTop: 32, paddingBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
          <Sprite skin="ghost" scale={1} style={{ display: "block" }} />
          <span className="plate">404</span>
        </div>
        <h1 className="sign" style={{ marginTop: 8 }}>Wrong door</h1>
        <p className="lead" style={{ margin: 0 }}>
          This page doesn&apos;t exist. Look for what you came for:
        </p>
        <div style={{ width: "100%", textAlign: "left", marginTop: 8 }}>
          <SearchSuggest size="lg" placeholder="Paste a token, a wallet or a $ticker" id="nf-search" />
        </div>
        <div style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
          <Link className="btn quiet" href="/">Tokens</Link>
          <Link className="btn quiet" href="/w">Wallets</Link>
          <Link className="btn quiet" href="/dev">Devs</Link>
        </div>
      </div>
    </section>
  );
}
