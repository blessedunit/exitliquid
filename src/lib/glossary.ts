// One glossary for the whole site (spec §6). <Term id> tooltips, the /faq Glossary section and every
// "More →" link read from here, so a word means the same thing on every page.
export type GlossaryId =
  | "vibe" | "line" | "place" | "walked-out" | "graduation" | "to-grad" | "eta" | "stalled"
  | "health" | "partial" | "snipers" | "farm" | "early-index" | "bundle" | "one-funder"
  | "fresh-wallet" | "dev-bag" | "dev-sold" | "sell-wall" | "exit-math" | "real-volume"
  | "wash" | "ticker-clone" | "unknown" | "b-s";

export type GlossaryEntry = { id: GlossaryId; term: string; short: string; more?: string /* href */ };

const E = (id: GlossaryId, term: string, short: string, more?: string): GlossaryEntry => ({ id, term, short, more });

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = {
  vibe: E("vibe", "vibe/vibe", "A meme-token launchpad on Robinhood Chain testnet. Each token trades on a bonding curve until it holds 5 ETH, then graduates to a Uniswap V4 pool."),
  line: E("line", "Line", "Every holder of a token, queued by their first real buy.", "/methodology#line"),
  place: E("place", "Place", "Your spot in the line: #1 bought first. Needs 0.0003 ETH+ still held.", "/methodology#line"),
  "walked-out": E("walked-out", "Walked out", "A holder whose bag fell to 5% of its peak or under 5,000 tokens.", "/methodology#line"),
  graduation: E("graduation", "Graduation", "The curve reaches 5 ETH and trading moves to a Uniswap V4 pool. The corridor calls it the door.", "/methodology#eta"),
  "to-grad": E("to-grad", "To grad", "How far the curve is toward the 5 ETH graduation target.", "/methodology#eta"),
  eta: E("eta", "ETA", "Time to graduation at the current pace. — when stalled or under 1 h old.", "/methodology#eta"),
  stalled: E("stalled", "Stalled", "No real pace: no buys in the last hour, a flat or draining day, or a very slow last hour.", "/methodology#eta"),
  health: E("health", "Grade (Line Health)", "A–F check of the first 20 buyers and the dev, from 100 points. A signal, not a verdict.", "/methodology#health"),
  partial: E("partial", "Partial", "Some inputs couldn't be read, so the grade is a weaker read.", "/methodology#health"),
  snipers: E("snipers", "Snipers", "Known sniper bots among the first 20 buyers. 6+ is a warning, 12+ is high.", "/methodology#index"),
  farm: E("farm", "Farm wallets", "Wallets that keep entering the first minutes of the same launches together.", "/methodology#index"),
  "early-index": E("early-index", "Early Index", "Our wallet labels (snipers, farms, verified early) built from the last 7 days of launches.", "/methodology#index"),
  bundle: E("bundle", "Bundle", "3+ top holders whose first buy landed in the same second.", "/methodology#clusters"),
  "one-funder": E("one-funder", "One funder", "Top holders whose first ETH came from the same wallet. Faucets and hubs don't count.", "/methodology#clusters"),
  "fresh-wallet": E("fresh-wallet", "Fresh wallet", "A holder funded less than 24 h before its first buy.", "/methodology#clusters"),
  "dev-bag": E("dev-bag", "Dev bag", "The share of supply the token's creator still holds.", "/faq#dev-bag"),
  "dev-sold": E("dev-sold", "Dev sold", "The creator sold this token at least once.", "/faq#dev-sold"),
  "sell-wall": E("sell-wall", "Sell wall", "How far the price would drop if every holder in profit sold now.", "/methodology#exit"),
  "exit-math": E("exit-math", "Exit math", "What selling a bag would return right now, after the 1.25% fee and your own price impact. A quote, not a promise.", "/methodology#exit"),
  "real-volume": E("real-volume", "Real volume", "Volume without round trips, the dev's own trades, or one funding group trading with itself.", "/methodology#volume"),
  wash: E("wash", "Wash", "Trades that move volume but bring no new money. A lower bound: it can't be proven on-chain.", "/methodology#volume"),
  "ticker-clone": E("ticker-clone", "Ticker clones", "Other vibe/vibe launches that use the same ticker. Only the first one is the original.", "/faq#ticker-clone"),
  "b-s": E("b-s", "B / S", "Buys and sells in the last hour.", "/faq#b-s"),
  unknown: E("unknown", "— (unknown)", "A source didn't answer or it's too early. Unknown is never counted as 0 or as clean.", "/status"),
};

export const gloss = (id: GlossaryId): GlossaryEntry => GLOSSARY[id];

/** display order for the /faq Glossary: reading order of a token page, not alphabetical */
export const GLOSSARY_ORDER: GlossaryId[] = [
  "vibe", "line", "place", "walked-out", "graduation", "to-grad", "eta", "stalled",
  "health", "partial", "snipers", "farm", "early-index", "bundle", "one-funder", "fresh-wallet",
  "dev-bag", "dev-sold", "sell-wall", "exit-math", "real-volume", "wash", "ticker-clone", "b-s", "unknown",
];
