"use client";
// The analytics cards, one per call, so LiveHero can place each in its section (Risk: Bundle; Holders: Supply;
// Selling: Who's selling + Real volume; Dev: Same ticker). Everything is open: every list and table, for everyone.
// Loaded with next/dynamic from LiveHero: below the fold, and not needed on /exit before launch.
import { memo } from "react";
import ExitCard from "./ExitCard";
import BundleCard from "./BundleCard";
import VolumeCard from "./VolumeCard";
import SupplyCard from "./SupplyCard";
import SameTicker from "./SameTicker";
import type { AnalyticsState } from "./useTokenAnalytics";

export type CardPart = "exit" | "bundle" | "supply" | "volume" | "clones";

type Props = {
  state: AnalyticsState;
  /** which card */
  part: CardPart;
  /** the wallet this visitor typed on My Lines (kept for the callers; nothing is gated on it) */
  me?: string | null;
  /** open this wallet's ticket on the page */
  onSelect?: (wallet: string) => void;
};

function AnalyticsCards({ state, part, onSelect }: Props) {
  if (state.trouble === "notvibe") return null;
  switch (part) {
    case "volume":
      return <VolumeCard state={state} onSelect={onSelect} />;
    case "exit":
      return <ExitCard state={state} />;
    case "bundle":
      return <BundleCard state={state} onSelect={onSelect} />;
    case "supply":
      return <SupplyCard state={state} onSelect={onSelect} />;
    case "clones":
      return <SameTicker state={state} />;
  }
}

export default memo(AnalyticsCards);
