import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import LiveHero from "@/components/LiveHero";
import V6Line from "@/components/V6Line";
import { ACTIVE_TOKEN } from "@/lib/config";
import { isAddress } from "@/lib/ticket";
import { launchInfo, launchMarket, launchMissing, type LaunchCard } from "@/lib/launches";
import { v6Launch, v6Line } from "@/lib/v6";
import { tokenAbout } from "./about";

export const dynamic = "force-dynamic";

type Kind = { info: LaunchCard | null; v6Symbol: string | null; v6: boolean; missing: boolean };

// v1 first (one cached call); a token the v1 directory doesn't know may be a taxed v6 launch (one more call)
async function kindOf(token: string): Promise<Kind> {
  const info = await launchInfo(token);
  if (info) return { info, v6: false, v6Symbol: null, missing: false };
  // v6Launch: null = 404 (not a v6 launch), throws = vibe didn't answer (unknown)
  const [l, v1Missing] = await Promise.all([v6Launch(token).then((x) => ({ x }), () => null), launchMissing(token)]);
  const v6 = l?.x ?? null;
  return { info: null, v6: !!v6, v6Symbol: v6 ? String(v6.symbol ?? "").slice(0, 16) : null, missing: v1Missing && !!l && !v6 };
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const k = isAddress(token) ? await kindOf(token.toLowerCase()) : null;
  const symbol = k?.info?.symbol || k?.v6Symbol || null;
  const sym = symbol ? `$${symbol}` : "a vibe/vibe token";
  // unknown to vibe (slow API or not a launch at all): keep the soft page out of search results
  const known = !!k?.info || !!k?.v6;
  const description = k?.v6
    ? `Every holder of ${sym} (a taxed v6 launch) ranked by bag, walking to the door. Read from vibe/vibe.`
    : `Every holder of ${sym} standing in line to the door, live from the chain.`;
  return {
    title: `${sym} line`,
    ...(known ? {} : { robots: { index: false } }),
    description,
    // a shared link names the token (the layout's og:title would say only "Exit Liquidity")
    openGraph: { type: "website", siteName: "Exit Liquidity", title: `The ${sym} line`, description },
    twitter: { card: "summary_large_image", title: `The ${sym} line`, description },
  };
}

export default async function LinePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  if (!isAddress(raw)) notFound();
  const token = raw.toLowerCase();
  if (token === ACTIVE_TOKEN) redirect("/exit"); // $EXIT has its own page
  const [k, market] = await Promise.all([kindOf(token), launchMarket(token)]);
  if (k.v6) {
    // taxed v6 launch: the v1 chain engine can't read it, so the line lite from vibe/vibe's indexer
    const line = await v6Line(token).catch(() => null);
    if (line) return <V6Line initial={line} />;
  }
  const info = k.info;
  const holders = typeof info?.holders === "number" && Number.isFinite(info.holders) ? info.holders : (market?.holders ?? null);
  // info can be null when the vibe API is slow: LiveHero then falls back to the queue's own name/symbol
  return (
    <LiveHero
      token={token}
      notVibeHint={k.missing}
      info={info ? { name: info.name, symbol: info.symbol, image: info.image, creator: info.creator } : null}
      createdAt={info?.createdAt ?? null}
      holders={holders}
      vol24Vibe={market?.volume24hEth ?? null}
      change1hBps={market?.change1hBps ?? info?.change1hBps ?? null}
      etaHours={market?.etaHours ?? null}
      etaStalled={market?.etaStalled ?? false}
      about={tokenAbout(info)}
    />
  );
}
