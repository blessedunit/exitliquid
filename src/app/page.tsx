import type { Metadata } from "next";
import { X_HANDLE, X_LIVE } from "@/lib/config";
import { ABOUT } from "@/lib/nav";
import { DeparturesPage } from "./launches/board";

// "/" is the home (nav "Launches"): one title line + the token search over the full launch board.
// /launches renders the very same board without the hero.
const TITLE = "Exit Liquidity · Launches: every vibe/vibe token, graded";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: ABOUT,
  openGraph: { type: "website", siteName: "Exit Liquidity", title: TITLE, description: ABOUT },
  twitter: { card: "summary_large_image", ...(X_LIVE ? { site: `@${X_HANDLE}` } : {}), title: TITLE, description: ABOUT },
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <DeparturesPage searchParams={searchParams} intro />;
}
