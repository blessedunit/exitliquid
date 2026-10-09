// One empty state for every page (spec §1.8): a single pixel sprite, an h3 line, one meta sentence,
// one action. Centred in a 240px-tall area, never a void.
// <EmptyState title="No lines yet" action={<Link className="btn" href="/">Star tokens →</Link>}>
//   Paste a wallet, or star tokens on the board.
// </EmptyState>
import Sprite from "@/components/Sprite";
import type { Skin } from "@/lib/skins";
import s from "./EmptyState.module.css";

export default function EmptyState({
  title,
  children,
  action,
  skin = "plain",
  boxed = true,
  className,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  skin?: Skin;
  /** the panel frame (spec: the empty state is one of the few boxed things); false = on the page */
  boxed?: boolean;
  className?: string;
}) {
  return (
    <div className={`${s.empty} ${boxed ? s.boxed : ""} ${className ?? ""}`} role="status">
      <Sprite skin={skin} scale={0.6} className={s.sprite} />
      <h3 className={s.title}>{title}</h3>
      {children && <p className={s.text}>{children}</p>}
      {action && <div className={s.action}>{action}</div>}
    </div>
  );
}
