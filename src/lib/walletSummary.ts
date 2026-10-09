// The one-sentence lead of /w/<addr>, built only from known fields. An unknown part is dropped, never
// written as 0 / "none". Pure (no server imports) so the client view can rebuild it when entries arrive.
// Kept apart from lib/walletProfile.ts because that module is server-only; it re-exports this function.
import type { EntriesResponse, WalletProfile } from "./walletProfile";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function walletSummary(p: WalletProfile, e: EntriesResponse | null = null): string | null {
  const parts: string[] = [];
  const ent = e && e.status === "ok" ? e : null;

  if (p.kind.faucet) return "The public testnet faucet: it funds most wallets here and links no one.";
  if (p.kind.plumbing) return `vibe/vibe or Uniswap plumbing (${p.kind.plumbing}): it moves tokens for everyone, never a person.`;

  // how early it buys
  const sniper = p.tags.some((t) => t.id === "sniper");
  if (ent && ent.checked > 0) parts.push(`${sniper ? "known sniper, " : ""}first-20 buyer on ${ent.first20} of ${plural(ent.checked, "checked launch", "checked launches")}${ent.pending ? " so far" : ""}`);
  else if (sniper) parts.push("Known sniper (Early Index)");

  // launches created
  const devTotal = p.dev.status === "ok" ? p.dev.total : null;
  const own = ent?.ownLaunches ?? 0;
  if (devTotal !== null && devTotal > 0) parts.push(`created ${plural(devTotal, "launch", "launches")}${p.dev.graduated ? `, ${p.dev.graduated} graduated` : ""}`);
  else if (own > 0) parts.push(`created ${own}+ launches`);

  // holding vs walked out
  const a = p.activity;
  if (a.status !== "unavailable") {
    if (a.bought > 0) parts.push(`still holds ${a.holding} of ${a.bought}${a.status === "partial" ? "+" : ""} launches bought`);
    else if (a.status === "ok" && devTotal === 0) parts.push("no vibe/vibe launches bought yet");
  }

  // funding link
  const f = p.funding;
  if (f.status === "ok") {
    if (f.kind === "faucet") parts.push("funded by the faucet");
    else if (f.kind === "source" && f.siblings.status === "ok" && f.siblings.total > 0)
      parts.push(`funded by ${f.funder?.busy ? "a hub" : "a wallet"} that funded ${f.siblings.total}${f.siblings.capped ? "+" : ""} others`);
  }

  if (!parts.length) return null;
  const s = parts.join(" · ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}
