// Loading bar (spec §1.8): --s2, the height of the real line, a 1.2s opacity pulse.
// <Skeleton w={120} />  ·  <Skeleton cell /> (24px bar for a table cell)  ·  <Skeleton h={44} w="100%" />
export default function Skeleton({ w, h = 14, cell = false, className }: { w?: number | string; h?: number; cell?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={`skel ${cell ? "cell" : ""} ${className ?? ""}`}
      style={{ width: cell ? 24 : w ?? "100%", height: h }}
    />
  );
}
