import type { Metadata } from "next";
import { Suspense } from "react";
import Rankings from "./Rankings";
import styles from "./lines.module.css";

// Rankings (nav "Rankings", URL /lines; /rankings redirects here): six screener leaderboards + your pinned tokens.
export const metadata: Metadata = {
  alternates: { canonical: "/lines" },
  title: "Rankings",
  description: "vibe/vibe tokens with no red flags found on a full check, and the worst red flags right now: pumps, dev bags, whales, fake volume.",
};

export default function LinesPage() {
  return (
    <section className={styles.page}>
      <div className="wrap">
        <Suspense fallback={<div className={styles.fallback} />}>
          <Rankings />
        </Suspense>
      </div>
    </section>
  );
}
