// One Line Health replay per token per 20 s, shared by /api/health and the analytics engine
// (before, a token page replayed the whole log twice a minute: once per route).
import "server-only";
import { computeHealth, type HealthInput, type HealthResult } from "@/lib/health";
import { BoundedTtlMap } from "@/lib/bounded";
import { earlyIndex } from "@/lib/earlyIndex";

const MEMO_MS = 20_000;
const memo = new BoundedTtlMap<HealthResult & { block: number }>(2_000);

/** computeHealth over `input`, or the replay of the last 20 s when it covered this head block or a newer one */
export function healthOf(input: HealthInput): HealthResult & { block: number } {
  const t = input.token.toLowerCase();
  const hit = memo.get(t);
  if (hit && hit.block >= input.headBlock) return hit;
  const h = { ...computeHealth(input, earlyIndex()), block: input.headBlock };
  memo.set(t, h, MEMO_MS);
  return h;
}

/** the last replay for this token if it is still fresh (no input needed): lets a route skip the line build */
export function healthCached(token: string): (HealthResult & { block: number }) | null {
  return memo.get(token.toLowerCase()) ?? null;
}
