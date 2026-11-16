import { SPRITES, spriteSrc, type Skin } from "@/lib/skins";

type Props = {
  skin: Skin;
  /** CSS pixels per sprite pixel. Integers stay perfectly crisp. */
  scale?: number;
  /** Mirror the art so it looks the other way. "right" = always face right (toward the door). */
  face?: "right" | "left";
  className?: string;
  alt?: string;
  style?: React.CSSProperties;
};

// One trader, rendered as a crisp pixel sprite (image-rendering: pixelated).
// Someone who walked out (skin "ghost") is never drawn: an empty dashed slot of the same size holds the spot.
// The dev at the door ("doorghost") is a different sprite and stays.
// Eager: six tiny cached files; lazy loading inside clipped strips (overflow: hidden) left some figures blank.
function EmptySlot({ w, h, className, style }: { w: number; h: number; className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden
      className={className}
      style={{ display: "inline-block", width: w, height: h, boxSizing: "border-box", border: "1px dashed var(--t3)", opacity: 0.6, ...style }}
    />
  );
}

export default function Sprite({ skin, scale = 2, face, className, alt, style }: Props) {
  const s = SPRITES[skin];
  if (skin === "ghost") return <EmptySlot w={Math.round(s.w * scale)} h={Math.round(s.h * scale)} className={className} style={style} />;
  const flip = face && face !== s.faces;
  const src = spriteSrc(skin, scale >= 4 ? 4 : scale >= 2 ? 2 : 1);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      width={Math.round(s.w * scale)}
      height={Math.round(s.h * scale)}
      alt={alt ?? ""}
      aria-hidden={alt ? undefined : true}
      className={`pixelated ${className ?? ""}`}
      draggable={false}
      loading="eager"
      decoding="async"
      style={{ transform: flip ? "scaleX(-1)" : undefined, ...style }}
    />
  );
}

/** Head-and-shoulders crop of a sprite at 1:1 or 2:1, for compact rows. */
export function Portrait({ skin, size = 32, scale = 1, className }: { skin: Skin; size?: number; scale?: 1 | 2; className?: string }) {
  const s = SPRITES[skin];
  const flip = s.faces === "left";
  if (skin === "ghost") return <EmptySlot w={size} h={size} className={className} />;
  return (
    <span
      aria-hidden
      className={`pixelated ${className ?? ""}`}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flex: "0 0 auto",
        backgroundImage: `url(${spriteSrc(skin, scale)})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${s.w * scale}px ${s.h * scale}px`,
        backgroundPosition: `${Math.round((size - s.w * scale) / 2)}px 0px`,
        transform: flip ? "scaleX(-1)" : undefined,
      }}
    />
  );
}
