// Line Health chips, one rule set for the board row (app/launches/signals.ts) and the token page's
// Signals strip (lib/analytics/chips.ts): same words, same ranks, same bands, so the red flag that
// made someone click a row is the first thing they see on the token page. Pure, client-safe.
// Words, not codes: "9 snipers", "Dev holds 3%" (sentence case; the UI adds a ! or · glyph by tone).
import { SNIPERS_HIGH, SNIPERS_MEDIUM } from "./health";

export type HealthTone = "bad" | "warn" | "plain";
export type HealthChipId = "DEVSOLD" | "SNP" | "FARM" | "DEVBAG" | "DEVMOVED";
export type HealthChip = { id: HealthChipId; rank: number; text: string; tone: HealthTone; title: string };

/** 5% of supply still in the creator's wallet */
export const DEV_BIG_BPS = 500;

export type HealthChipInput = {
  /** the creator's sells / wallets it moved tokens to, whole history; null = unknown */
  devSells: number | null;
  devMovedTo: number | null;
  /** creator's bag in bps of supply; null = unknown */
  devHoldsBps: number | null;
  /** known snipers / farm wallets among the first buyers; null = unknown */
  snipers: number | null;
  farm: number | null;
  firstBuyers: number | null;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const pctBps = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;

/** worst first: dev sold (0), heavy snipers (1), farm (2), a big dev bag (3), some snipers (4), dev moved tokens (6) */
export function healthChips(s: HealthChipInput): HealthChip[] {
  const out: HealthChip[] = [];
  const front = s.firstBuyers ?? 20;
  if (s.devSells !== null && s.devSells > 0) out.push({ id: "DEVSOLD", rank: 0, text: "Dev sold", tone: "bad", title: `The creator sold ${plural(s.devSells, "time")} (whole history).` });
  if (s.snipers) {
    const heavy = s.snipers >= SNIPERS_HIGH;
    out.push({
      id: "SNP",
      rank: heavy ? 1 : 4,
      text: plural(s.snipers, "sniper"),
      tone: heavy ? "bad" : s.snipers >= SNIPERS_MEDIUM ? "warn" : "plain",
      title: `${plural(s.snipers, "known sniper bot")} among the first ${front} buyers.`,
    });
  }
  if (s.farm) out.push({ id: "FARM", rank: 2, text: plural(s.farm, "farm wallet"), tone: s.farm >= 2 ? "bad" : "warn", title: `${plural(s.farm, "wallet")} from known farm groups among the first ${front} buyers.` });
  // a big bag still in the creator's wallet: room for one large sell
  if (s.devHoldsBps !== null && s.devHoldsBps >= DEV_BIG_BPS)
    out.push({ id: "DEVBAG", rank: 3, text: `Dev holds ${pctBps(s.devHoldsBps)}`, tone: "warn", title: `The creator still holds ${pctBps(s.devHoldsBps)} of supply.` });
  if (s.devSells === 0 && s.devMovedTo !== null && s.devMovedTo > 0)
    out.push({ id: "DEVMOVED", rank: 6, text: "Dev moved tokens", tone: "warn", title: `The creator moved tokens to ${plural(s.devMovedTo, "other wallet")}. Can be a quiet way to sell later.` });
  return out.sort((a, b) => a.rank - b.rank);
}
