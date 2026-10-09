import type { Metadata } from "next";
import PageHead from "@/components/PageHead";
import BoardTabs from "./BoardTabs";

export const metadata: Metadata = {
  alternates: { canonical: "/board" },
  title: "Leaderboard",
  description: "The $EXIT line ranked by Liquidity Points.",
};

export default function BoardPage() {
  return (
    <section>
      <div className="wrap">
        <PageHead title="Leaderboard">The $EXIT line ranked by points.</PageHead>
        <BoardTabs />
      </div>
    </section>
  );
}
