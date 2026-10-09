"use client";
// Warm-on-hover data: a GET started while the pointer rests on a link is kept here for a short while,
// so the page it opens takes that very response instead of asking the server again (one request, not two).
type Entry = { at: number; res: Promise<Response> };
const primed = new Map<string, Entry>();
const TTL_MS = 20_000;

export function prime(url: string): void {
  const hit = primed.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return;
  if (primed.size > 30) primed.clear(); // tiny by design: a few hovered rows at most
  const res = fetch(url);
  res.catch(() => primed.delete(url));
  primed.set(url, { at: Date.now(), res });
}

// the primed response for this URL, once, if it is still fresh (a clone: the body can be read again)
export function takePrimed(url: string): Promise<Response> | null {
  const hit = primed.get(url);
  if (!hit) return null;
  primed.delete(url);
  if (Date.now() - hit.at >= TTL_MS) return null;
  return hit.res.then((r) => r.clone());
}
