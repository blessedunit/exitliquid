import { ROOMS, STATUS_LABEL, type Room } from "@/lib/roadmap";
import { SPRITES, spriteSrc } from "@/lib/skins";
import styles from "./EvacMap.module.css";

// A fire-evacuation floor plan used as a roadmap, drawn quietly: one frame, rooms split by
// 1px walls, the pixel font only for room names, one green route to the EXIT door.

const RECTS: Record<string, { x: number; y: number; w: number; h: number }> = {
  lobby: { x: 40, y: 40, w: 270, h: 210 },
  ticket: { x: 310, y: 40, w: 290, h: 210 },
  arcade: { x: 600, y: 40, w: 290, h: 210 },
  radar: { x: 40, y: 370, w: 270, h: 210 },
  stairs: { x: 310, y: 370, w: 290, h: 210 },
  hall: { x: 600, y: 370, w: 290, h: 210 },
  door: { x: 890, y: 40, w: 250, h: 540 },
};

const PIX = "var(--f-px)";
const UI = "var(--f-ui)";
const MONO = "var(--f-num)";

/** Greedy word wrap for SVG text (no auto-wrap in SVG). */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    if (cur && (cur + " " + w).length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

// Room bullet list: every line is 17 units, every item gets 6 extra, so wrapped items never crowd the next one.
function Items({ room, x, y, max }: { room: Room; x: number; y: number; max: number }) {
  const wrapped = room.items.map((it) => wrap(it, max));
  const tops = wrapped.map((_, i) => y + wrapped.slice(0, i).reduce((sum, l) => sum + l.length * 17 + 6, 0));
  return (
    <>
      {wrapped.map((lines, i) => (
        <text key={i} x={x} y={tops[i]} fontSize="13" fill="var(--t2)" fontFamily={UI}>
          {lines.map((l, j) => (
            <tspan key={j} x={x} dy={j === 0 ? 0 : 17}>
              {l}
            </tspan>
          ))}
        </text>
      ))}
    </>
  );
}

function RoomBlock({ room }: { room: Room }) {
  const r = RECTS[room.id];
  const done = room.status === "done";
  const here = room.status === "now";
  const door = room.id === "door";
  const x = r.x + 20;
  return (
    <g>
      <text x={x} y={r.y + 32} fontSize="12" fill="var(--t3)" fontFamily={MONO}>
        {room.code}
      </text>
      <text x={r.x + r.w - 20} y={r.y + 32} textAnchor="end" fontSize="12" fill={here ? "var(--t1)" : "var(--t3)"} fontFamily={UI}>
        {STATUS_LABEL[room.status]}
      </text>
      <text x={x} y={r.y + 62} fontSize="14" fontWeight="700" fill={done || here || door ? "var(--t1)" : "var(--t2)"} fontFamily={PIX} letterSpacing="1">
        {room.name.toUpperCase()}
      </text>
      <Items room={room} x={x} y={r.y + 92} max={door ? 28 : 32} />
    </g>
  );
}

export default function EvacMap() {
  const hood = SPRITES.hood;
  const d = RECTS.door;
  return (
    <figure className={styles.frame}>
      <svg viewBox="0 0 1180 620" className={styles.svg} role="img" aria-label="Roadmap drawn as an evacuation plan">
        {/* walls: 1px lines between rooms, the corridor in the middle */}
        <g stroke="var(--line-2)" strokeWidth="1" shapeRendering="crispEdges">
          <line x1="40" y1="250" x2="890" y2="250" />
          <line x1="40" y1="370" x2="890" y2="370" />
          <line x1="310" y1="40" x2="310" y2="250" />
          <line x1="600" y1="40" x2="600" y2="250" />
          <line x1="310" y1="370" x2="310" y2="580" />
          <line x1="600" y1="370" x2="600" y2="580" />
          <line x1="890" y1="40" x2="890" y2="580" />
        </g>
        {/* the route: one dashed line along the corridor to the door */}
        <g stroke="var(--exit)" strokeWidth="2" strokeDasharray="8 8" fill="none" opacity="0.8">
          <polyline points="175,250 175,310 942,310 942,446" />
          <polyline points="455,250 455,310" />
          <polyline points="745,250 745,310" />
          <polyline points="175,370 175,310" />
          <polyline points="455,370 455,310" />
          <polyline points="745,370 745,310" />
        </g>
        <text x="60" y="315" fontSize="12" fill="var(--t3)" fontFamily={UI}>
          corridor
        </text>
        {ROOMS.map((r) => (
          <RoomBlock key={r.id} room={r} />
        ))}
        {/* the door: the pixel EXIT sign and one trader waiting under it */}
        <g transform={`translate(${d.x + 20}, 450)`}>
          <rect x="0" y="0" width="64" height="24" fill="var(--exit-sign)" />
          <text x="32" y="17" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily={PIX} letterSpacing="1">
            EXIT
          </text>
        </g>
        <image
          href={spriteSrc("hood")}
          x={d.x + 110}
          y={580 - hood.h * 1.2}
          width={hood.w * 1.2}
          height={hood.h * 1.2}
          className={styles.px}
          preserveAspectRatio="none"
        />
      </svg>
      <figcaption className={styles.note}>
        <span className={styles.sw} aria-hidden="true" /> The route · Built, Building and Idea are honest states, not dates · In case of dump: walk, don&apos;t run.
      </figcaption>
    </figure>
  );
}
