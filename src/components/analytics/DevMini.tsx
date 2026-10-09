"use client";
// "The dev": the creator's record in one line, from /api/dev/<creator>/passport (owned by profiles; read only).
// 36 launches · 0 graduated · Never sold own bag · held it in 3 of 36. Past launches are context, not a verdict on this one.
// Loading = a skeleton line; failure = "Unknown, not clean" (never a made-up clean record).
import Link from "next/link";
import { useEffect, useState } from "react";
import type { DevPassport } from "@/lib/devrep";
import { fmtInt, shortAddr } from "@/lib/format";
import { CardHead } from "@/components/ui/CardHead";
import s from "./analytics.module.css";

type Got = { creator: string; p: DevPassport | null };

export default function DevMini({ creator }: { creator: string | null }) {
  const c = creator && /^0x[0-9a-f]{40}$/i.test(creator) ? creator.toLowerCase() : null;
  const [got, setGot] = useState<Got | null>(null);
  useEffect(() => {
    if (!c) return;
    let alive = true;
    const ctl = new AbortController();
    fetch(`/api/dev/${c}/passport`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<DevPassport>) : null))
      .then((p) => { if (alive) setGot({ creator: c, p: p && Array.isArray(p.launches) ? p : null }); })
      .catch(() => { if (alive) setGot({ creator: c, p: null }); });
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [c]);
  // an answer for another creator (the page switched tokens) is never shown
  const res = got && got.creator === c ? got : null;
  const p = res?.p ?? null;

  return (
    <section id="an-dev" className={s.card} aria-labelledby="an-dev-t">
      <CardHead id="an-dev-t" title="The dev" term="dev-sold" meta={c ? <>{shortAddr(c)}{res?.p ? <> · {res.p.chain === "ok" ? "vibe/vibe + chain" : "vibe/vibe · chain unknown"}</> : null}</> : undefined} className={s.head} />
      {!c ? (
        <p className={s.msg}>Creator unknown right now. Unknown, not clean.</p>
      ) : !res ? (
        <div className={s.devBody} role="status" aria-label="Reading the dev's history">
          <i className={s.skRow} />
          <i className={s.skRow} style={{ width: "40%" }} />
        </div>
      ) : !p ? (
        <div className={s.devBody}>
          <p className={s.msg} role="status">Couldn&apos;t read the dev history. Unknown, not clean.</p>
          <Link className={s.devLink} href={`/dev/${c}`} prefetch={false}>Open dev passport →</Link>
        </div>
      ) : (
        <div className={s.devBody}>
          <p className={s.devFacts}>{facts(p)}</p>
          {p.facts[0] && <p className={s.devFact} title={p.facts[0].detail}>{p.facts[0].label}</p>}
          <Link className={s.devLink} href={`/dev/${c}`} prefetch={false}>Open dev passport →</Link>
        </div>
      )}
    </section>
  );
}

function facts(p: DevPassport) {
  // vibe's lists leave the first and legacy factories out: the chain's count (set only when higher) wins
  const launches = p.onChain ? p.onChain.launches : p.total ?? p.loaded;
  const grads = p.onChain ? p.onChain.grads : p.graduated;
  const more = !p.onChain && p.total === null ? "+" : "";
  const { devHeld, soldIn } = p.summary;
  return (
    <>
      <span><b>{fmtInt(launches)}{more}</b> launch{launches === 1 ? "" : "es"}</span>
      <span><b>{fmtInt(grads)}</b> graduated</span>
      {/* in words: "sold in 0 · held own bag in 1" needed a second read */}
      {devHeld === 0 ? (
        <span title="Launches where the dev ever held its own token">Never held own bag</span>
      ) : (
        <span title="Launches where the dev sold its own token into the curve or pool">
          {soldIn === null ? <>Own-bag sales <b title="Unknown, not zero.">unknown</b></>
            : soldIn === 0 ? <>Never sold own bag</>
            : <>Sold own bag in <b className={s.down}>{fmtInt(soldIn)}</b> of {fmtInt(launches)}</>}
          {devHeld !== null && <> · held it in {fmtInt(devHeld)} of {fmtInt(launches)}</>}
        </span>
      )}
    </>
  );
}
