// One glossary for the whole site (spec §6). <Term id> tooltips, the Glossary on /methodology and every
// "More →" link read from here, so a word means the same thing on every page.
export type GlossaryId =
  | "vibe" | "line" | "place" | "walked-out" | "graduation" | "to-grad" | "eta" | "stalled"
  | "health" | "partial" | "snipers" | "farm" | "early-index" | "bundle" | "one-funder"
  | "fresh-wallet" | "dev-bag" | "dev-sold" | "sell-wall" | "exit-math" | "real-volume"
  | "wash" | "ticker-clone" | "unknown" | "b-s" | "real-holders" | "pump" | "late-entry" | "coverage";

export type GlossaryEntry = { id: GlossaryId; term: string; short: string; more?: string /* href */ };

const E = (id: GlossaryId, term: string, short: string, more?: string): GlossaryEntry => ({ id, term, short, more });

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = {
  vibe: E("vibe", "vibe/vibe", "A meme-token launchpad on Robinhood Chain testnet. Each token trades on a bonding curve until it holds 5 ETH, then graduates to a Uniswap V4 pool."),
  line: E("line", "Line", "Every holder of a token, queued by their first real buy.", "/methodology#line"),
  place: E("place", "Place", "Your spot in the line: #1 bought first. Needs 0.0003 ETH+ still held.", "/methodology#place"),
  "walked-out": E("walked-out", "Walked out", "A holder whose bag fell to 5% of its peak or under 5,000 tokens.", "/methodology#walked-out"),
  graduation: E("graduation", "Graduation", "The curve reaches 5 ETH and trading moves to a Uniswap V4 pool. The corridor calls it the door.", "/methodology#graduation"),
  "to-grad": E("to-grad", "To grad", "How far the curve is toward the 5 ETH graduation target.", "/methodology#to-grad"),
  eta: E("eta", "ETA", "Time to graduation at the current pace. — when stalled or under 1 h old.", "/methodology#eta"),
  stalled: E("stalled", "Stalled", "No real pace: no buys in the last hour, a flat or draining day, or a very slow last hour.", "/methodology#stalled"),
  health: E("health", "Grade", "A–F: the risk of becoming someone's exit liquidity. A: no red flags found. F: likely exit liquidity. No letter while a token is too new or too thin to judge.", "/methodology#grade"),
  partial: E("partial", "Partial", "Some inputs couldn't be read. The grade says what wasn't checked, and only a full check can be A.", "/methodology#grade"),
  coverage: E("coverage", "Full check", "Every input of the grade was read: holders, trades, volume split, big sellers, the dev wallet and history, snipers and the pool.", "/methodology#grade"),
  snipers: E("snipers", "Snipers", "Known sniper bots among the first 20 buyers. Shown as information: they count against the grade only while snipers and farms still hold 15%+ of supply.", "/methodology#snipers"),
  "real-holders": E("real-holders", "Real holders", "Wallets that bought on the market and hold more than dust. Airdrop-only and dust wallets don't count.", "/methodology#real-holders"),
  pump: E("pump", "Pump", "One wallet bought 20%+ of supply and sold 80%+ of it back, often within seconds of graduation. By a third party: high risk. By the dev: likely exit liquidity.", "/methodology#pump"),
  "late-entry": E("late-entry", "Late entry", "The price already runs 1.3× or more above launch while holders sit in profit: whoever buys now is what they can sell into.", "/methodology#late-entry"),
  farm: E("farm", "Farm wallets", "Wallets that keep entering the first minutes of the same launches together.", "/methodology#farm"),
  "early-index": E("early-index", "Early Index", "Our wallet labels (snipers, farms, verified early) built from the last 7 days of launches.", "/methodology#early-index"),
  bundle: E("bundle", "Bundle", "Wallets that bought in the same transaction or the same block, among the first 100 buys.", "/methodology#bundle"),
  "one-funder": E("one-funder", "One funder", "Top holders whose first ETH came from the same wallet. Faucets and hubs don't count.", "/methodology#one-funder"),
  "fresh-wallet": E("fresh-wallet", "Fresh wallet", "A holder funded less than 24 h before its first buy.", "/methodology#fresh-wallet"),
  "dev-bag": E("dev-bag", "Dev bag", "The share of supply the token's creator still holds.", "/methodology#dev-bag"),
  "dev-sold": E("dev-sold", "Dev sold", "The creator's sells as a share of total supply. A warning from 10%; red only with a pump, or with 1+ ETH more out than in.", "/methodology#dev-sold"),
  "sell-wall": E("sell-wall", "Sell wall", "How far the price would drop if every holder in profit sold now.", "/methodology#sell-wall"),
  "exit-math": E("exit-math", "Exit math", "What selling a bag would return right now, after the 1.25% fee and your own price impact. A quote, not a promise.", "/methodology#exit-math"),
  "real-volume": E("real-volume", "Real volume", "Volume without wash trades and without trades by known sniper or farm wallets.", "/methodology#real-volume"),
  wash: E("wash", "Wash", "Tiny trades, and one wallet buying and selling the same tokens within 5 minutes. They move volume but bring no new money.", "/methodology#wash"),
  "ticker-clone": E("ticker-clone", "Ticker clones", "Other vibe/vibe launches that use the same ticker. Only the first one is the original.", "/methodology#ticker-clone"),
  "b-s": E("b-s", "B / S", "Buys and sells in the last hour.", "/methodology#b-s"),
  unknown: E("unknown", "— (unknown)", "A source didn't answer or it's too early. Unknown is never counted as 0 or as clean.", "/status"),
};

export const gloss = (id: GlossaryId): GlossaryEntry => GLOSSARY[id];

/** the Glossary on /methodology (each row carries its id as the anchor): reading order of a token page */
export const GLOSSARY_ORDER: GlossaryId[] = [
  "vibe", "line", "graduation", "to-grad", "eta", "stalled", "snipers", "farm", "early-index", "bundle", "one-funder",
  "real-holders", "pump", "late-entry", "coverage", "dev-bag", "dev-sold", "real-volume", "wash", "exit-math", "ticker-clone", "b-s", "unknown",
];
