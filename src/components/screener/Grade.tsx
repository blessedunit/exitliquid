import type { Grade as G, ReasonLevel, Verdict } from "@/lib/screener-types";
import { VERDICT_LABEL } from "@/lib/screener-types";
import Hourglass from "./Hourglass";
import s from "./screener.module.css";

export type Tone = "good" | "warn" | "bad" | "none";

const gradeTone = (g: G | null | undefined): Tone => (!g ? "none" : g === "A" || g === "B" ? "good" : g === "C" ? "warn" : "bad");
const verdictTone = (v: Verdict): Tone => (v === "clean" ? "good" : v === "caution" ? "warn" : v === "risk" ? "bad" : "none");
export const levelTone = (l: ReasonLevel): Tone => (l === "good" ? "good" : l === "warn" ? "warn" : "bad");

const TONE: Record<Tone, string> = { good: s.tGood, warn: s.tWarn, bad: s.tBad, none: s.tNone };
export const toneClass = (t: Tone) => TONE[t];

/** the grade letter as a coloured pixel badge; a pixel hourglass while the token is too young to grade */
export function GradeBadge({ grade, size = "md", title }: { grade: G | null | undefined; size?: "sm" | "md" | "lg"; title?: string }) {
  const t = gradeTone(grade);
  return (
    <span className={`${s.badge} ${s[`badge_${size}`]} ${TONE[t]}`} title={title ?? (grade ? `Grade ${grade}` : VERDICT_LABEL.unknown)} aria-label={grade ? `Grade ${grade}` : VERDICT_LABEL.unknown}>
      {grade ? (
        grade
      ) : (
        <Hourglass size={size === "lg" ? 26 : size === "md" ? 17 : 13} />
      )}
    </span>
  );
}

export function VerdictWord({ verdict, className }: { verdict: Verdict; className?: string }) {
  return <span className={`${s.verdict} ${TONE[verdictTone(verdict)]} ${className ?? ""}`}>{VERDICT_LABEL[verdict]}</span>;
}
