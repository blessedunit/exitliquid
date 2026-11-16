// A pixel hourglass: no grade yet ("Too early to grade"). Reads as "wait", not as a missing image.
// Drawn on a 9x11 pixel grid as rects so it stays crisp at any size.
const FRAME = [
  "#########",
  ".#.....#.",
  ".#.....#.",
  "..#...#..",
  "...#.#...",
  "....#....",
  "...#.#...",
  "..#...#..",
  ".#.....#.",
  ".#.....#.",
  "#########",
];
const SAND = [
  ".........",
  ".........",
  "..sssss..",
  "...sss...",
  "....s....",
  "....s....",
  ".........",
  "....s....",
  "...sss...",
  "..sssss..",
  ".........",
];

export default function Hourglass({ size = 16, className }: { size?: number; className?: string }) {
  const px: React.ReactElement[] = [];
  FRAME.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === "#") px.push(<rect key={`f${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />);
      else if (SAND[y][x] === "s") px.push(<rect key={`s${x}-${y}`} x={x} y={y} width={1} height={1} fill="#f2b84b" />);
    }),
  );
  return (
    <svg className={className} width={(size * 9) / 11} height={size} viewBox="0 0 9 11" shapeRendering="crispEdges" aria-hidden>
      {px}
    </svg>
  );
}
