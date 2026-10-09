// Abuse limits shared by the API routes.
//
// Two layers:
// 1. In-memory, per server instance: a bounded fixed-window counter. Cheap, always on,
//    and it keeps floods from ever reaching Redis. On Vercel every instance has its own
//    copy, so on its own it is weak (N instances = N x the limit).
// 2. Global, when Upstash is configured: one INCR per (bucket, ip, window) key. Only
//    consulted after the local layer said yes, so a flood costs at most `limit` Redis
//    commands per instance per window. Any Redis error fails OPEN to the local verdict:
//    a Redis outage must not take the site down.
// Distributed floods (many IPs) are out of scope for code: use the Vercel Firewall.
import "server-only";
import { createHash } from "node:crypto";
import { redis, storeKind } from "./store";
import { BoundedTtlMap } from "./bounded";

/**
 * Client IP. On Vercel `x-forwarded-for` is set by the platform edge (client-supplied values
 * are overwritten), so the first entry is trustworthy there. Self-hosted without a proxy in
 * front, the header is spoofable: then the limit is per claimed IP, which is still bounded
 * by the global limiter's key space expiring every window.
 */
export function clientIp(req: Request | Headers): string {
  const h = req instanceof Headers ? req : req.headers;
  const xff = h.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0] : h.get("x-real-ip") || "").trim();
  return ip.slice(0, 64) || "local";
}

const local = new BoundedTtlMap<number>(20_000);

export type Limit = { name: string; limit: number; windowSec: number };

export const LIMITS = {
  ticket: { name: "ticket", limit: 60, windowSec: 60 }, // wallet lookups (each can cost an RPC call)
  og: { name: "og", limit: 30, windowSec: 60 }, // ticket OG renders (CPU + RPC)
  queue: { name: "queue", limit: 120, windowSec: 60 }, // live line polling (a ticket polls every 10 s)
  wallet: { name: "wallet", limit: 20, windowSec: 60 }, // My Lines wallet scans (getLogs + 2 multicalls)
  line: { name: "line", limit: 120, windowSec: 60 }, // place in a token line (cold token = full history load)
  img: { name: "img", limit: 900, windowSec: 60 }, // token logos: own bucket, so a logo-heavy list never starves /api/queue (only CDN misses count)
} satisfies Record<string, Limit>;

/** true = allowed. Never throws. */
export async function rateLimit(l: Limit, ip: string, opts: { localOnly?: boolean } = {}): Promise<boolean> {
  const win = Math.floor(Date.now() / (l.windowSec * 1000));
  const k = `${l.name}:${ip}:${win}`;
  const n = (local.get(k) ?? 0) + 1;
  local.set(k, n, l.windowSec * 1000);
  if (n > l.limit) return false;
  if (storeKind !== "redis" || opts.localOnly) return true;
  try {
    const id = createHash("sha256").update(ip).digest("hex").slice(0, 16); // don't store raw IPs
    const key = `exit:rl:${l.name}:${id}:${win}`;
    const c = Number(await redis(["INCR", key]));
    // the key name carries the window, so a failed EXPIRE only leaks one small key, it never blocks anyone forever
    if (c === 1) await redis(["EXPIRE", key, l.windowSec * 2]);
    return c <= l.limit;
  } catch {
    return true; // fail open to the local verdict
  }
}

export const tooMany = () =>
  Response.json({ error: "rate_limited" }, { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } });
