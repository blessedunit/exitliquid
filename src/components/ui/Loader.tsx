// The one loading state of the site: our pixel traders, redrawn as glowing ASCII, walking into the EXIT door,
// with what is being read said in plain text next to it (the caption is the accessible status).
// size "scene" = a strip (cards, sections, pages); "mini" = one small trader and a tiny door (inline slots; in a tall
// box such as the grade square it draws a bigger one). The picture is a canvas (AsciiCrowd); its box is reserved in
// CSS so nothing shifts, and it is a still frame under prefers-reduced-motion.
// Skeleton bars that hold a table's layout use `shimmer` (a soft left-to-right sweep) instead of a flat pulse.
import AsciiCrowd from "./AsciiCrowd";
import l from "./Loader.module.css";

/** class for a skeleton bar: the same soft sweep everywhere */
export const shimmer = l.shimmer;

export default function Loader({ caption, size = "scene", center = false, className }: {
  caption?: string;
  size?: "scene" | "mini";
  center?: boolean;
  className?: string;
}) {
  const cls = `${size === "mini" ? l.mini : l.scene} ${center ? l.center : ""} ${className ?? ""}`;
  // a caption makes it the status; without one it is decoration next to a status said elsewhere
  const a11y = caption ? { role: "status" as const } : { "aria-hidden": true as const };
  if (size === "mini") {
    return (
      <span className={cls} {...a11y}>
        <AsciiCrowd variant="mini" grow={!caption} className={l.miniCv} tallClassName={l.miniTall} />
        {caption && <span className={l.cap}>{caption}</span>}
      </span>
    );
  }
  return (
    <div className={cls} {...a11y}>
      <AsciiCrowd variant="scene" className={l.stage} />
      {caption && <p className={l.cap}>{caption}</p>}
    </div>
  );
}
