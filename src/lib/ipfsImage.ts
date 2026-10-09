// Token pictures from IPFS. Public gateways are slow for fresh files (4-8 s), so:
// all gateways race, the winner is stored in the Vercel data cache (shared by every server,
// kept for a year: an IPFS file never changes), and the launch list warms its pictures in the background.
import "server-only";

const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/"];
const MAX_BYTES = 1_900_000; // the data cache keeps items up to ~2 MB
const TYPES = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/;
const YEAR = 31_536_000;

export const isCid = (cid: string) => /^[a-zA-Z0-9]{46,100}$/.test(cid);

async function one(g: string, cid: string, signal: AbortSignal) {
  const r = await fetch(g + cid, { signal, next: { revalidate: YEAR } });
  if (!r.ok) throw new Error(String(r.status));
  const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!TYPES.test(type)) throw new Error("not an image");
  const body = await r.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new Error("too big");
  return { type, body };
}

/** The picture, or null when no gateway had it in time. */
export async function ipfsImage(cid: string, timeoutMs = 9_000): Promise<{ type: string; body: ArrayBuffer } | null> {
  if (!isCid(cid)) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await Promise.any(GATEWAYS.map((g) => one(g, cid, ac.signal)));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}
