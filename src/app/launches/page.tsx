import type { Metadata } from "next";
import { DeparturesPage } from "./board";

const DESC = "Every vibe/vibe launch, live: grade of the first buyers, snipers, the dev's bag and time to graduation. Signals, not verdicts.";

export const metadata: Metadata = {
  title: "Live launches",
  description: DESC,
  openGraph: { type: "website", siteName: "Exit Liquidity", title: "Exit Liquidity · Live launches", description: DESC },
  twitter: { card: "summary_large_image", title: "Exit Liquidity · Live launches", description: DESC },
};

// the board itself lives in ./board (DeparturesPage); "/" renders the same board under its hero
export default async function LaunchesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <DeparturesPage searchParams={searchParams} />;
}
