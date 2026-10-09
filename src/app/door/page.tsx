import type { Metadata } from "next";
import PageHead from "@/components/PageHead";
import { getDoorWithin } from "./data";
import DoorWatch from "./DoorWatch";

export const metadata: Metadata = {
  alternates: { canonical: "/door" },
  title: "Graduation watch",
  description: "vibe/vibe tokens within 15% of the door: live progress, ETA range, last hour's pace, and what happened after the last 24h of graduations.",
};

export const dynamic = "force-dynamic";

export default async function DoorPage() {
  // a ready snapshot renders at once; a cold one gets 2.5 s, then the page asks /api/door itself
  const initial = await getDoorWithin(2_500);
  return (
    <section>
      <div className="wrap">
        <PageHead title="At the door">Who is about to graduate, how fast, and what the last ones did after.</PageHead>
        <DoorWatch initial={initial} />
      </div>
    </section>
  );
}
