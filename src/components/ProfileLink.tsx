"use client";
// A small pixel "person" icon that opens a wallet's profile on this site (/w/<addr>) or a creator's
// Dev Passport (/dev/<addr>). It is its own target on purpose: rows that open a ticket on click keep doing so
// (the row handlers skip clicks that land on an <a> or <button>), and this icon never starts that.
import Link from "next/link";
import styles from "./ProfileLink.module.css";

export function profileHref(addr: string, kind: "w" | "dev" = "w") {
  return `/${kind}/${addr.toLowerCase()}`;
}

export default function ProfileLink({ addr, kind = "w", className }: { addr: string; kind?: "w" | "dev"; className?: string }) {
  const what = kind === "dev" ? "Dev passport" : "Wallet profile";
  return (
    <Link
      href={profileHref(addr, kind)}
      prefetch={false}
      className={`${styles.link} ${className ?? ""}`}
      title={what}
      aria-label={`${what} of ${addr}`}
      onClick={(e) => e.stopPropagation()}
    >
      <svg viewBox="0 0 10 10" width="11" height="11" aria-hidden shapeRendering="crispEdges">
        <path d="M3 0h4v1H3zM2 1h1v3H2zM7 1h1v3H7zM3 4h4v1H3zM1 6h8v1H1zM0 7h1v3H0zM9 7h1v3H9z" fill="currentColor" />
        {kind === "dev" && <path d="M4 8h2v2H4z" fill="currentColor" />}
      </svg>
    </Link>
  );
}
