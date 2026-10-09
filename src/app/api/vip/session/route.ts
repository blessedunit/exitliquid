import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";
import { VIP_MIN_TOKENS } from "@/lib/vip";
import { clearCookie, signIn, vipSessionFromRequest } from "@/lib/vipGate";

export const dynamic = "force-dynamic";

// VIP session: GET = who is signed in on this device; DELETE = sign out (clears an old cookie).
// Closed for new sessions (09.10): every analytic is open, so POST answers 410 and never issues a cookie.
// The sign-in path (signIn in lib/vipGate.ts) stays in the code but is not reachable from here.
const SIGN_LIMIT: Limit = { name: "vipsign", limit: 10, windowSec: 60 }; // each POST costs a signature check + 1 eth_call
const NO_STORE = { "cache-control": "no-store" };
const OPEN = true; // nothing is gated: no new sessions

export async function GET(req: Request) {
  if (!(await rateLimit({ name: "vipget", limit: 120, windowSec: 60 }, clientIp(req), { localOnly: true }))) return tooMany();
  const s = await vipSessionFromRequest(req);
  if (!s) return Response.json({ wallet: null, exp: null, min: VIP_MIN_TOKENS }, { headers: NO_STORE });
  return Response.json({ wallet: s.wallet, exp: s.exp, tokens: s.tokens, min: VIP_MIN_TOKENS }, { headers: NO_STORE });
}

/** a browser sends Origin on a cross-site POST: only our own pages may set the session (no login CSRF) */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // not a browser cross-site request (curl, server-side)
  try {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (OPEN) return Response.json({ error: "gone", detail: "Everything is open. No sign-in needed." }, { status: 410, headers: NO_STORE });
  if (!sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403, headers: NO_STORE });
  if (!(await rateLimit(SIGN_LIMIT, clientIp(req)))) return tooMany();
  let body: unknown = null;
  try {
    const text = await req.text();
    if (text.length > 8_000) return Response.json({ error: "bad_request" }, { status: 413, headers: NO_STORE });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }
  const r = await signIn(body);
  if (!r.ok) return Response.json({ error: r.error, tokens: r.tokens ?? null, min: VIP_MIN_TOKENS }, { status: r.status, headers: NO_STORE });
  return Response.json(
    { wallet: r.session.wallet, exp: r.session.exp, tokens: r.tokens, min: VIP_MIN_TOKENS },
    { headers: { ...NO_STORE, "set-cookie": r.cookie } },
  );
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return Response.json({ error: "bad_origin" }, { status: 403, headers: NO_STORE });
  return Response.json({ wallet: null, exp: null }, { headers: { ...NO_STORE, "set-cookie": clearCookie() } });
}
