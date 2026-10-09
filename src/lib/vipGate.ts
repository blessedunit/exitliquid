// Server-side VIP gate.
//
// VIP = the wallet holds VIP_MIN_TOKENS $EXIT. Until now that was checked only in the browser, so the
// VIP API answers (Line Health first buyers, Top holders' funding clusters) went to anyone who asked.
// Now a wallet proves it is yours ONCE with a free personal_sign; the server checks the signature and the
// balance, then sets an httpOnly cookie signed with HMAC-SHA256 for VIP_SESSION_HOURS.
// Every VIP route calls vipFromRequest(req): cookie valid + not expired + balance still >= the minimum
// (re-read at most every few minutes; if the chain doesn't answer, the session stands, it was proven).
//
// Cookie: exit_vip=<base64url(json {a, iat, exp, v})>.<base64url(hmac)>
import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { client } from "./chain";
import { ACTIVE_TOKEN } from "./config";
import { BoundedTtlMap } from "./bounded";
import { redis, storeKind } from "./store";
import { parseVipMessage, VIP_MIN_TOKENS, VIP_SESSION_HOURS, VIP_SIGN_MAX_AGE_SEC, VIP_SIGN_MAX_SKEW_SEC } from "./vip";

export const VIP_COOKIE = "exit_vip";
const SESSION_SEC = VIP_SESSION_HOURS * 3600;
const BALANCE_TTL_MS = 30_000; // a fresh check (sign-in, /api/vip)
const RECHECK_TTL_MS = 60_000; // an open session re-reads the balance this often (a bag moved to another wallet closes it within a minute)
const BALANCE_OF = "0x70a08231";

/* ---------------- secret ---------------- */

let key: Buffer | null = null;
let keyKind: "env" | "derived" | "ephemeral" = "ephemeral";
// Domain separation per deployment environment: preview and production may share RUN_SECRET / KV tokens,
// and a cookie signed on a preview must never verify on prod.
const scope = () => (process.env.VERCEL_ENV || process.env.NODE_ENV || "dev").trim();
function secret(): Buffer {
  if (key) return key;
  const env = (process.env.VIP_SECRET || process.env.RUN_SECRET || "").trim();
  if (env.length >= 16) {
    key = createHash("sha256").update(`exit-vip-v1:${scope()}:${env}`).digest();
    keyKind = "env";
    return key;
  }
  // set VIP_SECRET (32+ random chars, e.g. `openssl rand -hex 32`) in the deployment env.
  // Fallback 1: derive from a server-only secret that is already configured (the KV / Upstash token):
  // stable across instances and restarts, never shipped to the client. Rotating that token logs VIP users out.
  const seed = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (seed.length >= 16) {
    key = createHash("sha256").update(`exit-vip-derived-v1:${scope()}:${seed}`).digest();
    keyKind = "derived";
    return key;
  }
  // Fallback 2: a random key per server instance. Secure, but a session only works on the instance that
  // issued it and dies on a cold start (the user simply signs again).
  key = randomBytes(32);
  keyKind = "ephemeral";
  if (process.env.NODE_ENV === "production") console.warn("[vip] VIP_SECRET is not set: VIP sessions use a per-instance key");
  return key;
}
/** for /status: where the signing key comes from (never the key itself) */
export function vipKeyKind() {
  secret();
  return keyKind;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (payload: string) => createHmac("sha256", secret()).update(payload).digest();

export type VipSession = { wallet: string; iat: number; exp: number };

export function sealSession(wallet: string, nowSec = Math.floor(Date.now() / 1000)): { value: string; session: VipSession } {
  const session: VipSession = { wallet: wallet.toLowerCase(), iat: nowSec, exp: nowSec + SESSION_SEC };
  const payload = b64u(JSON.stringify({ a: session.wallet, iat: session.iat, exp: session.exp, v: 1 }));
  return { value: `${payload}.${b64u(mac(payload))}`, session };
}

export function openSession(value: string | null | undefined, nowSec = Math.floor(Date.now() / 1000)): VipSession | null {
  if (!value || value.length > 400) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  let given: Buffer;
  try {
    given = Buffer.from(value.slice(dot + 1), "base64url");
  } catch {
    return null;
  }
  const want = mac(payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { a?: unknown; iat?: unknown; exp?: unknown; v?: unknown };
    if (j.v !== 1 || typeof j.a !== "string" || !/^0x[0-9a-f]{40}$/.test(j.a)) return null;
    if (typeof j.exp !== "number" || typeof j.iat !== "number" || j.exp <= nowSec || j.iat > nowSec + 60) return null;
    return { wallet: j.a, iat: j.iat, exp: j.exp };
  } catch {
    return null;
  }
}

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const secureFlag = () => (process.env.NODE_ENV === "production" ? "; Secure" : "");
export function sessionCookie(value: string): string {
  return `${VIP_COOKIE}=${value}; Path=/; Max-Age=${SESSION_SEC}; HttpOnly; SameSite=Lax${secureFlag()}`;
}
export function clearCookie(): string {
  return `${VIP_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag()}`;
}

/* ---------------- balance ---------------- */

const balances = new BoundedTtlMap<number>(5_000);
const reading = new Map<string, Promise<number | null>>();

/** $EXIT held by a wallet, whole tokens (6 decimals kept); null = the chain didn't answer (unknown, never 0). */
export async function exitBalance(wallet: string, maxAgeMs = BALANCE_TTL_MS): Promise<number | null> {
  const w = wallet.toLowerCase();
  if (!ACTIVE_TOKEN) return null;
  const hit = balances.get(w);
  if (hit !== undefined && maxAgeMs > 0) return hit;
  const busy = reading.get(w);
  if (busy) return busy;
  const p = (async () => {
    try {
      const r = await client.call({ to: ACTIVE_TOKEN as `0x${string}`, data: `${BALANCE_OF}${w.slice(2).padStart(64, "0")}` as `0x${string}` });
      const raw = r.data ? BigInt(r.data) : 0n;
      const tokens = Number(raw / 10n ** 12n) / 1e6;
      balances.set(w, tokens, Math.max(maxAgeMs, BALANCE_TTL_MS));
      return tokens;
    } catch {
      return null;
    } finally {
      reading.delete(w);
    }
  })();
  reading.set(w, p);
  return p;
}

/* ---------------- request side ---------------- */

/** The VIP session on this request, re-checked against the balance; null = not VIP (or no session). */
export async function vipSessionFromRequest(req: Request): Promise<(VipSession & { tokens: number | null }) | null> {
  const s = openSession(cookieValue(req, VIP_COOKIE));
  if (!s) return null;
  const tokens = await exitBalance(s.wallet, RECHECK_TTL_MS);
  if (tokens !== null && tokens < VIP_MIN_TOKENS) return null; // sold below the line: the session no longer opens anything
  return { ...s, tokens };
}

/** true = this request carries a valid VIP session for a wallet that (still) holds the minimum. Never throws. */
export async function vipFromRequest(req: Request): Promise<boolean> {
  try {
    return (await vipSessionFromRequest(req)) !== null;
  } catch {
    return false;
  }
}

/* ---------------- sign-in ---------------- */

// One signed message opens one session. Keyed on the MESSAGE (address + issued time), not the signature
// string: high-s / v-variants of one signature are different strings but the same message. Claimed in
// Redis (SET NX) when it is configured, so a replay on another instance fails too; else per instance.
const usedSigs = new BoundedTtlMap<true>(20_000);
const USED_TTL_SEC = VIP_SIGN_MAX_AGE_SEC + VIP_SIGN_MAX_SKEW_SEC;

/** true = this message was not used before and is now claimed. */
async function claimMessage(message: string): Promise<boolean> {
  const k = createHash("sha256").update(message).digest("hex");
  if (usedSigs.has(k)) return false;
  if (storeKind === "redis") {
    try {
      const r = await redis(["SET", `vip:used:${scope()}:${k}`, "1", "NX", "EX", USED_TTL_SEC]);
      if (r !== "OK") return false;
    } catch {
      // Redis down: fall back to this instance's memory (the 10-minute window still bounds a replay)
    }
  }
  usedSigs.set(k, true, USED_TTL_SEC * 1000);
  return true;
}

export type SignInResult =
  | { ok: true; session: VipSession; cookie: string; tokens: number }
  | { ok: false; status: number; error: "bad_request" | "bad_message" | "expired" | "bad_signature" | "not_vip" | "unknown"; tokens?: number | null };

export async function signIn(body: unknown): Promise<SignInResult> {
  const b = (body ?? {}) as { address?: unknown; message?: unknown; signature?: unknown };
  const address = typeof b.address === "string" ? b.address.toLowerCase() : "";
  const signature = typeof b.signature === "string" ? b.signature : "";
  if (!/^0x[0-9a-f]{40}$/.test(address) || !/^0x[0-9a-fA-F]{130,4000}$/.test(signature)) return { ok: false, status: 400, error: "bad_request" };
  const msg = parseVipMessage(b.message);
  if (!msg || msg.address !== address) return { ok: false, status: 400, error: "bad_message" };
  const age = (Date.now() - msg.issuedMs) / 1000;
  if (age > VIP_SIGN_MAX_AGE_SEC || age < -VIP_SIGN_MAX_SKEW_SEC) return { ok: false, status: 401, error: "expired" };
  if (usedSigs.has(createHash("sha256").update(b.message as string).digest("hex"))) return { ok: false, status: 401, error: "expired" };

  let valid = false;
  try {
    // EOAs by ecrecover; smart wallets through ERC-1271 / ERC-6492 (viem does both)
    valid = await client.verifyMessage({ address: address as `0x${string}`, message: b.message as string, signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, status: 401, error: "bad_signature" };

  const tokens = await exitBalance(address, 0);
  if (tokens === null) return { ok: false, status: 503, error: "unknown", tokens: null };
  if (tokens < VIP_MIN_TOKENS) return { ok: false, status: 403, error: "not_vip", tokens };

  if (!(await claimMessage(b.message as string))) return { ok: false, status: 401, error: "expired" };
  const { value, session } = sealSession(address);
  return { ok: true, session, cookie: sessionCookie(value), tokens };
}
