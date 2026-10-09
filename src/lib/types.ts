// Wire format shared by API routes and client components (bigints as strings).
import type { Skin } from "@/lib/skins";

export type Mode = "live" | "demo" | "mock";

export type WireEntry = {
  wallet: string;
  place: number;
  balance: string;
  lp: number;
  skin: Skin;
  tier: number;
  behind: number;
  ahead: number;
  isCreator: boolean;
  enteredTs: number;
  entryTokens: number;
  entryValueEth: number;
  positionCostEth: number;
  entries: number;
};

export type WireExit = {
  wallet: string;
  exitedAtPlace: number;
  lpReleased: number;
  exitedTs: number;
  behindAtExit: number;
  tx?: string;
};

export type WireFeed =
  | { kind: "join"; wallet: string; place: number; ahead: number; ts: number; tx?: string }
  | { kind: "exit"; wallet: string; place: number; behind: number; ts: number; tx?: string }
  | { kind: "bag"; wallet: string; place: number; up: boolean; ts: number; tx?: string };

export type WireTrade = {
  side: "buy" | "sell";
  wallet: string;
  tokens: number;
  priceEth: number;
  /** ETH paid for this buy incl. the 1.25% fee (curve: exact; pool: the tx value). */
  buyCostEth?: number | null;
  buyCostExact?: boolean;
  /** ETH received for a sell after the fee (curve: exact; pool: estimated, see `estimated`). */
  sellValueEth?: number | null;
  ts: number;
  tx?: string;
  estimated?: boolean; // amount is an estimate (pool sells after graduation); curve trades are exact
};

export type CurveInfo = {
  progressBps: number; // 0..10000
  raisedEth: number;
  targetEth: number;
  graduated: boolean;
};

export type QueueResponse = {
  mode: Mode;
  token: string;
  name: string;
  symbol: string;
  creator: string;
  updatedAt: number; // unix ms
  block: number;
  ethUsd: number | null;
  markPriceEth: number | null; // indicative ETH per token, not a sell quote
  markPriceTs: number | null;
  curve: CurveInfo;
  totals: { inLine: number; exited: number; everJoined: number; lpIssued: number };
  line: WireEntry[]; // first N of the line
  lineTruncated: boolean;
  exits: WireExit[];
  feed: WireFeed[];
  trades: WireTrade[]; // newest last, used by the compact buy/sell chart
  note?: string; // human-readable status, e.g. why we are in mock mode
  unavailable?: boolean; // chain unreachable: unknown, not zero
};

export type MoodResponse = {
  mood: "panic" | "normal" | "calm" | "unknown";
  multiplier: number;
  avgChangePct: number | null;
  asOf: string | null; // market date of the quotes
  quotes: { symbol: string; changePct: number | null; close: number | null }[];
  source: string;
};

export type TicketResponse = {
  mode: Mode;
  token: string;
  wallet: string;
  status: "in_line" | "exited" | "never" | "unknown";
  entry?: WireEntry;
  exit?: WireExit;
  inLine: number;
  group?: string;
  tierName?: string;
  stockBacked: { symbol: string; balance: string }[] | null; // null = unknown
  multiplier: number; // game multiplier from bag + stocks
  pnl?: TicketPnl; // only for wallets in line
};

export type TicketPnl = {
  sellQuoteEth: number | null; // what selling the whole bag on the curve returns right now, after the fee (quoteSell)
  graduated: boolean;
  markPriceEth: number | null; // after graduation: median ETH/token of recent pool buys
  markPriceTs: number | null;
  ethUsd: number | null; // display only
  asOf: number; // unix ms
};
