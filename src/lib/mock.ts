// Deterministic fake chain history, used only when the real chain can't be read.
// Always labelled "mock" in the UI so nobody mistakes it for real data.
import type { BalanceEvent } from "./queue";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function addr(r: () => number) {
  let h = "0x";
  for (let i = 0; i < 40; i++) h += "0123456789abcdef"[Math.floor(r() * 16)];
  return h;
}

export function mockEvents(n = 140, seed = 7): { events: BalanceEvent[]; creator: string } {
  const r = rng(seed);
  const events: BalanceEvent[] = [];
  const wallets: string[] = [];
  const creator = addr(r);
  const now = Math.floor(Date.now() / 1000);
  let block = 1_000_000;
  let ts = now - n * 600;
  const unit = 10n ** 18n;
  events.push({ wallet: creator, delta: 25_000_000n * unit, block, logIndex: 0, ts });
  wallets.push(creator);
  for (let i = 0; i < n; i++) {
    block += 1 + Math.floor(r() * 40);
    ts += Math.floor(r() * 900);
    const roll = r();
    if (roll < 0.62 || wallets.length < 5) {
      const w = addr(r);
      wallets.push(w);
      const size = r();
      const amt = size > 0.97 ? 12_000_000 : size > 0.85 ? 5_000_000 : size > 0.6 ? 1_800_000 : size > 0.3 ? 400_000 : 90_000;
      events.push({ wallet: w, delta: BigInt(Math.floor(amt * (0.6 + r()))) * unit, block, logIndex: 0, ts });
    } else if (roll < 0.8) {
      const w = wallets[1 + Math.floor(r() * (wallets.length - 1))];
      events.push({ wallet: w, delta: BigInt(Math.floor(300_000 + r() * 2_000_000)) * unit, block, logIndex: 0, ts });
    } else {
      const w = wallets[1 + Math.floor(r() * (wallets.length - 1))];
      // sell everything (a big negative delta; queue clamps at dust)
      events.push({ wallet: w, delta: -(10n ** 40n), block, logIndex: 0, ts });
    }
  }
  return { events, creator };
}
