// The token report's verdict: the letter, its word (A "No red flags found" .. F "Likely exit liquidity"; no letter:
// "Too new" / "Not enough trading yet" / "Couldn't read"), the coverage marker and the facts behind it, worst first.
// ONE grade on the whole site: the screener rules (lib/screener-rules screen()), run on this page's own
// /api/analytics answer, so the report, the boards, the share text and the card always agree.
import type { Analytics } from "@/lib/analytics/types";
import type { Grade, NoGrade, ScreenerMetrics, ScreenerReason, Verdict } from "@/lib/screener-types";
import { screen } from "@/lib/screener-rules";
import type { TrackRecord } from "./useDevPassport";

export type VerdictRead = {
  grade: Grade | null;
  score: number | null;
  verdict: Verdict;
  reasons: ScreenerReason[];
  /** why there is no letter (grade null); null when graded or not read */
  noGrade: NoGrade | null;
  /** what the check could not read (empty = Full check); null = no check ran */
  coverage: string[] | null;
  metrics: ScreenerMetrics | null;
  src: "screen" | "none";
};

export function readVerdict(a: Analytics | null, track: TrackRecord | null, ageSec: number | null): VerdictRead {
  if (a) {
    const res = screen({
      a,
      ageMin: ageSec === null ? null : Math.floor(ageSec / 60),
      track: track?.forGrade ?? null,
      ethUsd: null,
    });
    return {
      grade: res.grade, score: res.score, verdict: res.verdict, reasons: res.reasons,
      noGrade: res.metrics.noGrade ?? null, coverage: res.metrics.coverage ?? null, metrics: res.metrics, src: "screen",
    };
  }
  return { grade: null, score: null, verdict: "unknown", reasons: [], noGrade: null, coverage: null, metrics: null, src: "none" };
}
