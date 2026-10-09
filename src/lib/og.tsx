// Shared pieces for next/og images (satori): fonts and the trader sprites as data URIs.
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SPRITES, type Skin } from "@/lib/skins";

export async function ogFonts() {
  const dir = path.join(process.cwd(), "src", "assets", "fonts");
  const [pixel, body, bodyBold] = await Promise.all([
    readFile(path.join(dir, "Silkscreen-700.ttf")),
    readFile(path.join(dir, "SpaceGrotesk-500.ttf")),
    readFile(path.join(dir, "SpaceGrotesk-700.ttf")),
  ]);
  return [
    { name: "Pixel", data: pixel, weight: 700 as const, style: "normal" as const },
    { name: "Body", data: body, weight: 500 as const, style: "normal" as const },
    { name: "Body", data: bodyBold, weight: 700 as const, style: "normal" as const },
  ];
}

export type OgSprite = { src: string; w: number; h: number; flip: boolean };

/** A sprite pre-scaled with nearest neighbour on disk (so satori never smooths it). */
export async function ogSprite(skin: Skin, scale: 2 | 3 | 4 = 2, face: "right" | "left" = "right"): Promise<OgSprite> {
  const file = path.join(process.cwd(), "public", "sprites", `${skin}@${scale}x.png`);
  const data = await readFile(file);
  const s = SPRITES[skin];
  return { src: `data:image/png;base64,${data.toString("base64")}`, w: s.w * scale, h: s.h * scale, flip: face !== s.faces };
}

export function OgImg({ s, opacity = 1 }: { s: OgSprite; opacity?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={s.src} width={s.w} height={s.h} alt="" style={s.flip ? { opacity, transform: "scaleX(-1)" } : { opacity }} />
  );
}

export const OG = {
  bg: "#0b100d",
  bg2: "#101812",
  ink: "#070b09",
  text: "#eef3ea",
  muted: "#a3b3a6",
  faint: "#6f7e72",
  exit: "#3ddc84",
  sign: "#0b9c4b",
  red: "#ff5a5f",
  amber: "#ffd23f",
  hair: "#26352b",
};
