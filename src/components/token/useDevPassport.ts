"use client";
// The creator's passport (/api/dev/<creator>/passport), read once per creator for the token report:
// the verdict's "dev track record" reason and the Dev section's record both read it.
import { useEffect, useState } from "react";
import type { DevPassport } from "@/lib/devrep";
import { devTrack, type DevTrack } from "@/lib/screener-rules";

export type PassportState = { p: DevPassport | null; loading: boolean };

export function useDevPassport(creator: string | null): PassportState {
  const c = creator && /^0x[0-9a-f]{40}$/i.test(creator) ? creator.toLowerCase() : null;
  const [got, setGot] = useState<{ c: string; p: DevPassport | null } | null>(null);
  useEffect(() => {
    if (!c) return;
    let alive = true;
    const ctl = new AbortController();
    // a read that never answers must not hold the page's letter forever: after 20 s it counts as failed
    const giveUp = setTimeout(() => ctl.abort(), 20_000);
    fetch(`/api/dev/${c}/passport`, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<DevPassport>) : null))
      .then((p) => { if (alive) setGot({ c, p: p && Array.isArray(p.launches) ? p : null }); })
      .catch(() => { if (alive) setGot({ c, p: null }); })
      .finally(() => clearTimeout(giveUp));
    return () => {
      alive = false;
      clearTimeout(giveUp);
      ctl.abort();
    };
  }, [c]);
  const mine = got && got.c === c ? got : null;
  return { p: mine?.p ?? null, loading: !!c && !mine };
}

export type TrackRecord = {
  /** other launches by this creator (this one excluded) */
  others: number;
  /** of those, graduated */
  graduated: number;
  /** of those, launches where the dev sold half or more of what he got; null = chain unknown */
  dumped: number | null;
  /** launches the chain read covers (for "dumped x of y") */
  dumpChecked: number;
  /** count may be higher (vibe gave no total) */
  more: boolean;
  /** what the grade reads (lib/screener-rules devTrack, the same count as the boards); null = not checked */
  forGrade: DevTrack;
  recent: { token: string; symbol: string; createdAt: number; graduated: boolean; progressBps: number; soldPct: number | null }[];
};

/** the dev's other launches, from the passport; null = unknown */
export function trackRecord(p: DevPassport | null, token: string | null): TrackRecord | null {
  if (!p) return null;
  const t = token?.toLowerCase() ?? "";
  // the same count as the screener (lib/screener devTrackOf): vibe's list, or the factory history when it is longer
  const list = p.launches.filter((l) => l.token.toLowerCase() !== t);
  const self = p.launches.find((l) => l.token.toLowerCase() === t);
  const selfGrad = self?.graduated ? 1 : 0;
  const listed = p.total ?? p.loaded;
  const chain = !!p.onChain && p.onChain.launches > listed;
  const others = Math.max(0, (chain ? p.onChain!.launches : listed) - 1);
  const graduated = Math.max(0, (chain ? p.onChain!.grads : p.graduated) - selfGrad);
  const read = list.filter((l) => l.dev && l.dev.soldBps !== null);
  const dumped = read.length ? read.filter((l) => (l.dev!.soldBps ?? 0) >= 5000).length : null;
  return {
    others,
    graduated,
    dumped,
    dumpChecked: read.length,
    forGrade: devTrack(p, t),
    more: !p.onChain && p.total === null,
    recent: list.slice(0, 5).map((l) => ({
      token: l.token, symbol: l.symbol, createdAt: l.createdAt, graduated: l.graduated, progressBps: l.progressBps,
      soldPct: l.dev && l.dev.soldBps !== null ? l.dev.soldBps / 100 : null,
    })),
  };
}
