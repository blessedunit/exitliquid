// Wire types of the token analytics engine (/api/analytics/<token>).
// Shared by the server engine and the client cards: no server-only imports here.
//
// Every section is a Field: the data, or null plus a reason. Unknown is never zero.
// Signals, not verdicts: nothing here says a token is good or bad, only what the chain shows.

export type Field<T> = {
  data: T | null;
  /** why data is null (or partial): short, user-facing English */
  reason: string | null;
  /** where the numbers come from, short and user-facing ("chain", "chain + Blockscout", "vibe API") */
  source: string;
  /** the technical source (logs, eth_calls, endpoints): tooltip only */
  detail?: string;
  /** unix ms when this section was computed (cached sections keep their own time) */
  computedAt: number;
};

export type ChipLevel = "high" | "mid" | "low" | "info";
export type Chip = {
  id:
    | "BUNDLE" | "SELLWALL" | "BAGS3X" | "PROFIT" | "TOP10" | "GIFTED" | "WASH" | "BOTS" | "FRESH" | "CLONE" | "BREAKEVEN" | "CLUSTER"
    // Line Health signals, same wording and ranks as the board row (lib/healthChips)
    | "DEVSOLD" | "SNP" | "FARM" | "DEVBAG" | "DEVMOVED";
  label: string;
  level: ChipLevel;
  /** one line for the tooltip */
  hint: string;
  /** the card this chip scrolls to */
  target: "an-bundle" | "an-exit" | "an-volume" | "an-supply" | "an-clones" | "health-title";
  /** a plain-text note in the strip, not a signal (e.g. "No same-block buys") */
  quiet?: boolean;
};

/** one tag per wallet for the tape and the ticket (free): dev, Early Index sniper / farm, bag came by transfer */
export type WalletTag = "dev" | "sniper" | "farm" | "gifted";

/* ---------------- market ---------------- */

export type Market = {
  venue: "curve" | "pool";
  /** ETH per token at the current state (curve spot, or V4 pool sqrtPrice) */
  spotEth: number;
  /** constant-product virtual reserves the price model runs on (ETH, whole tokens) */
  virtualEth: number;
  virtualTokens: number;
  /** fee per side (buy fee on ETH in, sell fee on ETH out) */
  fee: number;
  /** curve only: real ETH the curve holds (a sell can't take more), and tokens left to buy */
  realEthReserve: number | null;
  tokensLeft: number | null;
  /** pool only: the V4 pool id */
  poolId: string | null;
  /** model check: the model's quote for a 0.1 ETH buy vs the contract's own quote (1 = exact) */
  modelCheck: number | null;
  /** total supply (whole tokens, minted per the Transfer log) and spot x supply in ETH; null = unknown */
  supply: number | null;
  mcapEth: number | null;
  /** pool only: the pair (ETH) side of the V4 pool's liquidity, from slot0 + liquidity. Exact for vibe's v6
   *  graduation position (full range, ticks -887220..887220, checked 17.11 on HUB / VV); another LP's narrow range
   *  would make it an over-estimate. null on the curve, on v1 pools (range not checked) and when unread. */
  poolEth?: number | null;
  /** unix seconds of the newest market trade (curve or pool), from the log's block-anchored timestamps; null = no trade / unknown */
  lastTradeAt?: number | null;
  /** market cap at the curve's start price (sold = 0) x total supply, in the same unit as mcapEth. mcapEth /
   *  launchMcapEth = how far the price already ran above launch. null = curve shape unread / supply unknown */
  launchMcapEth?: number | null;
};

/* ---------------- 1. bundle ---------------- */

export type BundleGroup = {
  kind: "tx" | "block" | "launch";
  /** block number of the group */
  block: number;
  /** the tx hash (tx kind) or every distinct tx of the group (block / launch kinds), proof links */
  txs: string[];
  wallets: string[];
  /** % of total supply bought by the group in these buys */
  boughtPct: number;
  /** % of total supply these wallets hold right now */
  heldPct: number;
  /** wallets of the group that share one ETH funder (holders.ts clusters, top holders only) */
  sameFunder: number;
};
export type Bundle = {
  /** how many buys were scanned (first 100 market buys, launch buy included) */
  scanned: number;
  /** distinct wallets among them */
  buyers: number;
  /** % of total supply bought inside groups (same tx or same block, 2+ wallets) */
  boughtPct: number;
  /** % of total supply grouped wallets still hold */
  heldPct: number;
  /** wallets in groups */
  wallets: number;
  /** wallets bought in the launch block (creator excluded) */
  launchBlockBuyers: number;
  /** distinct wallets (creator excluded) that bought within 60 s of the first buy; null = start of history unknown */
  firstMinuteBuyers: number | null;
  groups: BundleGroup[];
  /** grouped wallets that are also in a top-holder funding cluster; null = clusters unknown */
  sameFunderWallets: number | null;
  /** grouped wallets that holders.ts could check (only top holders get funding lookups) */
  funderChecked: number;
};

/* ---------------- 2. exit math ---------------- */

export type Bucket = { id: "loss" | "x1" | "x2" | "x3"; label: string; holders: number; tokens: number; supplyPct: number; linePct: number };
export type Impact = {
  eth: number;
  /** buy X ETH: tokens out, avg-price premium over spot (%), spot after (%) */
  buyTokens: number | null;
  buyImpactPct: number | null;
  buyPriceAfterPct: number | null;
  /** sell tokens worth X ETH gross: tokens needed, spot after (%) */
  sellTokens: number | null;
  sellPriceAfterPct: number | null;
  /** why a side is unknown (curve too small, quote failed) */
  note: string | null;
  /** the size was priced by the contract's own quote (curve quoteBuy / V4 quoter), not only the model */
  quoted: boolean;
};
export type ExitMath = {
  spotEth: number;
  venue: "curve" | "pool";
  inLine: number;
  /** holders whose cost basis is a curve replay (exact) vs a price estimate (pool buys after graduation) */
  exactCost: number;
  estimatedCost: number;
  buckets: Bucket[];
  /** holders whose bag came by transfer with no buy cost behind it: left out of the buckets and the dump (cost unknown) */
  noCostHolders: number;
  noCostTokens: number;
  /** holders in profit after the sell fee (multiple x (1 - fee) > 1) */
  profitHolders: number;
  profitTokens: number;
  /** tokens in profit, % of supply without the bags of unknown cost; null = no bag has a known cost */
  profitSupplyPct: number | null;
  /** if every holder in profit sold now: the spot price change (%, negative) and the ETH they'd take out */
  dumpPricePct: number | null;
  dumpEthOut: number | null;
  dumpNote: string | null;
  /** break-even for a new 0.1 ETH buy: spot must rise this much (%) and roughly this much ETH must come in */
  breakEvenPct: number | null;
  breakEvenEth: number | null;
  breakEvenSize: number;
  /** price rise needed only to pay the two fees (no impact) */
  feesOnlyPct: number;
  impact: Impact[];
  /** the biggest sell that moves spot by at most -10%: tokens in, ETH out after the fee (capped by the curve's real ETH) */
  maxSell10: { tokens: number; eth: number; capped: boolean } | null;
};

/* ---------------- 3. volume ---------------- */

export type VolWindow = {
  label: "1h" | "24h" | "all";
  trades: number;
  volumeEth: number;
  /** volume minus wash minus known-bot trades that aren't wash (each ETH counted once) */
  realEth: number;
  /** wash = dust trades (under Volume.dust) + round trips: the part of a wallet's buy undone by its own opposite
   *  sell (or the reverse) within Volume.washWindowSec, curve and pool alike (curve buy -> pool sell right after
   *  graduation counts). Matched by tokens, so a lone buy is never wash and a small sell washes only its own size. */
  washEth: number;
  microTrades: number;
  roundTrips: number;
  buys: number;
  sells: number;
  buyers: number;
  buysPerBuyer: number | null;
  /** volume by Early Index sniper / farm wallets, wash trades excluded (no double count) */
  botEth: number | null;
  /** ETH of trades whose size is unknown (pool trades without a swap log): left out, never zero */
  unknownTrades: number;
  /** who makes this window's volume; null = fewer than 5 sized trades, no volume, or >10% of trades unsized */
  concentration?: VolConcentration | null;
};
export type VolConcentration = {
  /** % of the window's sized volume (buys + sells, each ETH once) made by the top wallet / the top 3 wallets */
  top1Pct: number;
  top3Pct: number;
  topWallet: string;
  /** the top wallet is the creator; null = creator unknown */
  topIsDev: boolean | null;
  /** distinct wallets with a sized trade in the window */
  wallets: number;
};
export type TopTrader = { wallet: string; eth: number; sharePct: number; trades: number; tag: "sniper" | "farm" | null };
export type Volume = {
  venue: "curve" | "pool" | "both";
  windows: VolWindow[];
  /** whether the history covers the window (a window older than the log is unknown) */
  topTraders: TopTrader[];
  /** the window topTraders covers: the last 24 h, or the whole history when the day had no sized trades */
  topTradersWindow: "24h" | "all";
  labelsAsOf: number | null;
  /** the dust threshold used, in the pair's unit (0.0001 on an ETH pair); null = the pair's scale was unknown,
   *  so dust was NOT taken out of the volume (wash is a lower bound) */
  dust: number | null;
  /** the round-trip (wash) window in seconds */
  washWindowSec?: number;
  /** the same window in blocks at the measured block time, used for legs without a timestamp; null = every leg had one */
  washWindowBlocks?: number | null;
  /** some buy/sell pairs could not be timed (no timestamps, block time unmeasured): wash is a lower bound */
  washWindowUnknown?: boolean;
};

/* ---------------- 4. supply ---------------- */

export type HolderFlag = "creator" | "gifted" | "fresh" | "cluster" | "lownonce" | "sniper" | "farm";
export type SupplyRow = {
  wallet: string;
  pct: number;
  /** % of its bag that came by transfer, not a buy */
  giftedPct: number;
  /** outgoing tx count; null = unknown */
  nonce: number | null;
  /** funded within 24 h before its first buy; null = unknown */
  fresh: boolean | null;
  cluster: number | null;
  flags: HolderFlag[];
};
export type Supply = {
  /** % of total supply held by people (curve, pool, protocol and burn excluded) */
  circulatingPct: number;
  /** % held by the curve / pool (not people) */
  marketPct: number;
  holders: number;
  top10Pct: number;
  /** top 10 as a share of what people hold */
  top10OfCirculatingPct: number;
  top10: SupplyRow[];
  /** holders whose whole bag came by transfer (never bought) */
  giftedHolders: number;
  giftedPct: number;
  /** wallets that handed tokens to 3+ others (airdrop / split pattern) */
  gifters: { wallet: string; to: number; pct: number; isCreator: boolean }[];
  /** among the top 10: funded within 24 h before their first buy; null = unknown */
  freshTop10: number | null;
  freshChecked: number;
  lowNonceTop10: number | null;
  /** top-10 wallets whose nonce was read */
  lowNonceChecked: number;
  creatorPct: number | null;
  /** the creator's sells (market legs) and wallets it handed tokens to, whole history; null = creator / start unknown */
  devSells: number | null;
  devMovedTo: number | null;
  /** % of the dev's own bag sold into the curve / pool: sold / (sold + still held + moved out); v6 gift reserve
   *  excluded. null = creator or start of history unknown, or the dev never held the token */
  devSoldPct?: number | null;
  /** holders that bought on the market (curve or pool; not gift-list / transfer-only bags) AND hold at least
   *  realHolderMinPct of total supply. `holders` stays the raw count of every non-zero people balance. */
  realHolders?: number;
  /** the dust floor of realHolders, % of total supply (0.01 = 100k of 1B tokens) */
  realHolderMinPct?: number;
  /** the dev's sells (curve + pool) as % of TOTAL supply, whole history; null = creator / start of history unknown */
  devSoldSupplyPct?: number | null;
  /** ETH (pair units) the dev put in with its buys (fee included) / took out with its sells (after the fee), whole
   *  history; null = creator unknown or a dev trade's size unknown */
  devEthIn?: number | null;
  devEthOut?: number | null;
  /** the wallet that bought the most supply and sold it back (see Pusher); null = no buys, or start of history unknown */
  pusher?: Pusher | null;
};

/** "one wallet bought a big share of supply and sold most of it": the worst wallet by pushedPct (peak share of supply
 *  bought x share of its buys sold), whole history, curve and pool legs (v6 zap hops collapsed). When no wallet pushed
 *  out 0.01%+ of supply that way: the biggest buyer, so soldPctOfBought shows it held. */
export type Pusher = {
  wallet: string;
  /** null = creator unknown */
  isDev: boolean | null;
  /** the biggest share of total supply it held from buys at once (net position: buys minus sells, transfers ignored), % */
  boughtPct: number;
  /** every buy added up, % of total supply (a wallet that round-trips the same bag counts it each time; can pass 100) */
  totalBoughtPct: number;
  /** tokens sold / tokens bought (all buys), % capped at 100 */
  soldPctOfBought: number;
  /** boughtPct x soldPctOfBought / 100: the share of supply it pushed in and dumped, the ranking key */
  pushedPct: number;
  /** ETH (pair units) in with its buys / out with its sells; null = a trade size unknown. ethOut 0 = never sold */
  ethIn: number | null;
  ethOut: number | null;
  /** unix seconds of its first buy / last sell; null = unknown / never sold */
  firstBuyAt: number | null;
  lastSellAt: number | null;
};

/* ---------------- 5. clones ---------------- */

export type CloneItem = { token: string; symbol: string; name: string; createdAt: number; holders: number | null; graduated: boolean; self: boolean };
export type Clones = {
  symbol: string;
  /** same ticker (case-insensitive) or the same name */
  matches: number;
  /** this token is the earliest launch with this ticker */
  isEarliest: boolean;
  earliest: CloneItem | null;
  items: CloneItem[];
  /** the search had more pages than were read: an older one may exist */
  partial: boolean;
};

/* ---------------- response ---------------- */

export type Analytics = {
  token: string;
  symbol: string;
  block: number;
  computedAt: number;
  graduated: boolean;
  /** seconds since the launch block (block distance x measured block time); null / absent = unknown */
  ageSec?: number | null;
  /** the wallet index's window in days when its labels are usable; null = index too old or missing */
  indexWindowDays?: number | null;
  health: {
    grade: "A" | "B" | "C" | "D" | "F";
    score: number;
    partial: boolean;
    high: number;
    /** known snipers / farm wallets among the first buyers; null = wallet index too old or front not formed */
    snipers: number | null;
    farm: number | null;
    firstBuyers: number;
    /** of the first buyers, how many still hold (the rest walked out); absent on old cached answers */
    stillHolding?: number;
  } | null;
  market: Field<Market>;
  bundle: Field<Bundle>;
  exitMath: Field<ExitMath>;
  volume: Field<Volume>;
  supply: Field<Supply>;
  clones: Field<Clones>;
  chips: Chip[];
  /** wallet -> tag for the wallets of the latest trades and the creator */
  tags: Record<string, WalletTag>;
  /**
   * The unit of every "Eth"-named amount in this answer (spotEth, volumeEth, cost, impact sizes...).
   * Absent on v1 lines = ETH. A v6 line paired with a token (VIBEVIBE, a stock token) is priced in that
   * token's units, never converted to a fake ETH number: native=false means "label it with `symbol`".
   */
  unit?: { symbol: string; native: boolean };
  /** taxed v6 launches only: the facts a v1 line doesn't have */
  v6?: V6Facts;
};

/* ---------------- v6 (taxed launches) ---------------- */

export type V6Facts = {
  /** the pair the curve / pool trades against */
  pair: { symbol: string; native: boolean; address: string | null; decimals: number | null };
  /** tax per trade side, bps (the curve's current rate); null = unread */
  taxBps: number | null;
  /** where the tax goes, bps of the tax (vibe API); null = unknown */
  taxSplit: { cashBps: number; holdersBps: number; burnBps: number } | null;
  /** the launch's gift list (airdrop to a list of wallets, delivered from the creator's bag); null = unknown */
  gifts: {
    count: number;
    delivered: number;
    /** still reserved for gifts, % of total supply (sits in the creator's wallet until delivered) */
    reservedPct: number;
    deliveredPct: number;
    /** wallets holding only gift tokens (never bought, nothing else came in) */
    onlyGiftHolders: number;
  } | null;
  /** tax flows read from the Transfer log, % of total supply */
  burnedPct: number;
  /** tokens the token contract holds for holder rewards right now / paid out to holders so far */
  rewardsHeldPct: number;
  rewardsPaidPct: number;
  /** wallets that received holder rewards */
  rewardWallets: number;
  /** creator's own part of the launch buy, % of supply (the launch buy minus the gift reserve; vibe API); null = unknown */
  devPersonalPct: number | null;
  /** fee paid in the pair currency on the curve so far (pair units); null = curve log unread */
  curveFeesPair: number | null;
  /** curve state (pair units); null = unread */
  door: { reservePair: number; targetPair: number | null; bps: number | null } | null;
  /** block of graduation (first pool transfer); null = still on the curve */
  graduatedBlock: number | null;
};
