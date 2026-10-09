// Pure formatting for /state: no server imports, so the client board and lib/state.ts can both use it.
// Unknown is "—" or a dropped sentence, never 0, NaN or "undefined".
import type { StateSnapshot } from "@/lib/state";
import { fmtInt } from "@/lib/format";

const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function fmtDur(sec: number | null | undefined): string {
  if (!ok(sec)) return "—";
  if (sec < 60) return "<1m";
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(sec < 36_000 ? 1 : 0)}h`;
  return `${(sec / 86_400).toFixed(sec < 864_000 ? 1 : 0)}d`;
}

/** a duration in words for prose: "22 days", "5.4 hours" */
function durWords(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
  if (sec < 86_400) {
    const h = sec / 3600;
    return `${h.toFixed(h < 10 ? 1 : 0)} hours`;
  }
  const d = sec / 86_400;
  const v = d.toFixed(d < 10 ? 1 : 0);
  return `${v} ${v === "1" || v === "1.0" ? "day" : "days"}`;
}

/** a share 0..1 as a percent; tiny shares keep their digits (0.010%, never "0%") */
export function fmtShare(x: number | null | undefined): string {
  if (!ok(x)) return "—";
  if (x === 0) return "0%";
  const p = x * 100;
  if (p < 0.1) return "<0.1%"; // tiny shares read as noise at 3 decimals
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${p.toFixed(0)}%`;
}

/** the /state lead: one sentence per fact that is already computed. A missing field drops its sentence. */
export function stateHeadline(d: StateSnapshot | null | undefined): string[] {
  if (!d) return [];
  const out: string[] = [];
  const t = d.totals;

  // two different cohorts, never in one breath: graduations this week (any launch date) vs this week's launches
  // that already graduated. Side by side they read as a wrong ratio (751 of 50,675 is not 0.1%).
  if (ok(t?.grads7d)) out.push(`${fmtInt(t.grads7d)} tokens graduated this week (any launch date).`);
  const c = t?.cohort;
  if (ok(t?.launches7d)) {
    out.push(
      c && c.launched > 0 && ok(c.graduated)
        ? `Of this week's ${fmtInt(c.launched)} launches, ${fmtInt(c.graduated)} (${fmtShare(c.graduated / c.launched)}) have graduated so far.`
        : `${fmtInt(t.launches7d)} launches this week.`,
    );
  }

  if (d.ttg && ok(d.ttg.medianS) && d.ttg.n > 0) out.push(`Median time to graduation: ${durWords(d.ttg.medianS)}.`);

  const x = d.snipers;
  if (x && x.formed > 0 && ok(x.withFive)) out.push(`${fmtShare(x.withFive / x.formed)} of formed lines had 5+ known snipers among the first 20 buyers.`);

  return out;
}
