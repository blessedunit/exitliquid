// Line Health: who stands at the front of a line, scored 0-100 with a letter A-F.
// Signals, not verdicts: every penalty is a reason to look closer, never proof of anything.
//
// Inputs are the token's own full Transfer history (the same raw log the line is built from)
// and the Early Index (src/data/early-index.json, rebuilt hourly by the hourly index job, read at runtime by lib/earlyIndex.ts):
// wallet labels "known sniper bot", "farm group", "verified early".
// Pure logic, no network and no server-only imports: the route feeds it, tests can too.
// Unknown is never zero: a signal we can't read is shown as "unknown" and never penalised.

import type { RawTransfer } from "./chain";

export type EarlyIndex = {
  generatedAt: number; // unix seconds
  windowDays: number;
  tokensScanned: number;
  snipers: string[];
  farms: { id: number; wallets: string[] }[];
  verifiedEarly: string[];
  sniperMinTokens?: number;
  baseGradRate?: number;
};

export type Severity = "good" | "info" | "low" | "medium" | "high" | "unknown";
export type HealthReason = { id: string; label: string; detail: string; severity: Severity; points: number };
export type BuyerTag = "sniper" | `farm:${number}` | "verified" | null;
export type FirstBuyer = { wallet: string; tag: BuyerTag; stillHolds: boolean; exitedFast: boolean };
export type Grade = "A" | "B" | "C" | "D" | "F";

export type HealthResult = {
  token: string;
  grade: Grade;
  score: number;
  verdict: string;
  partial: boolean; // some signals are unknown: the score only covers what could be read
  high: number; // reasons with severity "high"; any of them caps the letter at C
  reasons: HealthReason[]; // worst first
  firstBuyers: FirstBuyer[]; // first 20 distinct buyers, entry order (creator excluded)
  counts: { firstBuyers: number; snipers: number | null; farm: number | null; verified: number | null; stillHolding: number; exitedFirstHour: number }; // null = unknown
  indexAge: number | null; // seconds since the index was built; null = no index
  indexStale: boolean;
};

export type HealthInput = {
  token: string;
  creator: string; // "" = unknown
  curve: string;
  raw: RawTransfer[]; // full history from the launch block (sorted or not)
  plumbing: Set<string>; // protocol contracts, never people
  complete: boolean; // false = history may be missing the start (launch block unknown)
  headBlock: number;
  nowSec: number;
};

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // graduated tokens buy from the V4 pool
const FIRST = 20;
const BONUS_SCAN = 50; // verified-early wallets count anywhere in the first 50
const HOUR_BLOCKS = 22_000; // ~1 h at 0.165 s/block (same as queue MATURE_BLOCKS)
const EXIT_SHARE = 20n; // "walked out" = the bag fell to 5% of its peak or less (the line's 95% exit rule)
const INDEX_MAX_AGE = 14 * 86400; // older than this, labels are too old to lean on: unknown
const MIN_BUYERS = 5; // below this the front of the line isn't formed yet

type Labels = { sniper: Set<string>; farm: Map<string, number>; verified: Set<string> };
const labelCache = new WeakMap<EarlyIndex, Labels>();
function labelsOf(ix: EarlyIndex): Labels {
  let l = labelCache.get(ix);
  if (!l) {
    const farm = new Map<string, number>();
    for (const f of ix.farms) for (const w of f.wallets) farm.set(w.toLowerCase(), f.id);
    l = {
      sniper: new Set(ix.snipers.map((w) => w.toLowerCase())),
      farm,
      verified: new Set(ix.verifiedEarly.map((w) => w.toLowerCase())),
    };
    labelCache.set(ix, l);
  }
  return l;
}

/** sniper bands (first 20 buyers), calibrated on the live board 01.10 */
export const SNIPERS_HIGH = 12;
export const SNIPERS_MEDIUM = 6;

/** any HIGH reason caps the letter at C: a green A/B next to a red reason sends two opposite messages */
export function capGrade(g: Grade, high: number): Grade {
  return high > 0 && (g === "A" || g === "B") ? "C" : g;
}

export function gradeFor(score: number): Grade {
  return score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";
}

const VERDICT: Record<Grade, string> = {
  A: "Few warning signs at the front of this line.",
  B: "Some warning signs at the front of this line.",
  C: "Mixed front: read the reasons before you join.",
  D: "Heavy bot or farm signals at the front of this line.",
  F: "The front of this line is stacked with snipers, farms or dev exits.",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function computeHealth(input: HealthInput, index: EarlyIndex | null): HealthResult {
  const { creator, curve, plumbing } = input;
  const c = curve.toLowerCase();
  const raw = [...input.raw].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const reasons: HealthReason[] = [];

  // ---- replay: first buyers, balances, peaks, when each first buyer walked out ----
  const bal = new Map<string, bigint>();
  const peak = new Map<string, bigint>();
  const firstBuyBlock = new Map<string, number>();
  const exitBlock = new Map<string, number>(); // first time the bag fell to <= 5% of peak after buying
  const order: string[] = [];
  const devSellTx = new Set<string>();
  let devSells = 0;
  const devGiftTo = new Set<string>();
  const isMarket = (a: string) => a === c || a === POOL_MANAGER;

  // tx hashes where the creator's tokens went to the curve/pool: a sell, not a gift
  for (const r of raw) if (creator && r.from === creator && (r.to === c || plumbing.has(r.to)) && r.tx) devSellTx.add(r.tx);

  for (const r of raw) {
    if (r.value <= 0n) continue;
    if (!plumbing.has(r.to) && r.to !== c) {
      const nb = (bal.get(r.to) ?? 0n) + r.value;
      bal.set(r.to, nb);
      if (nb > (peak.get(r.to) ?? 0n)) peak.set(r.to, nb);
      if (isMarket(r.from) && r.to !== creator && !firstBuyBlock.has(r.to)) {
        firstBuyBlock.set(r.to, r.block);
        order.push(r.to);
      }
    }
    if (!plumbing.has(r.from) && r.from !== c) {
      let nb = (bal.get(r.from) ?? 0n) - r.value;
      if (nb < 0n) nb = 0n;
      bal.set(r.from, nb);
      const pk = peak.get(r.from) ?? 0n;
      if (firstBuyBlock.has(r.from) && !exitBlock.has(r.from) && pk > 0n && nb * EXIT_SHARE <= pk) exitBlock.set(r.from, r.block);
      if (creator && r.from === creator) {
        if (r.to === c || plumbing.has(r.to)) devSells += 1;
        else if (!(r.tx && devSellTx.has(r.tx))) devGiftTo.add(r.to);
      }
    }
  }

  // ---- labels ----
  const nowSec = input.nowSec;
  const indexAge = index ? Math.max(0, nowSec - index.generatedAt) : null;
  const indexStale = indexAge === null || indexAge > INDEX_MAX_AGE;
  const labels = index && !indexStale ? labelsOf(index) : null;
  const tagOf = (w: string): BuyerTag => {
    if (!labels) return null;
    if (labels.sniper.has(w)) return "sniper";
    const f = labels.farm.get(w);
    if (f !== undefined) return `farm:${f}`;
    if (labels.verified.has(w)) return "verified";
    return null;
  };
  const holds = (w: string) => {
    const pk = peak.get(w) ?? 0n;
    const b = bal.get(w) ?? 0n;
    return pk > 0n && b * EXIT_SHARE > pk;
  };

  const first = order.slice(0, FIRST);
  const firstBuyers: FirstBuyer[] = first.map((w) => {
    const eb = exitBlock.get(w);
    return { wallet: w, tag: tagOf(w), stillHolds: holds(w), exitedFast: eb !== undefined && eb - firstBuyBlock.get(w)! <= HOUR_BLOCKS };
  });
  const formed = input.complete && first.length >= MIN_BUYERS;
  const n = first.length;
  let score = 100;

  // ---- 1. known sniper bots among the first 20 ----
  const snipers = firstBuyers.filter((b) => b.tag === "sniper").length;
  if (!labels || !formed) {
    reasons.push({
      id: "snipers",
      label: "Snipers up front",
      detail: !labels ? (index ? "Wallet index too old: unknown." : "No wallet index loaded: unknown.") : notFormed(input, n),
      severity: "unknown",
      points: 0,
    });
  } else {
    // 8+ known snipers in the first 20 is the norm on vibe (measured 01.10: 26 of 29 Hot/New lines had 6+,
    // median 11), so the old cap of -30 at 10 snipers drew every hot line as the same B 70. The penalty now
    // keeps rising to 15 snipers and the bands sit on that spread: 12+ is high (and caps the letter at C).
    const p = Math.min(45, 3 * snipers);
    score -= p;
    reasons.push({
      id: "snipers",
      label: snipers ? `${plural(snipers, "known sniper")} in the first ${n}` : `No known snipers in the first ${n}`,
      detail: snipers
        ? `Wallets that bought among the first 20 of ${index!.sniperMinTokens ?? 15}+ launches in ${index!.windowDays} days, no better than chance at picking winners. They usually sell into the line.`
        : "No first buyer is on the sniper list (the index covers the last few days).",
      severity: snipers >= SNIPERS_HIGH ? "high" : snipers >= SNIPERS_MEDIUM ? "medium" : snipers ? "low" : "good",
      points: -p,
    });
  }

  // ---- 2. farm group among the first 20 ----
  const farmIds = new Map<number, number>();
  for (const b of firstBuyers) if (b.tag?.startsWith("farm:")) farmIds.set(Number(b.tag.slice(5)), (farmIds.get(Number(b.tag.slice(5))) ?? 0) + 1);
  const farmCount = [...farmIds.values()].reduce((s, v) => s + v, 0);
  if (!labels || !formed) {
    reasons.push({ id: "farm", label: "Farm group up front", detail: !labels ? "No usable wallet index: unknown." : notFormed(input, n), severity: "unknown", points: 0 });
  } else {
    const biggest = Math.max(0, ...farmIds.values());
    const p = farmCount >= 2 ? Math.min(25, 5 * farmCount) : farmCount * 3;
    score -= p;
    const sizes = [...farmIds.entries()].sort((a, b) => b[1] - a[1]).map(([id, k]) => `group #${id}: ${k}`).join(", ");
    reasons.push({
      id: "farm",
      label: farmCount ? `${plural(farmCount, "wallet")} from ${plural(farmIds.size, "farm group")} in the first ${n}` : `No known farm group in the first ${n}`,
      detail: farmCount
        ? `Wallets that keep buying the first minutes of the same launches together (${sizes}). Often one operator.`
        : "No first buyer belongs to a known co-entry group.",
      severity: biggest >= 5 || farmCount >= 6 ? "high" : farmCount >= 2 ? "medium" : farmCount ? "low" : "good",
      points: -p,
    });
  }

  // ---- 3. dev sold / moved tokens out (whole history) ----
  if (!creator || !input.complete) {
    reasons.push({ id: "dev", label: "Dev sells", detail: "Creator or start of history not loaded: unknown.", severity: "unknown", points: 0 });
  } else {
    const p = (devSells ? 15 : 0) + (devGiftTo.size ? 10 : 0);
    score -= p;
    const parts = [devSells ? `sold ${plural(devSells, "time")}` : "", devGiftTo.size ? `moved tokens to ${plural(devGiftTo.size, "other wallet")}` : ""].filter(Boolean);
    reasons.push({
      id: "dev",
      label: parts.length ? `Dev ${parts.join(" and ")}` : "Dev hasn't sold or moved tokens",
      detail: parts.length
        ? "Whole history. Moving tokens out can be a quiet way to sell later."
        : "No sells or transfers out from the creator, whole history.",
      severity: devSells ? "high" : devGiftTo.size ? "medium" : "good",
      points: -p,
    });
  }

  // ---- 4. fast exits: first buyers who walked out within an hour ----
  const fast = firstBuyers.filter((b) => b.exitedFast).length;
  if (!formed) {
    reasons.push({ id: "fast_exits", label: "First-hour exits", detail: notFormed(input, n), severity: "unknown", points: 0 });
  } else {
    const share = fast / n;
    const p = Math.round(20 * share);
    score -= p;
    const young = input.headBlock - (firstBuyBlock.get(first[0]) ?? input.headBlock) < HOUR_BLOCKS;
    reasons.push({
      id: "fast_exits",
      label: `${fast} of the first ${n} walked out within an hour`,
      detail: `Sold 95% or more of their bag within ~1 h of buying.${young ? " First hour not over yet." : ""}`,
      severity: share >= 0.5 ? "high" : share >= 0.25 ? "medium" : fast ? "low" : "good",
      points: -p,
    });
  }

  // ---- 5. retention: first buyers still holding ----
  const holding = firstBuyers.filter((b) => b.stillHolds).length;
  if (!formed) {
    reasons.push({ id: "retention", label: "First buyers still holding", detail: notFormed(input, n), severity: "unknown", points: 0 });
  } else {
    const share = holding / n;
    const p = share < 0.3 ? 10 : 0;
    score -= p;
    reasons.push({
      id: "retention",
      label: `${holding} of the first ${n} still hold`,
      detail: "Still hold more than 5% of their peak bag.",
      severity: share < 0.3 ? "medium" : share < 0.5 ? "low" : "good",
      points: -p,
    });
  }

  // ---- bonus: verified-early wallets in the first 50 ----
  const verified = labels ? order.slice(0, BONUS_SCAN).filter((w) => labels.verified.has(w)).length : 0;
  if (labels && verified) {
    const p = Math.min(10, 5 * verified);
    score += p;
    reasons.push({
      id: "verified",
      label: `${plural(verified, "verified-early wallet")} in the first ${Math.min(BONUS_SCAN, order.length)}`,
      detail: "Their early entries graduated well above chance in the index window.",
      severity: "good",
      points: p,
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  // a HIGH reason never sits under a "fine" letter: the grade is capped at C (the score stays as computed)
  const high = reasons.filter((r) => r.severity === "high").length;
  const grade = capGrade(gradeFor(score), high);
  // a grade built on missing signals says so up front (unknown is never "clean")
  const unknown = reasons.filter((r) => r.severity === "unknown").length;
  const partial = unknown > 0;
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, unknown: 3, info: 4, good: 5 };
  reasons.sort((a, b) => rank[a.severity] - rank[b.severity] || a.points - b.points);

  return {
    token: input.token,
    grade,
    score,
    verdict: partial ? `Partial check (${plural(unknown, "signal")} unknown). ${VERDICT[grade]}` : VERDICT[grade],
    partial,
    high,
    reasons,
    firstBuyers,
    counts: {
      firstBuyers: n,
      snipers: labels ? snipers : null,
      farm: labels ? farmCount : null,
      verified: labels ? verified : null,
      stillHolding: holding,
      exitedFirstHour: fast,
    },
    indexAge,
    indexStale,
  };
}

function notFormed(input: HealthInput, n: number): string {
  if (!input.complete) return "The start of this token's history isn't loaded: unknown.";
  return `Only ${plural(n, "buyer")} so far: the front of the line isn't formed yet.`;
}
