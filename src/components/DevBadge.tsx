"use client";
// Dev reputation (FREE): how many tokens this line's creator launched and how many graduated.
// Facts from vibe/vibe's launch list, worded neutrally; amber only for serial launchers.
// Unknown (vibe down, no creator) = no badge at all, never a made-up "1st launch".
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { fmtAge, shortAddr } from "@/lib/format";
import styles from "./DevBadge.module.css";

type DevLaunch = { token: string; symbol: string; createdAt: number; progressBps: number; graduated: boolean; hidden: boolean };
type DevRep = { creator: string; total: number | null; loaded: number; graduated: number; launches: DevLaunch[]; onChain?: { launches: number; grads: number } };

const SERIAL_AT = 10;

function label(rep: DevRep, token: string) {
  // vibe's lists leave the first and legacy factories out: the chain's count (set only when higher) wins
  if (rep.onChain) {
    const c = rep.onChain;
    return { text: `${c.launches >= SERIAL_AT ? "Serial launcher" : "Dev:"} ${c.launches} launch${c.launches === 1 ? "" : "es"} · ${c.grads} graduated (chain)`, serial: c.launches >= SERIAL_AT };
  }
  const n = rep.total ?? rep.loaded;
  const count = rep.total === null ? `${rep.loaded}+` : String(rep.total);
  const complete = rep.total !== null && rep.total <= rep.loaded;
  const grad = complete ? `${rep.graduated} graduated` : `${rep.graduated} of last ${rep.loaded} graduated`;
  if (rep.total === 1 && rep.launches[0]?.token === token) return { text: "Dev: 1st launch", serial: false };
  if (n >= SERIAL_AT) return { text: `Serial launcher ${count}× · ${grad}`, serial: true };
  return { text: `Dev: ${count} launch${n === 1 ? "" : "es"} · ${grad}`, serial: false };
}

export default function DevBadge({ token, creator }: { token: string; creator: string | null }) {
  const [rep, setRep] = useState<DevRep | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(0); // set when the list opens: ages are read then, not during render
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!creator || !/^0x[0-9a-f]{40}$/i.test(creator)) return;
    let alive = true;
    fetch(`/api/dev/${creator.toLowerCase()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: DevRep | null) => {
        if (alive && j && Array.isArray(j.launches) && (j.loaded > 0 || j.onChain)) setRep(j);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [creator]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // the creator changed (another token): drop the old answer
  if (!rep || !creator || rep.creator !== creator.toLowerCase()) return null;
  const { text, serial } = label(rep, token);
  const cut = rep.total === null || rep.total > rep.loaded;

  return (
    <div className={styles.wrap} ref={wrap}>
      <button
        ref={btn}
        type="button"
        className={`${styles.badge} ${serial ? styles.serial : ""}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setNow(Date.now() / 1000);
          setOpen((v) => !v);
        }}
        title="Other tokens launched by this line's creator"
      >
        {text}
        <span className={styles.caret} aria-hidden>▾</span>
      </button>
      {open && (
        <div id={panelId} className={styles.pop} role="region" aria-label="Launches by this creator">
          <div className={styles.popHead}>
            <span>Launches by</span>
            <Link href={`/dev/${rep.creator}`} className={styles.addr} onClick={() => setOpen(false)} title="Open the dev passport">
              {shortAddr(rep.creator)} →
            </Link>
          </div>
          <ul className={styles.list}>
            {rep.launches.map((l) => {
              const here = l.token === token;
              const name = `$${l.symbol || shortAddr(l.token)}`;
              return (
                <li key={l.token} className={here ? styles.here : undefined}>
                  {here || l.hidden ? (
                    <span className={styles.sym}>{name}</span>
                  ) : (
                    <Link className={styles.sym} href={`/line/${l.token}`} onClick={() => setOpen(false)}>{name}</Link>
                  )}
                  <span className={styles.age}>{here ? "this line" : l.hidden ? "hidden by vibe" : l.createdAt && now ? fmtAge(now - l.createdAt) : "—"}</span>
                  <span className={l.graduated ? styles.grad : styles.door}>{l.graduated ? "Graduated" : `Door ${(l.progressBps / 100).toFixed(0)}%`}</span>
                </li>
              );
            })}
          </ul>
          <p className={styles.note}>
            {cut ? `Newest ${rep.loaded} of ${rep.total ?? `${rep.loaded}+`} shown. ` : ""}
            {rep.onChain ? `vibe/vibe lists ${rep.loaded}; the chain shows ${rep.onChain.launches} (its lists leave older factories out). ` : ""}
            From vibe/vibe&apos;s launch list. Past launches are context, not a verdict on this one.
          </p>
          <Link href={`/dev/${rep.creator}`} className={styles.passport} onClick={() => setOpen(false)}>
            Dev passport: sells, timing, fees, linked wallets →
          </Link>
        </div>
      )}
    </div>
  );
}
