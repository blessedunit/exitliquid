// The one reading line under the token's grade (SummaryBar): up to 3 of the strongest signals, written as
// a sentence. Pure and client-safe. Signals, not verdicts: never "safe", "buy", "sell" or "avoid".
// Unknown is never clean: nothing read = "Unknown, not clean", some inputs missing = "Partial check: ".
import type { Analytics, Chip } from "./types";

/** the part of the page's analytics state this needs (components/analytics/useTokenAnalytics AnalyticsState) */
export type SummaryInput = {
  a: Analytics | null;
  trouble: "loading" | "rate" | "down" | "notvibe" | null;
};

const pctText = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const RANK: Record<Chip["level"], number> = { high: 0, mid: 1, low: 2, info: 3 };
// Line Health's verdict per grade (lib/health VERDICT, same words): the summary and the card never disagree
const VERDICT: Record<"A" | "B" | "C" | "D" | "F", string> = {
  A: "Few warning signs at the front of this line.",
  B: "Some warning signs at the front of this line.",
  C: "Mixed front: read the reasons before you join.",
  D: "Heavy bot or farm signals at the front of this line.",
  F: "The front of this line is stacked with snipers, farms or dev exits.",
};
// chips that are Line Health's own reasons: the verdict above already speaks for them
const HEALTH_IDS = new Set<Chip["id"]>(["DEVSOLD", "SNP", "FARM", "DEVBAG", "DEVMOVED"]);

/** one chip as a clause of the sentence ("9 known snipers in the first 20"); null = not worth a clause */
function clause(c: Chip, a: Analytics): string | null {
  const h = a.health;
  const s = a.supply.data;
  const front = h?.firstBuyers ?? 20;
  switch (c.id) {
    case "DEVSOLD":
      return s?.devSells ? `the dev sold ${plural(s.devSells, "time")}` : "the dev sold";
    case "SNP":
      return h?.snipers ? `${plural(h.snipers, "known sniper")} in the first ${front}` : null;
    case "FARM":
      return h?.farm ? `${plural(h.farm, "farm wallet")} in the first ${front}` : null;
    case "DEVBAG":
      return s?.creatorPct != null ? `the dev still holds ${pctText(s.creatorPct)}% of supply` : null;
    case "DEVMOVED":
      return "the dev moved tokens to other wallets";
    case "BUNDLE": {
      const b = a.bundle.data;
      if (!b) return null;
      return b.heldPct < 1 && b.boughtPct >= 1
        ? `bundled buyers took ${pctText(b.boughtPct)}% and mostly sold`
        : `bundled buyers still hold ${pctText(b.heldPct)}%`;
    }
    case "SELLWALL": {
      const e = a.exitMath.data;
      return e?.dumpPricePct != null ? `a −${pctText(-e.dumpPricePct)}% sell wall if everyone in profit sells` : null;
    }
    case "BAGS3X": {
      const x3 = a.exitMath.data?.buckets.find((k) => k.id === "x3");
      return x3 ? `${pctText(x3.linePct)}% of the line's tokens sit at 3x+` : null;
    }
    case "TOP10":
      return s ? `the top 10 hold ${pctText(s.top10OfCirculatingPct)}% of held supply` : null;
    case "GIFTED":
      return s ? `${pctText(s.giftedPct)}% of supply came by transfer, not a buy` : null;
    case "FRESH":
      return s?.freshTop10 ? `${s.freshTop10} of the top 10 are fresh wallets` : null;
    case "CLUSTER": {
      // the count rides in the chip itself ("3/10 one funder"), so it reads the same with or without the top-10 rows
      const n = Number(/^(\d+)\/10/.exec(c.label)?.[1] ?? 0);
      return n ? `${n} of the top 10 share one funder` : null;
    }
    case "WASH":
      return "part of the volume is wash";
    case "BOTS":
      return "known bots make part of the volume";
    case "CLONE": {
      const k = a.clones.data;
      return k && !k.isEarliest ? `${k.matches + 1} launches use this ticker and an older one came first` : null;
    }
    default:
      return null;
  }
}

/** some inputs couldn't be read: the line says "Partial check" (the grade carries its own Partial pill) */
export function isPartial(a: Analytics): boolean {
  return !!a.health?.partial || !a.health || !a.bundle.data || !a.supply.data || !a.exitMath.data;
}

export function summaryLine(state: SummaryInput): string {
  const a = state.a;
  if (!a) return state.trouble === "loading" ? "Reading the first 100 buys…" : "Couldn't read the chain yet. Unknown, not clean.";
  // signals only: info chips (a few snipers, "first of ×3") don't make the sentence
  const picked = a.chips
    .filter((c) => !c.quiet && c.level !== "info")
    .map((c, i) => ({ c, i }))
    .sort((x, y) => RANK[x.c.level] - RANK[y.c.level] || x.i - y.i)
    .map(({ c }) => clause(c, a))
    .filter((t): t is string => !!t)
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 3);
  let text: string;
  const h = a.health;
  if (h) {
    // one verdict on the page: Line Health's own words for the grade (the hero never says more than the letter);
    // signals from other cards (bundle, supply, volume) follow as "Also", and only the medium/strong ones:
    // weak ones (ticker reuse, a small bundle) stay chips
    const also = a.chips
      .filter((c) => !c.quiet && !HEALTH_IDS.has(c.id) && (c.level === "high" || c.level === "mid"))
      .map((c, i) => ({ c, i }))
      .sort((x, y) => RANK[x.c.level] - RANK[y.c.level] || x.i - y.i)
      .map(({ c }) => clause(c, a))
      .filter((t): t is string => !!t)
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 2);
    text = VERDICT[h.grade] + (also.length ? ` Also: ${joinList(also)}.` : "");
  } else {
    const strong = a.chips.some((c) => c.level === "high");
    text = picked.length
      ? `${strong ? "Warning signs" : "Some warning signs"}: ${joinList(picked)}.`
      : "No warning signs at the front. Not a clean bill: see Risk.";
  }
  if (isPartial(a)) text = `Partial check: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  if (a.graduated) text += " Graduated: trading is on the V4 pool.";
  return text;
}

function joinList(xs: string[]): string {
  if (xs.length < 2) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}
