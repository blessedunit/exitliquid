"use client";
// One restrained chip (spec §1.6): a 6px square + plain text, no frame, no fill.
// <Chip tone="bad">Sell wall −93%</Chip>      tone: bad (red) · warn (medium, --t1) · good (green) · info (--t3)
// <Chips max={3}>{items.map(...)}</Chips>     wraps on phones; past `max` a ghost "+N" expands the rest.
// The same look serves status words: <Chip tone="good">Graduated</Chip>. Old class names
// (.chip.bad/.warn/.good/.plain, .pill) render this style too, from globals.css.
import { Children, useState } from "react";

export type ChipTone = "bad" | "warn" | "good" | "info" | "plain";

export default function Chip({
  tone = "info",
  children,
  title,
  className,
}: {
  tone?: ChipTone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  const t = tone === "info" ? "plain" : tone;
  return (
    <span className={`chip ${t} ${className ?? ""}`} title={title}>
      {children}
    </span>
  );
}

export function Chips({ children, max = 3, className, label }: { children: React.ReactNode; max?: number; className?: string; label?: string }) {
  const [all, setAll] = useState(false);
  const list = Children.toArray(children).filter(Boolean);
  if (!list.length) return null;
  const hidden = list.length - max;
  const shown = all || hidden <= 0 ? list : list.slice(0, max);
  return (
    <div className={`chips ${className ?? ""}`} role="list" aria-label={label}>
      {shown.map((c, i) => (
        <span role="listitem" key={i} style={{ display: "contents" }}>
          {c}
        </span>
      ))}
      {hidden > 0 && (
        <button type="button" className="textBtn" style={{ minHeight: 20, padding: "0 4px", fontSize: 13 }} aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Less" : `+${hidden}`}
        </button>
      )}
    </div>
  );
}
