// Quote tokens vibe/vibe lists with pairSymbol: null (the tokenized stocks and USDG). Without this map the site
// called them "token" ("Vol 24h 4 token" on an NVDA pair, audit 15.10). Symbols read from symbol() on chain 15.10.
const KNOWN: Record<string, string> = {
  "0x3ab049897b0697bda766d8730fe1f955c9c103f0": "NVDA",
  "0xba163e9887d54a854323b41fca9cf64a1c275ac9": "SPCX",
  "0x438820dcfe62a21e306614a4b54383cd8a36acf2": "AAPL",
  "0x92dce70b18df47ac643af6377621d74abe3c868c": "ANTHROPIC",
  "0x1b14321750b38f7ed66a363d07a921a668521a5f": "OPENAI",
  "0x102154e70d8485ff466bab229be90a763bf33264": "USDG",
};

/** vibe's pairSymbol, else a known quote token, else null (the caller decides the wording for unknown). */
export function pairSymbol(apiSymbol: unknown, pairAddress: unknown): string | null {
  const s = typeof apiSymbol === "string" ? apiSymbol.trim() : "";
  if (s) return s.slice(0, 12);
  const a = typeof pairAddress === "string" ? pairAddress.toLowerCase() : "";
  return KNOWN[a] ?? null;
}
