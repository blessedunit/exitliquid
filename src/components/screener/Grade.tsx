import type { Grade as G, NoGrade, ReasonLevel } from "@/lib/screener-types";
import { coverageWord, isFullCheck, standingWord } from "@/lib/screener-types";
import Hourglass from "./Hourglass";
import s from "./screener.module.css";

export type Tone = "good" | "warn" | "bad" | "none";

const gradeTone = (g: G | null | undefined): Tone => (!g ? "none" : g === "A" || g === "B" ? "good" : g === "C" ? "warn" : "bad");
export const levelTone = (l: ReasonLevel): Tone => (l === "good" ? "good" : l === "warn" ? "warn" : l === "bad" ? "bad" : "none");

const TONE: Record<Tone, string> = { good: s.tGood, warn: s.tWarn, bad: s.tBad, none: s.tNone };
export const toneClass = (t: Tone) => TONE[t];

/** the grade letter as a coloured pixel badge; a pixel hourglass while there is no letter (too new, thin, unread) */
export function GradeBadge({ grade, noGrade, size = "md", title }: { grade: G | null | undefined; noGrade?: NoGrade | null; size?: "sm" | "md" | "lg"; title?: string }) {
  const t = gradeTone(grade);
  const word = standingWord(grade, noGrade);
  return (
    <span className={`${s.badge} ${s[`badge_${size}`]} ${TONE[t]}`} title={title ?? (grade ? `Grade ${grade}: ${word}` : word)} aria-label={grade ? `Grade ${grade}, ${word}` : word}>
      {grade ? (
        grade
      ) : (
        <Hourglass size={size === "lg" ? 26 : size === "md" ? 17 : 13} />
      )}
    </span>
  );
}

/** the word next to the letter (A "No red flags found" .. F "Likely exit liquidity"; no letter: why) */
export function VerdictWord({ grade, noGrade, className }: { grade: G | null | undefined; noGrade?: NoGrade | null; className?: string }) {
  return <span className={`${s.verdict} ${TONE[gradeTone(grade)]} ${className ?? ""}`}>{standingWord(grade, noGrade)}</span>;
}

/** the coverage marker next to a letter: "Full check", or "Partial" with what wasn't checked in the tooltip */
export function CoverageMark({ coverage, className }: { coverage: string[] | null | undefined; className?: string }) {
  const full = isFullCheck(coverage);
  return (
    <span className={`${s.cover} ${full ? s.coverFull : ""} ${className ?? ""}`} title={coverageWord(coverage)}>
      {full ? "Full check" : "Partial"}
    </span>
  );
}
