// VIP tools on exitliquid.fun unlock for wallets holding this much $EXIT (whole tokens).
// Shared by the browser and the server: no imports, no secrets here (the cookie signing lives in vipGate.ts).
export const VIP_MIN_TOKENS = 100_000;

/** How long one signature keeps VIP open on a device. */
export const VIP_SESSION_HOURS = 12;
/** A signed message older than this (or this far in the future: clock skew) is refused. */
export const VIP_SIGN_MAX_AGE_SEC = 10 * 60;
export const VIP_SIGN_MAX_SKEW_SEC = 2 * 60;

/** The exact text the wallet signs. Free personal_sign, never a transaction. */
export function vipMessage(address: string, issuedIso: string): string {
  return `exitliquid.fun VIP\naddress: ${address.toLowerCase()}\nissued: ${issuedIso}`;
}

/** Reads a VIP message back; null = not ours or malformed (strict: three lines, nothing else). */
export function parseVipMessage(message: unknown): { address: string; issuedMs: number } | null {
  if (typeof message !== "string" || message.length > 200) return null;
  const m = /^exitliquid\.fun VIP\naddress: (0x[0-9a-f]{40})\nissued: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/.exec(message);
  if (!m) return null;
  const issuedMs = Date.parse(m[2]);
  return Number.isFinite(issuedMs) ? { address: m[1], issuedMs } : null;
}
