import type { Metadata } from "next";
import { X_HANDLE, X_LIVE } from "@/lib/config";
import { ABOUT } from "@/lib/nav";
import { DeparturesPage } from "./launches/board";

// "/" is the home: the hero (what the site is, what you can do) over the Live launches board.
// /launches renders the very same board without the hero.
const TITLE = "Exit Liquidity · See who's in line before you buy";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: ABOUT,
  openGraph: { type: "website", siteName: "Exit Liquidity", title: TITLE, description: ABOUT },
  twitter: { card: "summary_large_image", ...(X_LIVE ? { site: `@${X_HANDLE}` } : {}), title: TITLE, description: ABOUT },
};

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <DeparturesPage searchParams={searchParams} intro />;
}
