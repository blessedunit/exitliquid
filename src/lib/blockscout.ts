// A wallet's ERC-20 transfers from the Robinhood Chain testnet Blockscout (API v2).
// Since 05.10.2026 the public node answers a topic-only eth_getLogs over 30,000 blocks at most, so "every
// transfer to / from this wallet over the whole history" can't come from the node any more (~4,300 calls).
// Blockscout indexes them by address: 50 per page, newest first, cursor paging (next_page_params).
// Measured 05.10: ~0.3-0.8 s a page, the index ~6 blocks behind the head. It answers 403 without a browser
// user-agent. Unknown is never zero: a failed page throws, a page cap is reported as `complete: false`.
import "server-only";
import { EXPLORER } from "./config";

const HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0" };

export type BsTransfer = { token: string; from: string; to: string; value: bigint; block: number; logIndex: number; tx: string; ts: number | null };

/** At most 8 Blockscout calls in flight per server instance (shared by every page that reads it). */
let active = 0;
const queue: (() => void)[] = [];
async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 8) await new Promise<void>((res) => queue.push(res));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

async function getJson(url: string, attempt = 0): Promise<unknown> {
  const r = await gated(() => fetch(url, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(8_000) }));
  if ((r.status === 429 || r.status >= 500) && attempt < 2) {
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    return getJson(url, attempt + 1);
  }
  if (!r.ok) throw new Error(`blockscout ${r.status}`);
  return r.json();
}

type Page<T> = { items?: T[]; next_page_params?: Record<string, string | number | null> | null };
type RawTransfer = {
  block_number?: number;
  log_index?: number;
  transaction_hash?: string;
  timestamp?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  token?: { address_hash?: string; address?: string; type?: string };
  total?: { value?: string } | null;
};

const qs = (p: Record<string, string | number | null>) =>
  Object.entries(p)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

/**
 * ERC-20 transfers of `addr`, newest first. `filter`: only incoming ("to") or outgoing ("from").
 * Stops at `maxPages`, at `deadline` (ms epoch) or once the pages reach below `stopBelow` (a block) or
 * `stopBeforeTs` (unix s): `complete` = the whole history (or everything at/after the stop point) is in.
 * `oldestTs` = the oldest transfer time read: an incomplete read covers everything at/after it. Throws when Blockscout fails.
 */
export async function addressTransfers(
  addr: string,
  opts: { filter?: "to" | "from"; maxPages?: number; stopBelow?: number; stopBeforeTs?: number; deadline?: number } = {},
): Promise<{ items: BsTransfer[]; complete: boolean; oldestBlock: number | null; oldestTs: number | null }> {
  const a = addr.toLowerCase();
  const base = `${EXPLORER}/api/v2/addresses/${a}/token-transfers`;
  const fixed: Record<string, string> = { type: "ERC-20", ...(opts.filter ? { filter: opts.filter } : {}) };
  const items: BsTransfer[] = [];
  let cursor: Record<string, string | number | null> | null = {};
  let pages = 0;
  let oldest: number | null = null;
  let oldestTs: number | null = null;
  const maxPages = opts.maxPages ?? 40;
  while (cursor) {
    if (pages >= maxPages || (opts.deadline && Date.now() > opts.deadline && pages > 0)) return { items, complete: false, oldestBlock: oldest, oldestTs };
    const page = (await getJson(`${base}?${qs({ ...fixed, ...cursor })}`)) as Page<RawTransfer>;
    pages++;
    for (const it of page.items ?? []) {
      const token = (it.token?.address_hash ?? it.token?.address ?? "").toLowerCase();
      const from = (it.from?.hash ?? "").toLowerCase();
      const to = (it.to?.hash ?? "").toLowerCase();
      if (!token || !from || !to || typeof it.block_number !== "number") continue;
      let value = 0n;
      try {
        value = BigInt(it.total?.value ?? "0");
      } catch {
        continue;
      }
      const ts = it.timestamp ? Math.floor(Date.parse(it.timestamp) / 1000) : NaN;
      items.push({ token, from, to, value, block: it.block_number, logIndex: it.log_index ?? 0, tx: (it.transaction_hash ?? "").toLowerCase(), ts: Number.isFinite(ts) ? ts : null });
      oldest = oldest === null ? it.block_number : Math.min(oldest, it.block_number);
      if (Number.isFinite(ts)) oldestTs = oldestTs === null ? ts : Math.min(oldestTs, ts);
    }
    const np = page.next_page_params;
    if (!np || !(page.items ?? []).length) return { items, complete: true, oldestBlock: oldest, oldestTs };
    if (opts.stopBelow !== undefined && oldest !== null && oldest < opts.stopBelow) return { items, complete: true, oldestBlock: oldest, oldestTs };
    if (opts.stopBeforeTs !== undefined && oldestTs !== null && oldestTs < opts.stopBeforeTs) return { items, complete: true, oldestBlock: oldest, oldestTs };
    cursor = np;
  }
  return { items, complete: true, oldestBlock: oldest, oldestTs };
}

/** ERC-20 tokens `addr` holds now (Blockscout's balances). `complete: false` = more pages than `maxPages`. */
export async function addressTokens(addr: string, maxPages = 8): Promise<{ tokens: string[]; complete: boolean }> {
  const base = `${EXPLORER}/api/v2/addresses/${addr.toLowerCase()}/tokens`;
  const tokens: string[] = [];
  let cursor: Record<string, string | number | null> | null = {};
  for (let pages = 0; cursor; pages++) {
    if (pages >= maxPages) return { tokens, complete: false };
    const page = (await getJson(`${base}?${qs({ type: "ERC-20", ...cursor })}`)) as Page<{ token?: { address_hash?: string; address?: string } }>;
    for (const it of page.items ?? []) {
      const t = (it.token?.address_hash ?? it.token?.address ?? "").toLowerCase();
      if (t) tokens.push(t);
    }
    cursor = page.next_page_params && (page.items ?? []).length ? page.next_page_params : null;
  }
  return { tokens, complete: true };
}

/** The tx that created contract `addr` (a factory launch: the factory's tx). null = Blockscout doesn't say. Throws on failure. */
export async function creationTx(addr: string): Promise<string | null> {
  const j = (await getJson(`${EXPLORER}/api/v2/addresses/${addr.toLowerCase()}`)) as { creation_transaction_hash?: string | null; is_contract?: boolean };
  const h = j?.creation_transaction_hash;
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? h.toLowerCase() : null;
}
