"use client";
// Share button with a small menu: Post on X (short text + the public link), Copy link, Download card PNG.
// The PNG is the page's own share card (<path>/opengraph-image), the same picture X and Telegram show.
// The link is always the public site (exitliquid.fun), never the host the page was opened on.
import { useEffect, useRef, useState } from "react";
import { PUBLIC_SITE_URL } from "@/lib/config";
import styles from "./ShareCard.module.css";

export type ShareKind = "line" | "wallet" | "dev";

type Props = {
  kind: ShareKind;
  /** token or wallet address */
  id: string;
  /** line only: the ticker, without $ */
  symbol?: string | null;
  /** line only: the Line Health letter when known */
  grade?: string | null;
  /** host button class (so the trigger matches its row); the default is a small ghost button */
  className?: string;
  /** extra class on the <details> root (host layout rules, e.g. full-width on phones) */
  rootClassName?: string;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const PATH: Record<ShareKind, string> = { line: "/line/", wallet: "/w/", dev: "/dev/" };

/** X text: short, no promises, the tag and nothing else (the link goes in its own parameter) */
function postText(kind: ShareKind, id: string, symbol: string | null, grade: string | null): string {
  const sym = symbol ? `$${symbol.replace(/[^\x20-\x7e]/g, "").slice(0, 16)}` : short(id);
  if (kind === "line") return grade ? `${sym} Line Health: ${grade}. Who stands at the front of the line. Signals, not verdicts. #vibevibe` : `${sym}: who stands at the front of the line. Signals, not verdicts. #vibevibe`;
  if (kind === "wallet") return `Wallet ${short(id)} on vibe/vibe: tags, PnL, early entries. #vibevibe`;
  return `Dev ${short(id)} on vibe/vibe: launches, graduations, dev sells. #vibevibe`;
}

function ShareGlyph() {
  // 7x7 pixel arrow out of a box
  return (
    <svg width={12} height={12} viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true" style={{ display: "block" }}>
      <path d="M3 0h4v4h-1v-2h-1v1h-1v1h-1v-1h1v-1h1v-1h-2z M0 2h2v1h-1v3h3v-1h1v2h-5z" fill="currentColor" />
    </svg>
  );
}

export default function ShareCard({ kind, id, symbol = null, grade = null, className, rootClassName }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<"" | "copied" | "saving" | "saved" | "failed">("");
  const addr = id.toLowerCase();
  const path = `${PATH[kind]}${addr}`;
  const url = `${PUBLIC_SITE_URL}${path}`;

  // Esc or a click elsewhere closes the menu; Esc hands focus back to the button
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // opening the menu asks the server for the card once, so it is rendered (and cached ~10 min) before X or
  // Telegram come to fetch it; on a page that has been open a while its data is already warm
  const warmed = useRef(false);
  useEffect(() => {
    if (!open || warmed.current) return;
    warmed.current = true;
    fetch(`${path}/opengraph-image`, { cache: "force-cache" }).catch(() => {});
  }, [open, path]);

  useEffect(() => {
    if (note !== "copied" && note !== "saved" && note !== "failed") return;
    const t = setTimeout(() => setNote(""), 1800);
    return () => clearTimeout(t);
  }, [note]);

  const copy = () => {
    navigator.clipboard?.writeText(url).then(() => setNote("copied"), () => setNote("failed"));
  };

  const download = async () => {
    if (note === "saving") return;
    setNote("saving");
    try {
      // same-origin card route (cached on the server for ~10 min)
      const r = await fetch(`${path}/opengraph-image`, { cache: "force-cache" });
      const type = r.headers.get("content-type") ?? "";
      if (!r.ok || !type.startsWith("image/")) throw new Error(String(r.status));
      const blob = await r.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const tag = kind === "line" && symbol ? symbol.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || addr.slice(2, 8) : addr.slice(2, 8);
      a.href = href;
      a.download = `exit-${kind}-${tag.toLowerCase()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4_000);
      setNote("saved");
    } catch {
      setNote("failed");
    }
  };

  const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(postText(kind, addr, symbol, grade))}&url=${encodeURIComponent(url)}`;
  const label = kind === "line" ? "Share this line" : kind === "wallet" ? "Share this wallet" : "Share this dev passport";

  return (
    <details
      ref={ref}
      className={rootClassName ? `${styles.share} ${rootClassName}` : styles.share}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          setOpen(false);
          ref.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary className={className ?? styles.btn} aria-label={label}>
        <ShareGlyph />
        <span>Share</span>
      </summary>
      <div className={styles.menu}>
        <a href={intent} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Post on X ↗</a>
        <button type="button" onClick={copy}>{note === "copied" ? "Link copied" : "Copy link"}</button>
        <button type="button" onClick={download} disabled={note === "saving"} aria-busy={note === "saving"}>
          {note === "saving" ? "Rendering card…" : note === "saved" ? "Card saved" : "Download card PNG"}
        </button>
        {note === "failed" && <p className={styles.err} role="status">Card unavailable. Try again in a minute.</p>}
      </div>
    </details>
  );
}
