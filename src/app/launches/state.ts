// Board state that lives in the URL (?tab=&sort=&p=&q=&f=): "back" from a line returns to the same board.
// Shared by the server page (first render) and the client board (updates via history.replaceState).

export type Tab = "hot" | "new" | "door" | "grad" | "watch";
export type Period = "1h" | "24h";
export type SortKey = "rank" | "new" | "door" | "eta" | "holders" | "vol" | "chg" | "buys" | "sig";
export type Dir = "desc" | "asc";
export type BoardState = { tab: Tab; sort: SortKey; dir: Dir; period: Period; q: string; filters: FilterId[] };

export const TAB_IDS: Tab[] = ["hot", "new", "door", "grad", "watch"];
export const SORT_KEYS: SortKey[] = ["rank", "new", "door", "eta", "holders", "vol", "chg", "buys", "sig"];
export const DEFAULT_SORT: Record<Tab, SortKey> = { hot: "rank", new: "new", door: "door", grad: "rank", watch: "rank" };
// ETA reads best soonest-first; everything else biggest-first
export const naturalDir = (k: SortKey): Dir => (k === "eta" ? "asc" : "desc");

type Params = { get(name: string): string | null };

// board filters (?f=clean,nosnipe,…): applied on the client to the rows already loaded (see ./signals)
export type FilterId = "clean" | "nosnipe" | "dev" | "soon" | "fresh";
export const FILTER_IDS: FilterId[] = ["clean", "nosnipe", "dev", "soon", "fresh"];
export function parseFilters(v: string | null): FilterId[] {
  const want = new Set((v ?? "").split(",").map((x) => x.trim()));
  return FILTER_IDS.filter((f) => want.has(f)); // canonical order, no dupes, unknown ids dropped
}

export function cleanQuery(v: string | null | undefined): string {
  return (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
}

export function parseBoard(sp: Params): BoardState {
  const tab = TAB_IDS.find((t) => t === sp.get("tab")) ?? "hot";
  const [k, d] = (sp.get("sort") ?? "").split("-");
  const sort = SORT_KEYS.find((s) => s === k) ?? DEFAULT_SORT[tab];
  const dir: Dir = d === "asc" || d === "desc" ? d : naturalDir(sort);
  const period: Period = sp.get("p") === "1h" ? "1h" : "24h";
  const q = tab === "watch" ? "" : cleanQuery(sp.get("q"));
  const filters = parseFilters(sp.get("f"));
  return { tab, sort, dir, period, q, filters };
}

/** query string for a state; defaults are left out so a plain /launches stays plain */
export function boardQuery(s: BoardState): string {
  const p = new URLSearchParams();
  if (s.tab !== "hot") p.set("tab", s.tab);
  if (s.sort !== DEFAULT_SORT[s.tab] || s.dir !== naturalDir(s.sort)) p.set("sort", s.dir === naturalDir(s.sort) ? s.sort : `${s.sort}-${s.dir}`);
  if (s.period !== "24h") p.set("p", s.period);
  if (s.q) p.set("q", s.q);
  if (s.filters.length) p.set("f", s.filters.join(","));
  const str = p.toString().replace(/%2C/g, ","); // ?f=clean,soon reads better than clean%2Csoon
  return str ? `?${str}` : "";
}
