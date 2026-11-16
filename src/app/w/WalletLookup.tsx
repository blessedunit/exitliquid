"use client";
// Look up any wallet: paste an address, open its profile.
// `inline` = the small form in the breadcrumb row of a profile page; otherwise the big landing field.
import { useState } from "react";
import { useRouter } from "next/navigation";
import LookupField from "./LookupField";
import s from "./w.module.css";

const c = { route: "/w/", placeholder: "Paste a 0x wallet address", cta: "Open profile", inlineCta: "Another wallet", label: "Wallet address" };

export default function WalletLookup({ inline = false }: { inline?: boolean }) {
  const router = useRouter();
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [openInline, setOpenInline] = useState(false);
  const id = `wallet-lookup${inline ? "-inline" : ""}`;

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
