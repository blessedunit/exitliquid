// The Known snipers list of the /w landing, from the Early Index. Server only.
// A missing or too-old index is null (unknown), never [].
import "server-only";
import { earlyIndex, earlyIndexAgeSec } from "./earlyIndex";

const INDEX_MAX_AGE = 14 * 86_400; // same trust window as the wallet tags

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export type SniperSet = {
  total: number;
  sample: string[]; // spread across the whole (sorted) list, not just its head
  /** the most active snipers by first-20 entries (empty when the index has no counts yet) */
  top: { address: string; entries: number }[];
  /** every known sniper counted once, by band of first-20 entries (low -> high); empty without counts */
  bands: { from: number; to: number | null; n: number }[];
  /** first-20 entries of every counted sniper, summed: all of them, the top 3 and #4-10 (0 without counts) */
  entries: { all: number; top3: number; next7: number; counted: number };
  windowDays: number | null;
  tokensScanned: number | null;
  minTokens: number | null;
  ageSec: number;
} | null;

/** The Early Index sniper wallets (null = the index is too old to trust: labels unknown) */
export function knownSnipers(n = 12): SniperSet {
  const age = earlyIndexAgeSec();
  if (age > INDEX_MAX_AGE) return null;
  const ix = earlyIndex();
  const all = [...new Set(ix.snipers.map((w) => w.toLowerCase()).filter(isAddr))].sort();
  const step = Math.max(1, Math.floor(all.length / n));
  const sample: string[] = [];
  for (let i = 0; i < all.length && sample.length < n; i += step) sample.push(all[i]);
  const counts = ix.sniperEntries && typeof ix.sniperEntries === "object" ? ix.sniperEntries : {};
  const ranked = Object.entries(counts)
    .map(([a, e]) => ({ address: a.toLowerCase(), entries: Number(e) }))
    .filter((x) => isAddr(x.address) && Number.isFinite(x.entries) && x.entries > 0)
    .sort((a, b) => b.entries - a.entries || (a.address < b.address ? -1 : 1));
  const top = ranked.slice(0, n);
  // bands of entries: from the index's own floor up, 20 / 50 / 100 above it
  const floor = Math.max(1, num(ix.sniperMinTokens) ?? Math.min(...ranked.map((x) => x.entries), 10));
  const edges = [floor, ...[20, 50, 100].filter((e) => e > floor)];
  const bands = ranked.length
    ? edges.map((from, i) => {
        const to = i + 1 < edges.length ? edges[i + 1] - 1 : null;
        return { from, to, n: ranked.filter((x) => x.entries >= from && (to === null || x.entries <= to)).length };
      })
    : [];
  return {
    total: all.length,
    sample,
    top,
    bands,
    entries: {
      all: ranked.reduce((a, x) => a + x.entries, 0),
      top3: ranked.slice(0, 3).reduce((a, x) => a + x.entries, 0),
      next7: ranked.slice(3, 10).reduce((a, x) => a + x.entries, 0),
      counted: ranked.length,
    },
    windowDays: num(ix.windowDays),
    tokensScanned: num(ix.tokensScanned),
    minTokens: num(ix.sniperMinTokens),
    ageSec: age,
  };
}
