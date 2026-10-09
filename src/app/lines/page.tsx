import type { Metadata } from "next";
import { Suspense } from "react";
import MyLines, { MyLinesShell } from "./MyLines";
import styles from "./lines.module.css";

export const metadata: Metadata = {
  alternates: { canonical: "/lines" },
  title: "My Lines",
  description: "Your place in every vibe/vibe line you hold.",
};

export default function LinesPage() {
  return (
    <section className={styles.page}>
      <div className="wrap">
        <div className={styles.head}>
          <h1>My lines</h1>
          <p>Your place in every vibe/vibe line you hold. Read-only.</p>
        </div>
        <Suspense fallback={<MyLinesShell />}>
          <MyLines />
        </Suspense>
      </div>
    </section>
  );
}
