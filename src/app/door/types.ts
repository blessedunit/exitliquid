// Graduation watch: shapes shared by the server snapshot (data.ts) and the page (client).

export type Phase = "walking" | "stalled" | "unknown" | "door";

export type NearCard = {
  token: string;
  symbol: string;
  name: string;
  image: string | null;
  createdAt: number;
  progressBps: number;
  holders: number | null;
  /** ETH still missing before the door; null = unknown */
  remainingEth: number | null;
  vol1hEth: number | null;
  buys1h: number | null;
  sells1h: number | null;
  buyers1h: number | null;
  change1hBps: number | null;
  /** net ETH inflow per hour over the last 24 h (or since launch); null = not read */
  dayPaceEth: number | null;
  /** hours to the door: fast end (the quicker of the two paces) and slow end (the board's ETA); null = no honest estimate */
  etaLoH: number | null;
  etaHiH: number | null;
  /** door % change seen by this server over `deltaMin` minutes (own samples, >= 10 min); null = no sample old enough */
  deltaBps: number | null;
  deltaMin: number | null;
  phase: Phase;
  /** why it is stalled, in a few words */
  why: string | null;
};

export type GradRow = {
  token: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  gradTs: number;
  holders: number | null;
  vol24hEth: number | null;
  /** price 1 h after the door vs the pool's opening price (fraction); null = under an hour / unknown */
  ret1h: number | null;
  /** "chain": V4 pool swaps (State of vibe); "candles": 15 min closes (approximate) */
  ret1hSrc: "chain" | "candles" | null;
  /** last close vs the close at the door (fraction), from 15 min candles; null = unknown */
  sinceDoor: number | null;
  /** 15 min closes from the door to now, normalised 0..1000 (empty = unknown) */
  path: number[];
};

export type DoorSnap = {
  builtAt: number; // ms
  /** null = the list did not answer (unknown, never "nobody") */
  near: NearCard[] | null;
  /** tokens at 85 %+ that vibe lists (page cap 200) */
  total85: number | null;
  /** at 85 %+ with buys this hour but beyond the ETA budget (pace not checked) */
  unchecked: NearCard[];
  grads: GradRow[] | null;
  /** the +1h after-the-door figures: when the State snapshot was built (s); null = none on this server */
  stateAt: number | null;
  notes: string[];
};

/** Ordering for the page: at the door first, then walking by ETA, then unknown by door %. */
export function splitNear(near: NearCard[]) {
  const go = near.filter((c) => c.phase !== "stalled");
  go.sort((a, b) => {
    const r = (c: NearCard) => (c.phase === "door" ? 0 : c.phase === "walking" ? 1 : 2);
    return r(a) - r(b) || (a.etaHiH ?? Infinity) - (b.etaHiH ?? Infinity) || b.progressBps - a.progressBps;
  });
  const stalled = near.filter((c) => c.phase === "stalled").sort((a, b) => b.progressBps - a.progressBps);
  return { go, stalled };
}
