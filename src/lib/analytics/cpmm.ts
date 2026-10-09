// Constant-product price model shared by the vibe/vibe bonding curve and its graduated V4 pool.
// Pure math, no network: the engine feeds it live virtual reserves and checks it against the
// contract's own quote (curve quoteBuy / V4 quoter) before trusting it.
//
// Measured 01.10 on FLOKI (curve), TREE and ChillCat (V4 pools):
// - curve: virtualEthReserve() * virtualTokenReserve() = k, quoteSell(t) = (net, gross, fee), fee = 1.25% of gross
// - curve: quoteBuy(eth) = (tokensOut, ethIn, ethNet) with ethNet = ethIn * (1 - 1.25%)
// - pool: fee=0 in the PoolKey, the hook takes 1.25% of the ETH side; the V4 quoter matched
//   x*y=k on virtual reserves (L / sqrtP, L * sqrtP) to 4 decimals (sell ratio 0.98750 exactly).

export const FEE = 0.0125;

export type Reserves = { e: number; t: number }; // virtual ETH, virtual tokens (whole units)

export const spot = (r: Reserves) => r.e / r.t;

/** Tokens out for `ethIn` ETH (fee taken from the input first). */
export function buyOut(r: Reserves, ethIn: number, fee = FEE): { tokens: number; after: Reserves } {
  const net = ethIn * (1 - fee);
  const e = r.e + net;
  const t = (r.e * r.t) / e;
  return { tokens: r.t - t, after: { e, t } };
}

/** ETH out (after the fee) for selling `tokens`. */
export function sellOut(r: Reserves, tokens: number, fee = FEE): { gross: number; net: number; after: Reserves } {
  const t = r.t + tokens;
  const e = (r.e * r.t) / t;
  const gross = r.e - e;
  return { gross, net: gross * (1 - fee), after: { e, t } };
}

/** Tokens to sell for `grossEth` ETH out before the fee; null when the reserve can't pay it. */
export function tokensForGross(r: Reserves, grossEth: number): number | null {
  if (!(grossEth > 0) || grossEth >= r.e) return null;
  return (r.t * grossEth) / (r.e - grossEth);
}

/** Spot change in % between two states (negative = price fell). */
export const pctMove = (a: Reserves, b: Reserves) => (spot(b) / spot(a) - 1) * 100;

/**
 * Break-even of a fresh buy of `ethIn`: after it, how far must OTHER people's buys push the spot
 * before selling the same tokens returns `ethIn` (after the sell fee).
 * Returns the spot rise vs. the price before the buy (%) and the ETH others must put in (incl. their fee).
 */
export function breakEven(r: Reserves, ethIn: number, fee = FEE): { risePct: number; othersEth: number } {
  const { tokens, after } = buyOut(r, ethIn, fee);
  const k = after.e * after.t;
  const g = ethIn / (1 - fee); // gross ETH the sell must return
  // selling `tokens` at state (E, k/E) returns E*tokens / (k/E + tokens) = g  ->  tokens*E^2 - g*tokens*E - g*k = 0
  const a = tokens;
  const b = -g * tokens;
  const c = -g * k;
  const E = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  const othersNet = Math.max(0, E - after.e);
  const risePct = ((E * E) / k / spot(r) - 1) * 100;
  return { risePct, othersEth: othersNet / (1 - fee) };
}

/** Price rise needed just to pay a buy fee and a sell fee, with no price impact. */
export const feesOnlyPct = (fee = FEE) => (1 / ((1 - fee) * (1 - fee)) - 1) * 100;
