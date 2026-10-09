"use client";
// Clamps any list (spec §1.1):
// <ShowMore count={rows.length} initial={8} label="trades">{(n) => rows.slice(0, n).map(...)}</ShowMore>
// Button: "Show all 47 trades" / "Show less". No button when the list already fits.
// From a SERVER component a function can't cross into this client component: pass the rows as
// children instead and ShowMore slices them: <ShowMore count={rows.length} initial={8}>{rows.map(...)}</ShowMore>
import { Children, useState } from "react";

type Props = {
  count: number;
  initial?: number;
  label?: string;
  children: ((n: number) => React.ReactNode) | React.ReactNode;
  className?: string;
};

export default function ShowMore({ count, initial = 8, label = "rows", children, className }: Props) {
  const [all, setAll] = useState(false);
  const n = all ? count : Math.min(count, initial);
  return (
    <>
      {typeof children === "function" ? children(n) : Children.toArray(children).slice(0, n)}
      {count > initial && (
        <button
          type="button"
          className={`textBtn showMore ${className ?? ""}`}
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
        >
          {all ? "Show less" : `Show all ${count.toLocaleString("en-US")} ${label}`}
        </button>
      )}
    </>
  );
}
