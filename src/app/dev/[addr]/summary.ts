// The one-sentence lead of /dev/<addr>, built only from known fields: an unknown part is dropped,
// never written as 0. Facts, not a verdict.
import { fmtDuration, type DevPassport } from "@/lib/devrep";
import { fmtInt } from "@/lib/format";

export function devSummary(p: DevPassport, now: number): string {
  if (p.loaded === 0 && p.onChain) {
    const c = p.onChain;
    return `${fmtInt(c.launches)} launch${c.launches === 1 ? "" : "es"} on chain (vibe/vibe lists none) · ${fmtInt(c.grads)} graduated. Dev sells are unknown for them.`;
  }
  // the taxed v6 list did not answer: "none" would be a guess
  if (p.loaded === 0 && p.coverage === "v1-only") return "No curve launches by this wallet. Taxed v6 launches couldn't be read right now: unknown, not zero.";
  if (p.loaded === 0) return "No launches by this wallet on vibe/vibe. It may still trade, or launch from another wallet.";

  const parts: string[] = [];
  const cut = p.total === null || p.total > p.loaded;
  const n = p.onChain ? p.onChain.launches : p.total ?? p.loaded;
  const count = p.total === null && !p.onChain ? `${p.loaded}+` : fmtInt(n);
  const times = p.launches.map((l) => l.createdAt).filter((t) => t > 0);
  const oldest = times.length ? Math.min(...times) : 0;
  const days = oldest ? Math.max(1, Math.round((now - oldest) / 86_400)) : null;

  // the chain's count wins (vibe's list leaves old factories out); its graduations are counted on the same base
  const grads = p.onChain ? Math.max(p.onChain.grads, p.graduated) : p.graduated;
  // the time span is read from vibe's list: with launches it doesn't list, the span is unknown
  const span = !cut && !p.onChain && days !== null;
  if (n === 1 && !cut) parts.push(`1 launch${days !== null ? `, ${days} day${days === 1 ? "" : "s"} ago` : ""}`);
  else parts.push(`${count} launches${span ? ` in ${days} day${days === 1 ? "" : "s"}` : ""}`);

  parts.push(cut && !p.onChain ? `${grads} graduated in the newest ${p.loaded}` : `${grads} graduated`);

  const s = p.summary;
  if (p.chain === "ok" && s.devHeld !== null) {
    if (s.devHeld === 0) parts.push("never held their own bag");
    else if (s.soldIn === 0) parts.push(`held their bag on ${s.devHeld}, never sold`);
    else if (s.soldIn !== null)
      parts.push(`sold their bag on ${s.soldIn} of ${s.devHeld}${s.medianFirstSell !== null ? `, median first sell ${fmtDuration(s.medianFirstSell)} after launch` : ""}`);
  }
  const out = parts.join(" · ");
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}.`;
}
