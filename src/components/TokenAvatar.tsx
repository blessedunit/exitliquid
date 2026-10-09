"use client";
// A token picture that never shows a broken-image icon: the ticker letter holds the spot
// until the picture paints, and stays if the picture fails.
import { useState } from "react";
import styles from "./TokenAvatar.module.css";

export default function TokenAvatar({ src, symbol, size = 40, priority = false }: { src: string | null; symbol: string; size?: number; priority?: boolean }) {
  const [failed, setFailed] = useState(false);
  const letter = (symbol || "?").replace(/^\$/, "").slice(0, 1).toUpperCase();
  return (
    <span className={styles.av} style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} data-l={letter} aria-hidden>
      {src && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size} height={size} loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : "auto"} onError={() => setFailed(true)} />
      )}
    </span>
  );
}
