import type { Metadata } from "next";
import { after } from "next/server";
import { pendingBuild, readState } from "@/lib/state";
import StateBoard from "./StateBoard";

export const metadata: Metadata = {
  title: "State of vibe",
  description: "Independent vibe/vibe launchpad stats from the chain: launches, graduations, time to graduation, snipers at the front, top devs, 24h volume.",
};

export const dynamic = "force-dynamic";

export default async function StatePage() {
  // never waits for a build: the last snapshot (memory or Redis) renders now, the board refreshes itself
  const r = await readState(0);
  const job = pendingBuild();
  if (job) after(() => job.catch(() => undefined));
  return (
    <section>
      <div className="wrap">
        {/* the board renders the head itself: kicker, H1 and a lead computed from the snapshot */}
        <StateBoard initial={r.snapshot} />
      </div>
    </section>
  );
}
