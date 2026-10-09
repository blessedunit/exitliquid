// Mini line: a sparkline-sized pixel corridor for one board row. Tiny 4x9 pixel people drawn on a 2x grid
// (8x18 px), in the palettes of the real sprites (The Suit's grey hair, the Crypto Bro's ginger + gold chain,
// the Chart Guy's brown hair + white tee, Retail's cap), walk toward a door with a pixel EXIT plate that fills
// bottom-up with door %. The crowd stands as far along as the curve is filled; the first in line gets a
// green step under the feet. Empty and brand-new lines are drawn on purpose, not as "nothing":
//   0 holders   an outlined spot at the start and "no buyers yet"
//   1 holder    the lone first trader, with a small "1st in line"
//   unknown     floor and door only (unknown is never drawn as empty)
//   < 30 min    a tiny NEW spark by the door
// One <svg>, no images, crisp pixels. The track stretches with the column, the people never scale:
// positions mix % (along the track) with px offsets via nested <svg x="…%">. Idle bob is CSS only
// and off under prefers-reduced-motion.
import styles from "./MiniLine.module.css";

const H = 26; // svg height
const FLOOR = 24; // feet stand on y = 24, floor hairline below
const PX = 2; // css px per art pixel
const FIG_W = 4 * PX; // 8 px
const FIG_H = 9 * PX; // 18 px
const DOOR_W = 15;
const DOOR_GAP = 5; // space between the first in line and the door
const FRESH_S = 30 * 60;

/** People drawn for a line: exact up to 3 (a lone buyer is one person), then about one per doubling, 12 at most. */
export function crowdSize(holders: number | null): number {
  if (holders === null || holders <= 0) return 0;
  if (holders <= 3) return holders;
  return Math.max(3, Math.min(12, Math.round(3 + 2 * Math.log2(holders / 3))));
}

type Look = { hair: string; skin: string; body: string; legs: string; shoes: string; accent?: string; cap?: boolean; accentD?: string };
// palettes sampled from /public/sprites (suit, getaway, bag, hood)
const LOOKS: Look[] = [
  { hair: "#b3aba6", skin: "#f2b584", body: "#3a3743", legs: "#2a2733", shoes: "#0e0c12", accent: "#e9ede9", accentD: "M2 3h1v1h-1z" }, // The Suit: grey hair, white collar
  { hair: "#d9793a", skin: "#fdc88f", body: "#4f3f45", legs: "#281c25", shoes: "#0e0c12", accent: "#e8c66a", accentD: "M1 3h2v1h-2z" }, // Crypto Bro: ginger, gold chain
  { hair: "#3d4f96", skin: "#fdeed4", body: "#a8473a", legs: "#3b4a7e", shoes: "#1b1b2e", cap: true }, // Retail: cap, jeans
  { hair: "#7a3a2a", skin: "#f0b17d", body: "#e3d3c1", legs: "#38343f", shoes: "#0d0b1b", accent: "#38343f", accentD: "M0 1h1v1h-1z" }, // Chart Guy: brown hair, headset
];

// art-pixel paths (4 wide x 9 tall, facing right toward the door)
const HAIR = "M0 0h3v1h-3z M0 1h1v1h-1z";
const CAP = "M0 0h4v1h-4z M0 1h1v1h-1z"; // crown + brim pointing at the door
const SKIN = "M1 1h3v1h-3z M1 2h2v1h-2z";
const BODY = "M0 3h4v3h-4z";
const LEGS = "M0 6h1v2h-1z M2 6h1v2h-1z";
const SHOES = "M0 8h1v1h-1z M2 8h2v1h-2z";

/** an art-pixel path moved to (x, y) and scaled by PX, as a plain path string */
function place(d: string, x: number, y: number): string {
  return d.replace(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g, (_, a, b, w, h, w2) => `M${x + Number(a) * PX} ${y + Number(b) * PX}h${Number(w) * PX}v${Number(h) * PX}h-${Number(w2) * PX}z`);
}

/**
 * The whole crowd as a handful of paths: one per colour inside each bob group (still, bob, bob late),
 * instead of one <g> + 5-6 <path>s per person (a 48-row board drew ~2,900 SVG nodes for the crowds).
 * People never overlap (cell >= figure width), so merging same-colour shapes changes nothing on screen.
 */
function Crowd({ people }: { people: { x: number; look: Look }[] }) {
  const y = FLOOR - FIG_H;
  const groups = new Map<string, Map<string, string[]>>(); // group -> fill -> path parts
  people.forEach((q, i) => {
    const g = i % 2 !== 0 ? "still" : (i % 4) * 0.23 ? "late" : "bob";
    let m = groups.get(g);
    if (!m) groups.set(g, (m = new Map()));
    const add = (fill: string, d: string) => {
      const a = m!.get(fill);
      if (a) a.push(place(d, q.x, y));
      else m!.set(fill, [place(d, q.x, y)]);
    };
    const l = q.look;
    add(l.hair, l.cap ? CAP : HAIR);
    add(l.skin, SKIN);
    add(l.body, BODY);
    if (l.accent && l.accentD) add(l.accent, l.accentD);
    add(l.legs, LEGS);
    add(l.shoes, SHOES);
  });
  return (
    <>
      {[...groups].map(([g, m]) => (
        <g key={g} className={g === "still" ? undefined : styles.bob} style={g === "late" ? { animationDelay: "0.46s" } : undefined}>
          {[...m].map(([fill, ds]) => (
            <path key={fill} fill={fill} d={ds.join(" ")} />
          ))}
        </g>
      ))}
    </>
  );
}

// pixel EXIT, 3x3 letters, 13 x 3 px
const EXIT_PX = "M0 0h3v1h-3z M0 1h2v1h-2z M0 2h3v1h-3z M4 0h1v1h-1z M6 0h1v1h-1z M5 1h1v1h-1z M4 2h1v1h-1z M6 2h1v1h-1z M8 0h1v3h-1z M10 0h3v1h-3z M11 1h1v2h-1z";

/** small stable hash so each token keeps its own crowd */
function seedOf(s: string | undefined): number {
  if (!s) return 0;
  let h = 0;
  for (let i = 2; i < Math.min(s.length, 14); i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h;
}

type Props = {
  /** 0..100 */
  pct: number;
  holders: number | null;
  graduated?: boolean;
  className?: string;
  /** token address: picks this line's mix of people (same crowd on every refresh) */
  seed?: string;
  /** unix seconds; with `now` (ms) a line under 30 min old gets a NEW spark */
  createdAt?: number;
  now?: number | null;
};

export default function MiniLine({ pct, holders, graduated = false, className, seed, createdAt, now = null }: Props) {
  const p = Math.max(0, Math.min(100, graduated ? 100 : pct));
  const n = crowdSize(holders);
  const cell = n > 9 ? 10 : 11; // 8 px figure + 2-3 px gap
  const crowdW = n > 0 ? (n - 1) * cell + FIG_W : 0;
  const reserve = DOOR_W + DOOR_GAP; // px kept free for the door at 100 %
  const f = p / 100;
  // right edge of the first person = p % of the track, pulled back so the crowd never falls off the
  // left (at 0 %) and never walks into the door (at 100 %)
  const frontPx = Math.round((1 - f) * crowdW - f * reserve);
  const h = seedOf(seed);
  const people = Array.from({ length: n }, (_, i) => ({
    x: frontPx - FIG_W - i * cell,
    look: LOOKS[(h + i * 3 + (i >> 1)) % LOOKS.length],
  }));
  const fresh = !!createdAt && now !== null && now / 1000 - createdAt >= 0 && now / 1000 - createdAt < FRESH_S;
  const empty = holders === 0;
  const lone = n === 1;
  // door interior 13 x 16 (under the 15 x 5 plate), fill rises with door %
  const fillH = graduated ? 16 : Math.round((16 * p) / 100);
  const label = graduated
    ? "Graduated: the door is open"
    : `${p.toFixed(p < 10 ? 1 : 0)}% to the door${holders === null ? ", line size unknown" : holders === 0 ? ", nobody in line yet" : holders === 1 ? ", one person in line" : `, ${holders} in line`}${fresh ? ", launched under 30 minutes ago" : ""}`;

  return (
    <svg className={`${styles.ml} ${className ?? ""}`} width="100%" height={H} shapeRendering="crispEdges" role="img" aria-label={label}>
      {/* floor: a hairline, dotted where the corridor is still empty */}
      <rect className={styles.floor} x="0" y={FLOOR + 1} width="100%" height="1" />
      {empty && <line className={styles.floorEmpty} x1="0" x2="100%" y1={FLOOR} y2={FLOOR} />}

      {/* the crowd, drawn back to front */}
      <svg x={`${p}%`} y="0" width="1" height={H} overflow="visible">
        <Crowd people={people} />
        {n > 0 && <rect className={styles.step} x={people[0].x - 1} y={FLOOR} width={FIG_W + 2} height="1" />}
        {lone && (
          <text className={styles.note} x={p < 50 ? people[0].x + FIG_W + 5 : people[0].x - 5} y={FLOOR - 5} textAnchor={p < 50 ? "start" : "end"}>
            1st in line
          </text>
        )}
      </svg>
      {empty && (
        <>
          {/* an outlined spot where the first buyer will stand */}
          <rect className={styles.spot} x="2" y={FLOOR - FIG_H} width={FIG_W + 4} height={FIG_H} />
          <text className={styles.note} x={FIG_W + 12} y={FLOOR - 5}>no buyers yet</text>
        </>
      )}

      {/* the door, pinned to the right edge */}
      <svg x="100%" y="0" width="1" height={H} overflow="visible">
        <g transform={`translate(${-DOOR_W} 0)`}>
          {fresh && (
            <g className={styles.spark}>
              {/* just the word (a sparkle glued to it read as "NEW+") */}
              <text className={styles.newTxt} x={-4} y={6} textAnchor="end">NEW</text>
            </g>
          )}
          <rect className={styles.plate} x="0" y="0" width={DOOR_W} height="5" />
          <path className={styles.plateTxt} transform="translate(1 1)" d={EXIT_PX} />
          <path className={graduated ? styles.frameOpen : styles.frame} d="M0 6h15v1h-15z M0 7h1v17h-1z M14 7h1v17h-1z" />
          <rect className={styles.inside} x="1" y="7" width="13" height="17" />
          {fillH > 0 && <rect className={graduated ? styles.fillOpen : styles.fill} x="2" y={24 - fillH} width="11" height={fillH} />}
          {!graduated && <rect className={styles.knob} x="11" y="15" width="1" height="2" />}
          <rect className={graduated ? styles.frameOpen : styles.frame} x="-2" y={FLOOR + 1} width={DOOR_W + 4} height="1" />
        </g>
      </svg>
    </svg>
  );
}
