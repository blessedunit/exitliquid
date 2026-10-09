// The one-sentence answer under an H1 (spec §1.1): f-ui 16/24 --t2, max 72ch.
// <Lead>36 launches in 25 days · 0 graduated · never held their own bag.</Lead>
import s from "./Lead.module.css";

export default function Lead({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  if (children === null || children === undefined || children === false || children === "") return null;
  return (
    <p id={id} className={`${s.lead} ${className ?? ""}`}>
      {children}
    </p>
  );
}
