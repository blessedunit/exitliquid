"use client";

import { useEffect, useState } from "react";
import type { TicketResponse } from "@/lib/types";
import PositionPnl from "./PositionPnl";
import styles from "./TicketCard.module.css";

export default function TicketLivePnl({ t }: { t: TicketResponse }) {
  const [live, setLive] = useState<TicketResponse>(t);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(`/api/ticket/${t.wallet}`, { cache: "no-store" });
        if (r.ok && alive) {
          const next = (await r.json()) as TicketResponse;
          if (next.entry) setLive(next);
        }
      } catch {
        /* keep the last good one */
      }
    };
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [t.wallet]);
  const entry = live.entry ?? t.entry!;
  const cost = entry.positionCostEth;
  return <div className={styles.pnlRow}>
    <div><span>POSITION COST</span><strong>{cost > 0 ? `${cost.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} ETH` : "—"}</strong><small>Cost of the remaining bag</small></div>
    <PositionPnl entry={entry} pnl={live.pnl} />
  </div>;
}
