// 8-bit icons drawn on a 7x7 pixel grid (crisp at any size)
export default function PixelIcon({ name, size = 14 }: { name: "copy" | "check"; size?: number }) {
  const d =
    name === "copy"
      ? "M2 0h5v5h-1v-4h-4z M0 2h5v5h-5z M1 3v3h3v-3z"
      : "M0 3h1v1h1v1h1v-1h1v-1h1v-1h1v-1h1v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1z";
  return (
    <svg width={size} height={size} viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true" style={{ display: "block" }}>
      <path d={d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
