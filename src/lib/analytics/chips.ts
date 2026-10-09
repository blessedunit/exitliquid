// Short signal chips for the token header. Pure: derived from an Analytics answer.
// A chip is a reason to look closer, never a verdict. Unknown sections make no chip (never a "0%" chip).
//
// Order: the Line Health chips first (DEV SOLD, SNP, FARM, DEV n%, DEV MOVED: the same rules as the board row,
// lib/healthChips), then the analytics chips worst first. A chip that fires on nearly every token is not a
// signal: thresholds below were set on a board sample (01.10, "threshold -> share of tokens flagged"), and
// the always-on ones (break-even, SELL WALL on a curve, top 10 of total supply) were dropped from the strip.
import { healthChips } from "@/lib/healthChips";
import type { Analytics, Chip, ChipLevel } from "./types";

const pctText = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "");
const lvl = (v: number, high: number, mid: number, low: number): ChipLevel => (v >= high ? "high" : v >= mid ? "mid" : v >= low ? "low" : "info");
const ORDER: Record<ChipLevel, number> = { high: 0, mid: 1, low: 2, info: 3 };
const TONE: Record<"bad" | "warn" | "plain", ChipLevel> = { bad: "high", warn: "mid", plain: "info" };

// Tuned 01.10 on 64 board tokens (Hot / New / Door / Graduated, v1): "threshold -> share of tokens flagged".
// - 3x+ bags (53 curve tokens): bimodal, 0% on young curves and 45-70% on curves past ~3x their start price.
//   >=40 flags 47% (at "low"), >=60 flags 8% ("mid"), >=75 none yet ("high"). It tracks how far up the curve
//   the line is, so it is yellow at most unless the overhang is extreme.
// - top 10 of holders (64): median 27%; >=35 flags 15%, >=45 7%, >=60 6%.
// - pool sell wall (11 graduated): 0-1% on dead pools, 49%, then 81-99.8%; >=50 flags 72%, >=80 64%, >=95 27%.
//   Most pools look like this, so only an extreme wall is red.
export const BAGS3X = { high: 75, mid: 60, low: 40 }; // % of the line's tokens held at 3x+ their cost
export const TOP10_HOLDERS = { high: 60, mid: 45, low: 35 }; // top 10 as % of what holders hold (curve / pool out)
export const SELLWALL_POOL = { high: 95, mid: 80, low: 50 }; // graduated pool only: % spot drop if all in profit sold

export function chipsFor(a: Analytics): Chip[] {
  // ---- Line Health first: the board's red flags, same wording ----
  const h = a.health;
  const s = a.supply.data;
  const health: Chip[] = healthChips({
    devSells: s?.devSells ?? null,
    devMovedTo: s?.devMovedTo ?? null,
    devHoldsBps: s?.creatorPct === null || s?.creatorPct === undefined ? null : Math.round(s.creatorPct * 100),
    snipers: h?.snipers ?? null,
    farm: h?.farm ?? null,
    firstBuyers: h?.firstBuyers ?? null,
  }).map((c) => ({
    id: c.id,
    label: c.text,
    level: TONE[c.tone],
    hint: c.title,
    // the dev bag is read in Supply; the rest is explained in Line Health
    target: c.id === "DEVBAG" ? "an-supply" : "health-title",
  }));

  const out: Chip[] = [];
  const b = a.bundle.data;
  if (b && b.scanned >= 5) {
    // under 0.1% bought in groups is noise (dust wallets sharing a block): no chip at all
    if (b.wallets > 0 && b.boughtPct >= 0.1) {
      const sold = b.heldPct < 1 && b.boughtPct >= 1;
      out.push({
        id: "BUNDLE",
        label: sold ? `Bundle ${pctText(b.boughtPct)}%, sold` : `Bundle holds ${pctText(b.heldPct)}%`,
        level: sold ? "low" : lvl(b.heldPct, 15, 5, 1),
        hint: `${b.wallets} first buyers shared a tx or a block: bought ${pctText(b.boughtPct)}% of supply, hold ${pctText(b.heldPct)}% now.`,
        target: "an-bundle",
      });
    }
    // no bundled buys makes no chip: "none found" is not a clean bill, and the Bundle card says it in words
  }
  const e = a.exitMath.data;
  if (e && e.venue === "pool" && e.dumpPricePct !== null && e.profitHolders > 0) {
    // a graduated pool has no curve to retrace: "everyone in profit sells" is a real overhang there
    const drop = -e.dumpPricePct;
    if (drop >= SELLWALL_POOL.low) {
      out.push({
        id: "SELLWALL",
        label: `Sell wall −${pctText(drop)}%`,
        level: lvl(drop, SELLWALL_POOL.high, SELLWALL_POOL.mid, SELLWALL_POOL.low),
        hint: `If all ${e.profitHolders} holders in profit sold now, the pool price would fall ${pctText(drop)}%.`,
        target: "an-exit",
      });
    }
  } else if (e && e.venue === "curve") {
    // on a rising curve nearly everyone is at 1-2x (selling only walks the curve back); the bags at 3x+ are the ones that can dump
    const x3 = e.buckets.find((k) => k.id === "x3");
    if (x3 && x3.linePct >= BAGS3X.low) {
      out.push({
        id: "BAGS3X",
        label: `3x+ bags ${pctText(x3.linePct)}%`,
        level: lvl(x3.linePct, BAGS3X.high, BAGS3X.mid, BAGS3X.low),
        hint: `${x3.holders} wallets hold ${pctText(x3.linePct)}% of the line's tokens at 3x or more their cost.`,
        target: "an-exit",
      });
    }
  }
  if (s && s.holders >= 10 && s.top10OfCirculatingPct >= TOP10_HOLDERS.low) {
    out.push({
      id: "TOP10",
      label: `Top 10 hold ${pctText(s.top10OfCirculatingPct)}%`,
      level: lvl(s.top10OfCirculatingPct, TOP10_HOLDERS.high, TOP10_HOLDERS.mid, TOP10_HOLDERS.low),
      hint: `The 10 biggest wallets hold ${pctText(s.top10OfCirculatingPct)}% of what holders hold (${pctText(s.top10Pct)}% of total supply; curve and pool left out).`,
      target: "an-supply",
    });
  }
  if (s && s.holders > 0) {
    if (s.giftedPct >= 1) {
      out.push({ id: "GIFTED", label: `Gifted ${pctText(s.giftedPct)}%`, level: lvl(s.giftedPct, 20, 10, 3), hint: `${pctText(s.giftedPct)}% of supply sits in bags that came by transfer, not a buy.`, target: "an-supply" });
    }
    if (s.freshTop10 !== null && s.freshTop10 > 0) {
      // a count, not a ratio: only wallet-funded holders can be checked (faucet / bridge funding has no block), so
      // "4/4" read as "all fresh" while most of the top 10 were simply unknown
      const unknown = Math.max(0, s.top10.length - s.freshChecked);
      out.push({ id: "FRESH", label: `${s.freshTop10} fresh in top 10`, level: s.freshTop10 >= 3 ? "mid" : "low", hint: `${s.freshTop10} of the top 10 got their first ETH less than 24 h before buying.${unknown ? ` ${unknown} unknown (faucet / bridge funded, gifted or not read yet).` : ""}`, target: "an-supply" });
    }
    const clustered = s.top10.filter((r) => r.cluster !== null).length;
    if (clustered >= 2) {
      out.push({ id: "CLUSTER", label: `${clustered}/10 one funder`, level: clustered >= 4 ? "high" : "mid", hint: `${clustered} of the top 10 were first funded from a shared source.`, target: "an-supply" });
    }
  }
  const v = a.volume.data;
  const day = v?.windows.find((w) => w.label === "24h") ?? v?.windows.find((w) => w.label === "all");
  if (day && day.volumeEth >= 0.01) {
    const wash = (day.washEth / day.volumeEth) * 100;
    if (wash >= 10) out.push({ id: "WASH", label: `Wash ${pctText(wash)}%`, level: lvl(wash, 40, 20, 10), hint: `${pctText(wash)}% of ${day.label} volume is dust trades or in-and-out within 2 blocks.`, target: "an-volume" });
    if (day.botEth !== null) {
      const bots = (day.botEth / day.volumeEth) * 100;
      if (bots >= 5) out.push({ id: "BOTS", label: `Bots ${pctText(bots)}% of vol`, level: lvl(bots, 30, 15, 5), hint: `${pctText(bots)}% of ${day.label} volume came from known sniper / farm wallets (wash left out).`, target: "an-volume" });
    }
  }
  const c = a.clones.data;
  if (c && c.earliest && c.matches > 0) {
    out.push(c.isEarliest
      ? { id: "CLONE", label: `Ticker used ${c.matches + 1}×, first`, level: "info", hint: c.partial ? `The earliest among the ${c.matches + 1} launches with this ticker that were read (an older one may exist).` : `The earliest of ${c.matches + 1} launches with this ticker.`, target: "an-clones" }
      : { id: "CLONE", label: `Ticker used ${c.matches + 1}×, not first`, level: "low", hint: `${c.matches + 1} launches use $${c.symbol}. An older one used it first.`, target: "an-clones" });
  }
  out.sort((x, y) => ORDER[x.level] - ORDER[y.level]);
  return [...health, ...out];
}
