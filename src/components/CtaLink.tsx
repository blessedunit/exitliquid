"use client";
import Link from "next/link";
import { CTA } from "@/lib/config";
import { useLineCtx, vibeTokenUrl } from "@/lib/lineContext";

// The one main call to action. Until the real token address exists it stays on-site,
// so the final UI can be reviewed without linking to somebody else's $EXIT.
export default function CtaLink({ className = "btn", label }: { className?: string; label?: string }) {
  const { token, info } = useLineCtx();
  if (token) {
    return (
      <a className={className} href={vibeTokenUrl(token)} target="_blank" rel="noreferrer">
        {label ?? `Buy $${info?.symbol || "token"}`}
      </a>
    );
  }
  const text = label ?? CTA.label;
  return CTA.external ? (
    <a className={className} href={CTA.href} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <Link className={className} href={CTA.href}>
      {text}
    </Link>
  );
}
