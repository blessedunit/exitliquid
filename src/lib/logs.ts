// eth_getLogs under the public Robinhood Chain testnet node's span caps (measured 05.10.2026):
// - one address and at most one value per topic position: 10,000,000 blocks;
// - an address list OR an OR-list in any topic position: 100,000 blocks ("send one value per position");
// - no address at all: 30,000 blocks ("add an address filter"), whatever the topics;
// - and any answer is capped at 10,000 logs ("exceeds limit of 10000").
// Every log read picks its span from the filter up front (no wasted "too big" round trips) and, when a short
// OR-list over a long range would cost more requests than one single-valued request per value, sends those
// instead (a log matches exactly one value per position, so the parts never overlap).
// Pure: no RPC client here, the caller passes its own request function.

export const SPAN_SINGLE = 9_500_000;
export const SPAN_LIST = 99_000;
export const SPAN_NO_ADDRESS = 29_000;

export type LogFilter = { address?: string | string[]; topics?: (string | string[] | null)[] };
export type LogQuery = LogFilter & { fromBlock: `0x${string}`; toBlock: `0x${string}` };

const hex = (n: number) => `0x${n.toString(16)}` as `0x${string}`;
const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))];

/** Largest block span the node accepts for this filter. */
export function spanFor(f: LogFilter): number {
  const addrs = f.address === undefined ? [] : Array.isArray(f.address) ? uniq(f.address) : [f.address];
  if (!addrs.length) return SPAN_NO_ADDRESS;
  const multi = addrs.length > 1 || (f.topics ?? []).some((t) => Array.isArray(t) && uniq(t).length > 1);
  return multi ? SPAN_LIST : SPAN_SINGLE;
}

/** One-value-per-position parts of a filter (address list x every topic OR-list). */
function explode(f: LogFilter): LogFilter[] {
  let parts: LogFilter[] = [{ address: undefined, topics: [] }];
  const addrs = f.address === undefined ? [undefined] : Array.isArray(f.address) ? uniq(f.address) : [f.address];
  parts = addrs.map((a) => ({ address: a, topics: [] }));
  for (const t of f.topics ?? []) {
    const vals = Array.isArray(t) ? uniq(t) : [t];
    const next: LogFilter[] = [];
    for (const p of parts) for (const v of vals) next.push({ address: p.address, topics: [...(p.topics ?? []), v] });
    parts = next;
  }
  return parts.map((p) => (p.address === undefined ? { topics: p.topics } : p));
}

const errText = (e: unknown) => String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? e);
const isRate = (m: string) => /429|rate limit|too many requests/i.test(m);
// too many logs in the answer, the node timing out, or a cap tighter than we know: split the range
const isBig = (m: string) => /exceeds limit|timed? ?out|took too long|too many (logs|results)|response size|size limit|narrow the block range|only \d+ are allowed/i.test(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Requests needed for [from, to] with this filter, sent as is or exploded. */
export function plan(f: LogFilter, from: number, to: number): { filters: LogFilter[]; span: number; requests: number } {
  const S = Math.max(0, to - from + 1);
  const span = spanFor(f);
  const asIs = Math.ceil(S / span);
  if (span === SPAN_LIST) {
    const parts = explode(f);
    const exploded = parts.length * Math.ceil(S / SPAN_SINGLE);
    if (parts.length <= 200 && exploded < asIs) return { filters: parts, span: SPAN_SINGLE, requests: exploded };
  }
  return { filters: [f], span, requests: asIs };
}

/**
 * Every log matching `f` in [from, to]: node-sized ranges, `concurrency` in flight, 429 -> back off,
 * "too many logs" -> split in half. Throws when a range still fails (the caller reports unknown).
 * Order: by part, then by range (callers sort by block/logIndex when they need chain order).
 */
export async function getLogsChunked<T>(
  f: LogFilter,
  from: number,
  to: number,
  call: (q: LogQuery) => Promise<T[]>,
  opts: { concurrency?: number } = {},
): Promise<T[]> {
  if (to < from) return [];
  const { filters, span } = plan(f, from, to);
  const jobs: { f: LogFilter; a: number; b: number }[] = [];
  for (const pf of filters) for (let a = from; a <= to; a += span) jobs.push({ f: pf, a, b: Math.min(to, a + span - 1) });
  const one = async (pf: LogFilter, a: number, b: number, attempt = 0, depth = 0): Promise<T[]> => {
    try {
      return await call({ ...pf, fromBlock: hex(a), toBlock: hex(b) });
    } catch (e) {
      const m = errText(e);
      if (isRate(m) && attempt < 5) {
        await sleep(400 * 2 ** attempt + Math.random() * 200);
        return one(pf, a, b, attempt + 1, depth);
      }
      if (isBig(m) && b > a && depth < 16) {
        const mid = Math.floor((a + b) / 2);
        const x = await one(pf, a, mid, 0, depth + 1);
        const y = await one(pf, mid + 1, b, 0, depth + 1);
        return x.concat(y);
      }
      throw e;
    }
  };
  const out: T[][] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await one(jobs[i].f, jobs[i].a, jobs[i].b);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, jobs.length) }, worker));
  const flat: T[] = [];
  for (const part of out) for (const l of part) flat.push(l); // no spread: a part can hold ~10k logs
  return flat;
}
