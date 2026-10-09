"use client";
// Look up any wallet (or dev): paste an address, open its profile (or passport).
// `inline` = the small form in the breadcrumb row of a profile page; otherwise the big landing field.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LookupField from "./LookupField";
import s from "./w.module.css";

export type LookupExample = { label: string; address: string; href?: string };

const COPY = {
  wallet: { route: "/w/", placeholder: "Paste a 0x wallet address", cta: "Open profile", inlineCta: "Another wallet", label: "Wallet address" },
  dev: { route: "/dev/", placeholder: "Paste the dev's 0x address", cta: "Open passport", inlineCta: "Another dev", label: "Dev address" },
} as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function WalletLookup({
  target = "wallet",
  inline = false,
  examples = [],
}: {
  target?: "wallet" | "dev";
  inline?: boolean;
  examples?: LookupExample[];
}) {
  const router = useRouter();
  const c = COPY[target];
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [openInline, setOpenInline] = useState(false);
  const id = `${target}-lookup${inline ? "-inline" : ""}`;

  const go = (raw: string) => {
    const a = raw.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
      setErr("Not a valid 0x address.");
      return;
    }
    setErr(null);
    router.push(`${c.route}${a.toLowerCase()}`);
  };

  if (inline && !openInline) {
    return (
      <button type="button" className={s.lookupToggle} onClick={() => setOpenInline(true)}>
        {c.inlineCta}
      </button>
    );
  }

  const tryLine = examples.length > 0 ? (
    <p className={s.try}>
      <span>Try</span>
      {examples.map((x, i) => (
        <span key={x.address} className={s.tryItem}>
          {i > 0 && <span className={s.trySep} aria-hidden>·</span>}
          <Link href={x.href ?? `${c.route}${x.address}`} prefetch={false} title={x.address}>
            {x.label} <b>{short(x.address)}</b>
          </Link>
        </span>
      ))}
    </p>
  ) : null;

  if (!inline) {
    return (
      <LookupField
        id={id}
        label={c.label}
        placeholder={c.placeholder}
        cta={c.cta}
        value={v}
        onChange={(x) => { setV(x); if (err) setErr(null); }}
        onSubmit={go}
        error={err}
        after={tryLine}
      />
    );
  }

  return (
    <div className={s.lookupInlineWrap}>
      <form className={s.lookupInline} onSubmit={(e) => { e.preventDefault(); go(v); }} role="search" noValidate>
        <label htmlFor={id} className="srOnly">{c.label}</label>
        <input
          id={id}
          className="input"
          value={v}
          onChange={(e) => { setV(e.target.value); if (err) setErr(null); }}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${id}-err` : undefined}
        />
        <button type="submit" className="btn">Open</button>
      </form>
      {err && <p id={`${id}-err`} className={s.lookupErr} role="alert">{err}</p>}
    </div>
  );
}
