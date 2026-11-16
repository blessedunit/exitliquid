// Shared screener types. NO server imports here: safe for client components.
// Served by GET /api/screener (and the static copy /screener.json).

export type Grade = "A" | "B" | "C" | "D" | "F";
export type Verdict = "clean" | "caution" | "risk" | "unknown";
export type ReasonLevel = "good" | "warn" | "bad";

export type ScreenerBoard = "clean" | "risk" | "sniped" | "devdump" | "realvol" | "whales";

export interface ScreenerReason {
  /** stable id, e.g. "devSold", "snipers", "top10", "wash", "devTrack" */
  id: string;
  /** plain-English fact with a number, e.g. "Dev sold 64%" */
  text: string;
  level: ReasonLevel;
}

export interface ScreenerMetrics {
  /** how many of the first 20 buyers look like snipers */
  snipers20: number | null;
  /** % of supply bought in bundled first-block buys */
  bundledPct: number | null;
  /** % of supply held by top 10 holders (pool/contract excluded) */
  top10Pct: number | null;
  /** % of supply the dev still holds */
  devHoldsPct: number | null;
  /** % of the dev's peak bag he has sold */
  devSoldPct: number | null;
  /** % of volume that is real (not wash) */
  realVolPct: number | null;
  /** % of volume that is wash (same wallet churn) */
  washPct: number | null;
  /** % of volume made by known sniper / farm wallets (wash excluded) */
  botPct: number | null;
  /** % of traders currently in profit */
  profitPct: number | null;
  holders: number | null;
  /** market cap in USD (ETH pairs only; null for a token-paired line: see mcapPair) */
  mcap: number | null;
  /** 24h volume in USD (ETH pairs only; null for a token-paired line: see vol24hPair) */
  vol24h: number | null;
  /** real (non-wash, non-bot) 24h volume in USD (ETH pairs only) */
  realVol24h: number | null;
  /** market cap / 24h volume in pair units (ETH, VIBEVIBE, a stock token...) */
  mcapPair: number | null;
  vol24hPair: number | null;
  /** quote unit of the pair: "ETH", "VIBEVIBE", ticker of a stock token... */
  pairUnit: string | null;
  /** trades in the last 24 h (all-time when the day is unknown) */
  trades24h: number | null;
  /** other launches by this creator (this one excluded) */
  devLaunches: number | null;
  /** of those, how many graduated */
  devGraduated: number | null;
}

export interface ScreenerRow {
  /** token address, lowercase */
  token: string;
  ticker: string;
  name: string;
  image: string | null;
  version: "v1" | "v6";
  /** creator wallet, lowercase; null = unknown */
  creator: string | null;
  grade: Grade | null;
  /** 0..100, higher = cleaner; null when not graded */
  score: number | null;
  verdict: Verdict;
  /** worst first, max 3 */
  reasons: ScreenerReason[];
  metrics: ScreenerMetrics;
  /** minutes since launch; null when unknown */
  ageMin: number | null;
  graduated: boolean;
  /** ms epoch when this row was computed */
  checkedAt?: number;
  /** RULES_VERSION the row was graded under; a row of another version (or none) is served without a grade */
  rulesV?: number;
}

export interface ScreenerResponse {
  /** ms epoch of the snapshot */
  asOf: number;
  /** number of tokens graded in the snapshot */
  checked: number;
  /** present when ?board= was used */
  board?: ScreenerBoard;
  tokens: ScreenerRow[];
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  clean: "Looks clean",
  caution: "Caution",
  risk: "High risk",
  unknown: "Too early to grade",
};
