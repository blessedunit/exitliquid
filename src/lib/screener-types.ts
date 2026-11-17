// Shared screener types. NO server imports here: safe for client components.
// Served by GET /api/screener (and the static copy /screener.json).

export type Grade = "A" | "B" | "C" | "D" | "F";
/** coarse class of the letter: clean = A/B, caution = C, risk = D/F, unknown = no letter (see NoGrade for why) */
export type Verdict = "clean" | "caution" | "risk" | "unknown";
/** why a row has no letter: younger than 10 min, too little trading to judge, inputs failed, or graded under
 *  older rules and waiting for the re-check */
export type NoGrade = "young" | "thin" | "unread" | "pending";
/** info = a neutral fact (activity), neither praise nor a flag */
export type ReasonLevel = "good" | "info" | "warn" | "bad";

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
  /** real holders: bought on the market and hold a non-dust bag (airdrop-only and dust wallets excluded) */
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
  // ---- v11 (optional: rows graded under older rules lack them; absent = unknown, never good) ----
  /** every non-zero people balance (airdrop and dust included); `holders` is the real-holder count */
  holdersAll?: number | null;
  /** % of the grading window's volume made by the single top wallet; null = unknown */
  top1VolPct?: number | null;
  /** the wallet that bought the most supply and sold it back: % of supply bought / % of that sold; null = unknown */
  pusherBoughtPct?: number | null;
  pusherSoldPct?: number | null;
  pusherIsDev?: boolean | null;
  /** graduated lines: the pair side of the pool; null = unread / on the curve */
  poolEth?: number | null;
  /** unix seconds of the newest trade; null = unknown */
  lastTradeAt?: number | null;
  /** market cap / market cap at launch; null = unknown */
  launchX?: number | null;
  /** what the check could not read (empty = Full check); absent = unknown, never "full" */
  coverage?: string[];
  /** set when grade is null: why there is no letter */
  noGrade?: NoGrade | null;
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

/** the word next to the letter: what the letter says about the risk of becoming someone's exit liquidity */
export const GRADE_WORD: Record<Grade, string> = {
  A: "No red flags found",
  B: "Minor flags",
  C: "Caution",
  D: "High risk",
  F: "Likely exit liquidity",
};
/** the word when there is no letter */
export const NO_GRADE_WORD: Record<NoGrade, string> = {
  young: "Too new",
  thin: "Not enough trading yet",
  unread: "Couldn't read",
  pending: "Checking…",
};
/** the one word for a row / a report: by letter, else by why there is none (unknown reason: "Checking…") */
export function standingWord(grade: Grade | null | undefined, noGrade?: NoGrade | null): string {
  return grade ? GRADE_WORD[grade] : NO_GRADE_WORD[noGrade ?? "pending"];
}
/** the coverage marker: "Full check" only when the check says every input was read */
export function coverageWord(cov: string[] | null | undefined): string {
  if (!cov) return "Partial check";
  return cov.length === 0 ? "Full check" : `Partial: ${cov.join(", ")}`;
}
/** a full check: every input of the grade was read (absent = unknown = not full) */
export const isFullCheck = (cov: string[] | null | undefined): boolean => !!cov && cov.length === 0;
