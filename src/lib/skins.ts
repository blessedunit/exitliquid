// The cast: 8-bit traders ranked by bag size. Internal skin ids are kept from v1
// so queue logic, stored data and URLs don't change; only the art and names did.
// Sprites live in /public/sprites (made by scripts/sprites.py from brand/pixel/raw).

export type Skin = "plain" | "hood" | "bag" | "getaway" | "suit" | "architect" | "ghost" | "doorghost";

export type SpriteInfo = {
  name: string; // display name
  w: number; // true low-res size in sprite pixels
  h: number;
  faces: "right" | "left"; // which way the art looks
  blurb: string;
};

export const SPRITES: Record<Skin, SpriteInfo> = {
  plain: { name: "Broke Degen", w: 42, h: 81, faces: "right", blurb: "hoodie, instant noodles, cracked phone" },
  hood: { name: "Retail", w: 45, h: 75, faces: "right", blurb: "backwards cap, backpack, one green candle" },
  bag: { name: "Chart Guy", w: 42, h: 80, faces: "right", blurb: "headset, energy drink, twelve indicators" },
  getaway: { name: "Crypto Bro", w: 41, h: 73, faces: "right", blurb: "sunglasses indoors, gold chain, money bag" },
  suit: { name: "The Suit", w: 36, h: 73, faces: "right", blurb: "grey hair, briefcase, has seen this before" },
  architect: { name: "The Dev", w: 38, h: 79, faces: "right", blurb: "sticker laptop, cold coffee, place #1" },
  ghost: { name: "Ghost", w: 47, h: 87, faces: "right", blurb: "sold everything, waves on the way out" },
  // the old see-through "door ghost" art is retired (operator 16.10): the dev at the door is drawn as the Dev
  doorghost: { name: "The Dev", w: 38, h: 79, faces: "right", blurb: "sticker laptop, cold coffee, place #1" },
};

/** Public URL of a sprite at an integer nearest-neighbour scale (1, 2, 3, 4 or 8). */
export function spriteSrc(skin: Skin, scale: 1 | 2 | 3 | 4 | 8 = 1): string {
  if (skin === "doorghost") skin = "architect";
  return scale === 1 ? `/sprites/${skin}.png` : `/sprites/${skin}@${scale}x.png`;
}
