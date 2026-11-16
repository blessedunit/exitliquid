import { VERDICT_LABEL, type Grade, type Verdict } from "@/lib/screener-types";
import { GradeBadge } from "./Grade";
import s from "./screener.module.css";

// What the letters mean, in one strip, in the same words the rows and the token page use (VERDICT_LABEL).
// How a letter is computed: /methodology.
const SCALE: { g: Grade[]; v: Verdict }[] = [
  { g: ["A", "B"], v: "clean" },
  { g: ["C"], v: "caution" },
  { g: ["D", "F"], v: "risk" },
];

export default function GradeScale({ className }: { className?: string }) {
  return (
    <div className={`${s.scale} ${className ?? ""}`}>
      <ul className={s.scaleList} aria-label="What the grades mean">
        {SCALE.map((x) => (
          <li key={x.v}>
            {x.g.map((g) => <GradeBadge key={g} grade={g} size="sm" />)}
            <b>{VERDICT_LABEL[x.v]}</b>
          </li>
        ))}
        <li>
          <GradeBadge grade={null} size="sm" />
          <b>{VERDICT_LABEL.unknown}</b>
        </li>
      </ul>
    </div>
  );
}
