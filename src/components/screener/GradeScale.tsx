import { GRADE_WORD, NO_GRADE_WORD, type Grade } from "@/lib/screener-types";
import { GradeBadge } from "./Grade";
import s from "./screener.module.css";

// What the letters mean, in one strip, in the same words the rows and the token page use (GRADE_WORD).
// The letter is the risk of becoming someone's exit liquidity. How a letter is computed: /methodology.
const SCALE: Grade[] = ["A", "B", "C", "D", "F"];

export default function GradeScale({ className }: { className?: string }) {
  return (
    <div className={`${s.scale} ${className ?? ""}`}>
      <ul className={s.scaleList} aria-label="What the grades mean">
        {SCALE.map((g) => (
          <li key={g}>
            <GradeBadge grade={g} size="sm" />
            <b>{GRADE_WORD[g]}</b>
          </li>
        ))}
        <li title={`${NO_GRADE_WORD.young} (under 10 minutes), ${NO_GRADE_WORD.thin}, or ${NO_GRADE_WORD.unread}`}>
          <GradeBadge grade={null} noGrade="thin" size="sm" />
          <b>No letter yet</b>
        </li>
      </ul>
    </div>
  );
}
