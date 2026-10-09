// Upstash Redis (REST) client, used by the global rate limiter (lib/limits.ts).
// Configured by UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or Vercel KV_REST_API_*);
// without them storeKind is "memory" and callers stay on their local fallback.
// (The Exit Run score board that used to live here was retired 30.09.)
import "server-only";

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

/** One Upstash REST command. Bounded by a timeout so a slow Redis can't pin a request. */
export async function redis(cmd: (string | number)[]) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
  // Upstash answers command errors with HTTP 400 + {"error": "..."}: keep the message
  const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!r.ok || j.error) throw new Error(`redis ${r.status}: ${String(j.error ?? "").slice(0, 200)}`);
  return j.result as never;
}

export const storeKind = URL_ && TOKEN ? "redis" : "memory";
