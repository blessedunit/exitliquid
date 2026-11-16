// The token report's verdict: one word (Looks clean / Caution / High risk / Too early to grade), the letter and the
// facts behind it, worst first. ONE grade on the whole site: the screener rules (lib/screener-rules screen()), run
// on this page's own /api/analytics answer, so the report, the boards, the share text and the card always agree.
import type { Analytics } from "@/lib/analytics/types";
import type { Grade, ScreenerReason, Verdict } from "@/lib/screener-types";
import { screen } from "@/lib/screener-rules";
import type { TrackRecord } from "./useDevPassport";

export type VerdictRead = {
  grade: Grade | null;
  score: number | null;
  verdict: Verdict;
  reasons: ScreenerReason[];
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
    return { grade: res.grade, score: res.score, verdict: res.verdict, reasons: res.reasons, src: "screen" };
  }
  return { grade: null, score: null, verdict: "unknown", reasons: [], src: "none" };
}
