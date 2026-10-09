// One way to print numbers across the site (tape, stats, board, My lines, leaderboard).

/** ETH amount, no unit: 3 significant digits, no trailing zeros. 2.465 -> "2.47", 0.000366 -> "0.000366". */
export function fmtEth(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a < 0.000001) return v < 0 ? "−<0.000001" : "<0.000001";
  if (a >= 1000) return fmtCompact(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  // below 1: three significant digits, written out (never 1e-5)
  const digits = Math.min(12, 2 - Math.floor(Math.log10(a)));
  return v.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** Counts and token amounts: 94 -> "94", 6200 -> "6.2K", 139000 -> "139K", 19640000 -> "19.6M". */
export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const unit = (d: number, s: string) => {
    const x = v / d;
    const t = Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, "");
    return `${t}${s}`;
  };
  if (a >= 1e9) return unit(1e9, "B");
  if (a >= 1e6) return unit(1e6, "M");
  if (a >= 1e3) return unit(1e3, "K");
  if (a > 0 && a < 1) return "<1";
  return v.toFixed(0);
}

/** Whole numbers with thousands separators. */
export const fmtInt = (v: number) => v.toLocaleString("en-US");

/** Age from seconds: 42s, 18m, 5h, 3d. */
export function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Basis points as a percent with one decimal: 6437 -> "64.4%". */
export const fmtPct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/** Percent with honest small values: 0 -> "0%", 0.004 -> "<0.1%", 7.37 -> "7.4%", 53.5 -> "54%".
 *  Never prints a signed zero: anything that rounds to 0 loses its sign ("0%" / "<0.1%"). */
export function pct(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0%";
  const sign = signed && v > 0 ? "+" : v < 0 ? "−" : "";
  if (a < 0.1) return `${sign}<0.1%`;
  return `${sign}${a >= 10 ? a.toFixed(0) : a.toFixed(1)}%`; // below 10 always one decimal: 1.0% next to 1.6%
}

/** An 18-decimal token balance (wei string or bigint) in compact form. */
export function fmtTokens(wei: string | bigint): string {
  try {
    return fmtCompact(Number(BigInt(wei) / 10n ** 15n) / 1000);
  } catch {
    return "—";
  }
}

/** A wallet or contract address: 0x4616…d3be (one ellipsis glyph, never "..."). */
export function shortAddr(a: string | null | undefined, head = 6, tail = 4): string {
  if (!a) return "—";
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}
