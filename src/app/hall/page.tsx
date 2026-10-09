import type { Metadata } from "next";
import HallList from "./HallList";
import PageHead from "@/components/PageHead";

export const metadata: Metadata = {
  alternates: { canonical: "/hall" },
  title: "Hall of Exits",
  description: "Everyone who walked out of the $EXIT line, and how many moved up.",
};

export default function HallPage() {
  return (
    <section>
      <div className="wrap">
        <PageHead title="Hall of Exits">
          They sold and walked out. Everyone behind moved up.
        </PageHead>
        <HallList />
      </div>
    </section>
  );
}
