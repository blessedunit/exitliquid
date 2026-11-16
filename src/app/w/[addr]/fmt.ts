// Number format of the wallet profile: one precision rule.
import { fmtCompact } from "@/lib/format";

/** ETH: 4 decimals under 1, 2 under 1000, compact above; tiny values read "<0.0001", never 0 */
export function eth(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a < 0.0001) return `${sign}<0.0001`;
  if (a >= 1000) return `${sign}${fmtCompact(a)}`;
  return `${sign}${a.toFixed(a >= 1 ? 2 : 4)}`;
}
