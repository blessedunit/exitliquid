// A stable look per address: the same wallet is always drawn as the same character, across the site's /w pages.
import type { Skin } from "@/lib/skins";

const CAST: Skin[] = ["plain", "hood", "bag", "getaway", "suit"];
// snipers lean to the sunglasses look, without making the whole line identical
const SNIPER_CAST: Skin[] = ["getaway", "getaway", "getaway", "plain", "hood", "bag", "getaway", "suit"];

/** FNV-1a over the lowercased address */
function hash(a: string): number {
  let h = 0x811c9dc5;
  const s = a.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const skinOf = (address: string): Skin => CAST[hash(address) % CAST.length];
export const sniperSkinOf = (address: string): Skin => SNIPER_CAST[hash(address) % SNIPER_CAST.length];
