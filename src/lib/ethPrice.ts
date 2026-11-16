import "server-only";

let memo: { at: number; value: number | null } | null = null;
let running: Promise<number | null> | null = null;

/** A display-only ETH/USD spot price. Queue correctness never depends on it. */
export async function ethUsdPrice(): Promise<number | null> {
  if (memo && Date.now() - memo.at < 60_000) return memo.value;
  if (running) return running;
  // hard cap on top of the fetch abort: on 17.10 one fetch never settled (abort didn't fire) and every caller
  // awaiting it (the $EXIT line, the screener) hung for 9 hours. Never wait more than 3 s for a display-only price.
  const fallback = new Promise<number | null>((res) => setTimeout(() => res(memo?.value ?? null), 3_000));
  const job = (async () => {
    try {
      const signal = AbortSignal.timeout(2_500);
      const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { cache: "no-store", signal });
      if (!response.ok) throw new Error(String(response.status));
      const json = (await response.json()) as { data?: { amount?: string } };
      const value = Number(json.data?.amount);
      if (!Number.isFinite(value) || value <= 0) throw new Error("bad ETH price");
      memo = { at: Date.now(), value };
      return value;
    } catch {
      return memo?.value ?? null;
    }
  })();
  running = Promise.race([job, fallback]).finally(() => {
    running = null;
  });
  return running;
}
