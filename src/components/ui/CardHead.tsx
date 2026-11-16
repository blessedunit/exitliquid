// Card header (spec §1.1).
// <CardHead title="Line Health" term="health" meta="first 20 buyers" id="health-title" />
import Term from "./Term";
import type { GlossaryId } from "@/lib/glossary";
import s from "./CardHead.module.css";

type HeadProps = {
  title: React.ReactNode;
  term?: GlossaryId;
  meta?: React.ReactNode;
  id?: string;
  /** heading level; h3 by default (cards sit under an h2 section) */
  as?: "h2" | "h3" | "h4";
  className?: string;
  children?: React.ReactNode; // extra controls on the right, after meta
};

export function CardHead({ title, term, meta, id, as: H = "h3", className, children }: HeadProps) {
  return (
    <header className={`${s.head} ${className ?? ""}`}>
      <H id={id} className={s.title}>
        {title}
        {term && <Term id={term} icon />}
      </H>
      {(meta || children) && (
        <div className={s.right}>
          {meta && <span className={s.meta}>{meta}</span>}
          {children}
        </div>
      )}
    </header>
  );
}
