// Card header and footer (spec §1.1).
// <CardHead title="Line Health" term="health" meta="first 20 buyers" id="health-title" />
// <CardFoot source="chain" age={3} stale={false} />  ->  "chain · 3s ago"; stale -> amber "stale · 4m"
// Spec §1.4: prefer the source/age in the head meta (sourceMeta below); CardFoot is now a quiet line, no strip.
// <CardHead title="Bundle check" meta={sourceMeta("first 100 buys", 4)} />
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

/** "3s ago" / "4m ago" / "2h ago" */
export function ageText(sec: number): string {
  const v = Math.max(0, Math.round(sec));
  if (v < 60) return `${v}s`;
  if (v < 3600) return `${Math.round(v / 60)}m`;
  if (v < 86400) return `${Math.round(v / 3600)}h`;
  return `${Math.round(v / 86400)}d`;
}

/** head meta "chain · 4s ago" (or "Retrying…" when `retrying`) */
export function sourceMeta(source: React.ReactNode, age?: number | null, retrying = false): React.ReactNode {
  if (retrying) return <span style={{ color: "var(--t1)" }}>Retrying…</span>;
  const known = typeof age === "number" && Number.isFinite(age);
  return (
    <>
      {source}
      {known ? ` · ${ageText(age!)} ago` : ""}
    </>
  );
}

type FootProps ={ source: React.ReactNode; age?: number | null; stale?: boolean; className?: string; children?: React.ReactNode };

export function CardFoot({ source, age, stale = false, className, children }: FootProps) {
  const known = typeof age === "number" && Number.isFinite(age);
  return (
    <footer className={`${s.foot} ${className ?? ""}`}>
      <span>
        {source}
        {stale ? (
          <span className="stale" style={{ marginLeft: 8 }}>
            stale{known ? ` · ${ageText(age!)}` : ""}
          </span>
        ) : known ? (
          ` · ${ageText(age!)} ago`
        ) : null}
      </span>
      {children}
    </footer>
  );
}

export default CardHead;
