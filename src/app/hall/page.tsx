import type { Metadata } from "next";
import HallList from "./HallList";
import PageHead from "@/components/PageHead";
import { ACTIVE_TOKEN } from "@/lib/config";
import { launchInfo } from "@/lib/launches";

// the line's token picture: vibe's directory, cached 10 min (name and picture never change)
export const revalidate = 600;

export const metadata: Metadata = {
  alternates: { canonical: "/hall" },
  title: "Hall of Exits",
  description: "Everyone who walked out of the $EXIT line, and how many moved up.",
};

export default async function HallPage() {
  // decoration only: a slow or missing answer leaves the letter in place, never holds the page
  const info = ACTIVE_TOKEN ? await Promise.race([launchInfo(ACTIVE_TOKEN), new Promise<null>((r) => setTimeout(() => r(null), 2_000))]) : null;
  return (
    <section>
      <div className="wrap">
        <PageHead title="Hall of Exits">
          They sold and walked out. Everyone behind moved up.
        </PageHead>
        <HallList image={info?.image ?? null} />
      </div>
    </section>
  );
}
