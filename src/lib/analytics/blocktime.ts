// Seconds per block, measured, never assumed. Pure (no server-only imports): lib/health.ts and the engines share it.
//
// Robinhood Chain testnet block time drifts: 0.165 s (24.09), 0.183 s (01.10), ~0.2 s (Nov). A fixed constant
// made every "within an hour" / "within 5 minutes" window wrong by 20%+, so the windows are cut by time:
// - a token's Transfer log carries timestamps interpolated between real block-timestamp anchors (chain.loadEvents),
//   so two of its entries give the local block time for free;
// - the engines' chain-wide measurement (engine.secPerBlock: head vs head - 1M) is noted here as the next source.

let lastMeasured: number | null = null;

const sane = (v: number) => v > 0.05 && v < 2;

/** the engine's latest chain-wide measurement (engine.secPerBlock calls this) */
export function noteSecPerBlock(v: number | null): void {
  if (v !== null && sane(v)) lastMeasured = v;
}

/** the latest chain-wide measurement of this process; null = none yet */
export function lastSecPerBlock(): number | null {
  return lastMeasured;
}

/** last resort when nothing was measured yet (RPC down at start): the Nov 2026 rate, used for windows only */
export const FALLBACK_SEC_PER_BLOCK = 0.2;

/**
 * Local seconds per block from timestamped log entries (first and last with a timestamp). Needs 3,000+ blocks
 * between them, so the whole-second rounding of the timestamps stays under 0.2%. null = not measurable here.
 */
export function secPerBlockOf(rows: readonly { block: number; ts: number }[]): number | null {
  let a: { block: number; ts: number } | null = null;
  let b: { block: number; ts: number } | null = null;
  for (const r of rows) {
    if (!(r.ts > 0)) continue;
    if (!a || r.block < a.block) a = r;
    if (!b || r.block > b.block) b = r;
  }
  if (!a || !b || b.block - a.block < 3_000) return null;
  const v = (b.ts - a.ts) / (b.block - a.block);
  return sane(v) ? v : null;
}

/** the measured block time for these rows: the rows' own, else the chain-wide one, else null */
export function measuredSecPerBlock(rows: readonly { block: number; ts: number }[]): number | null {
  return secPerBlockOf(rows) ?? lastMeasured;
}

/** blocks in `sec` seconds at `spb` s/block; null when spb is unknown */
export function blocksIn(sec: number, spb: number | null): number | null {
  return spb && spb > 0 ? Math.max(1, Math.round(sec / spb)) : null;
}
