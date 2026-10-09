import "server-only";

let memo: { at: number; value: number | null } | null = null;
let running: Promise<number | null> | null = null;

/** A display-only ETH/USD spot price. Queue correctness never depends on it. */
export async function ethUsdPrice(): Promise<number | null> {
  if (memo && Date.now() - memo.at < 60_000) return memo.value;
  if (running) return running;
  running = (async () => {
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
    } finally {
      running = null;
    }
  })();
  return running;
}
