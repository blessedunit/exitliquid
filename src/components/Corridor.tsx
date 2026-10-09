"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import styles from "./Corridor.module.css";
import type { WireEntry } from "@/lib/types";
import { short } from "@/lib/queue";
import { SPRITES, spriteSrc, type Skin } from "@/lib/skins";

type Props = {
  line: WireEntry[];
  inLine: number;
  progressBps: number;
  maxShown?: number;
  highlight?: string; // wallet to highlight
  selected?: string; // wallet currently open in the inline ticket
  onSelect?: (entry: WireEntry) => void;
  showWallets?: boolean;
  event?: { key: string; kind: "buy" | "sell" | "exit"; wallet: string };
  height?: number;
  ghosts?: number; // > 0: draw a ghost walking away beyond the door
  compact?: boolean;
  showRest?: boolean;
  scene?: "door" | "passage" | "arrival";
  /** "loading" / "unknown": we don't know the line, so never draw it as empty (unknown ≠ zero). */
  status?: "ok" | "loading" | "unknown";
  /** the small "DOOR N% OPEN" caption under the door (off when the page shows a door meter) */
  doorLabel?: boolean;
  /** visible width in SVG units (340 units = the box height). Set it and the corridor is drawn
   *  edge to edge, extending left of the door, instead of a fixed 1200-unit picture. */
  span?: number;
};

function subscribe(cb: () => void) {
  const m = window.matchMedia("(max-width: 700px)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const isNarrow = () => window.matchMedia("(max-width: 700px)").matches;

const PX = 1.8; // SVG units per sprite pixel

// geometry shared by the drawing and corridorFit (door on the right of a 1200 x 340 view)
const VIEW_W = 1200;
const VIEW_H = 340;
const DOOR_X = 1010;
const FRONT = DOOR_X - 52; // center of place #1
const MIN_SPAN = 400;
function geometry(narrow: boolean, compact: boolean, span?: number) {
  const viewX = span ? VIEW_W - Math.max(MIN_SPAN, span) : narrow ? 600 : 0;
  // phones: traders a bit smaller and one full body-width apart, so nobody overlaps (desktop unchanged)
  const px = narrow ? 1.95 : 2.1;
  // desktop edge-to-edge (span): keep only the room the on-scene "further back" arrow needs;
  // phones put that arrow in the wall band above the heads, so nobody is pushed out
  const leftLimit = viewX + (narrow ? 58 : span ? 136 : 172);
  const step = narrow ? Math.round(47 * px + 8) : Math.round((compact ? 68 : 80) * (px / 2.1));
  return { viewX, px, leftLimit, step };
}

/** How many people (not counting the Dev beside the door) fit in a corridor of this span. */
export function corridorFit(span: number | undefined, narrow: boolean, compact = false) {
  const { leftLimit, step } = geometry(narrow, compact, span);
  return Math.max(1, Math.floor((FRONT - leftLimit) / step) + 1);
}

// One trader as an SVG <image>, feet on the floor, always facing the door (right).
function Trader({ skin, cx, floor, opacity = 1, px = PX, face }: { skin: Skin; cx: number; floor: number; opacity?: number; px?: number; face?: "left" | "right" }) {
  const s = SPRITES[skin];
  const w = s.w * px;
  const h = s.h * px;
  const flip = face ? face !== s.faces : s.faces === "left";
  return (
    <g transform={flip ? `translate(${cx * 2}, 0) scale(-1, 1)` : undefined} opacity={opacity}>
      <image href={spriteSrc(skin)} x={cx - w / 2} y={floor - h} width={w} height={h} className={styles.img} preserveAspectRatio="none" />
    </g>
  );
}

// A corridor: traders stand in line toward the EXIT door. Place #1 stands at the door.
export default function Corridor({
  line,
  inLine,
  progressBps,
  maxShown = 22,
  highlight,
  selected,
  onSelect,
  showWallets = false,
  event,
  height = 300,
  ghosts = 0, // ghost beyond the door is off for now
  compact = false,
  showRest = true,
  scene = "door",
  status = "ok",
  doorLabel = true,
  span,
}: Props) {
  const W = VIEW_W;
  const H = VIEW_H;
  const floor = 274;
  const doorX = DOOR_X;
  const doorW = 110;
  const doorH = 196;
  const narrow = useSyncExternalStore(subscribe, isNarrow, () => false);
  // easter egg: knock on the door seven times
  const [egg, setEgg] = useState(false);
  const knocks = useRef(0);
  const eggTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(eggTimer.current), []);
  const knock = () => {
    knocks.current += 1;
    if (knocks.current < 7) return;
    knocks.current = 0;
    setEgg(true);
    clearTimeout(eggTimer.current);
    eggTimer.current = setTimeout(() => setEgg(false), 4_000);
  };
  // on phones we zoom into the part of the corridor next to the door and draw the traders bigger;
  // with `span` the view reaches as far left as the box is wide (one drawing, no seam)
  const { viewX, px, leftLimit, step: baseStep } = geometry(narrow, compact, span);
  const front = FRONT;
  const viewW = W - viewX;
  // wall bays and lamps repeat every 382 units, so a wide view keeps the same rhythm to its left edge
  const bays: number[] = [];
  for (let x = 836; x > viewX - 300; x -= 382) bays.push(x);
  const lamps = bays.filter((x) => x < 836).map((x) => x + 321);
  const fitPeople = Math.max(1, Math.floor((front - leftLimit) / baseStep) + 1);
  const fit = fitPeople + (line[0]?.isCreator ? 1 : 0);
  const shown = line.slice(0, Math.min(maxShown, fit));
  // edge to edge: a full page spreads its people over the whole width (a few units more per step),
  // so no empty strip is left at the far end; a short page keeps the normal spacing near the door
  const people = shown.length - (shown[0]?.isCreator ? 1 : 0);
  const step = span && people === fitPeople && fitPeople > 1 ? (front - leftLimit) / (fitPeople - 1) : baseStep;
  // The Dev is the host, not a visual queue slot. On small screens, move the
  // last page just enough to keep its entrance visible beside the newest buyer.
  const newest = shown.at(-1);
  const newestHalfWidth = newest ? SPRITES[newest.skin].w * px / 2 : 0;
  const entranceWidth = 104;
  const entranceGap = 24;
  const entranceAtRest = front - Math.max(0, shown.length - 1) * step - newestHalfWidth - entranceWidth - entranceGap;
  const arrivalOffset = scene === "arrival" && narrow ? Math.max(0, viewX + 18 - entranceAtRest) : 0;
  const lineOffset = (shown[0]?.isCreator ? step : 0) + arrivalOffset;
  const entranceX = entranceAtRest + lineOffset;
  const selectedIndex = selected ? shown.findIndex((entry) => entry.wallet === selected) : -1;
  const open = Math.max(0, Math.min(1, progressBps / 10000));
  const leafW = Math.round(doorW - 12 - (doorW - 30) * open); // door leaf shrinks as it opens
  const rest = Math.max(0, inLine - shown.length);
  const top = floor - doorH;
  const pct = (progressBps / 100).toFixed(1).replace(/\.0$/, "");

  return (
    <div className={styles.wrap} style={{ aspectRatio: `${viewW} / ${H}`, maxHeight: height }}>
      <svg viewBox={`${viewX} 0 ${viewW} ${H}`} preserveAspectRatio={span ? "xMaxYMax slice" : "xMaxYMax meet"} className={styles.svg} role="img" aria-label={`The line: ${inLine} people waiting for the door`}>
        <defs>
          <linearGradient id="corridorWall" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#13211b" />
            <stop offset="0.55" stopColor="#0b1712" />
            <stop offset="1" stopColor="#07100c" />
          </linearGradient>
          <linearGradient id="corridorFloor" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#102119" />
            <stop offset="1" stopColor="#050a07" />
          </linearGradient>
          <radialGradient id="corridorGlow">
            <stop offset="0" stopColor="#64d88c" stopOpacity="0.16" />
            <stop offset="1" stopColor="#64d88c" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* Club facade: broad recessed bays, two lamps, no grid or tiny floor marks. */}
        <rect x={viewX} y="0" width={viewW} height={floor} fill="url(#corridorWall)" />
        <rect x={viewX} y="0" width={viewW} height="54" fill="#101c17" />
        <rect x={viewX} y="54" width={viewW} height="7" fill="#1a3022" />
        {bays.map((x) => (
          <g key={x} opacity="0.75">
            <rect x={x} y="80" width="294" height="137" fill="#07110d" />
            <rect x={x} y="80" width="294" height="5" fill="#203b2a" />
            <rect x={x + 286} y="85" width="8" height="132" fill="#0a1710" />
          </g>
        ))}
        {lamps.map((x) => (
          <g key={x} aria-hidden="true">
            <ellipse cx={x} cy="125" rx="122" ry="94" fill="url(#corridorGlow)" />
            <rect x={x - 19} y="84" width="38" height="13" fill="#233a29" />
            <rect x={x - 9} y="97" width="18" height="5" fill="#65c987" />
          </g>
        ))}
        <rect x={viewX} y="220" width={viewW} height={floor - 220} fill="#09140e" opacity="0.8" />
        <rect x={viewX} y="220" width={viewW} height="5" fill="#263d2c" />
        <rect x={viewX} y={floor} width={viewW} height={H - floor} fill="url(#corridorFloor)" />
        <rect x={viewX} y={floor} width={viewW} height="4" fill="#4ccc7a" />
        <rect x={viewX} y={floor + 4} width={viewW} height="12" fill="#183b25" opacity="0.58" />
        {scene === "door" && <>
        <ellipse cx={doorX + 10} cy={floor - 106} rx={190} ry={180} fill="url(#corridorGlow)" opacity={0.7 + open * 0.3} />
        <g onClick={knock}>
          <rect x={doorX - 6} y={top - 6} width={doorW + 12} height={doorH + 6} fill="var(--text)" />
          <rect x={doorX} y={top} width={doorW} height={doorH} fill="#06100a" />
          <rect x={doorX + 6} y={top + 6} width={doorW - 12} height={doorH - 6} fill="var(--exit)" opacity={0.18 + open * 0.55} />
          <rect x={doorX + 6} y={top + 6} width={leafW} height={doorH - 6} fill="#12301f" />
          <rect x={doorX + 6 + leafW - 4} y={top + 6} width={4} height={doorH - 6} fill="#0b1f14" />
          <rect x={doorX + leafW - 12} y={floor - doorH * 0.48} width={8} height={8} fill="var(--text)" />
          {/* EXIT sign */}
          <rect x={doorX - 14} y={top - 58} width={doorW + 28} height={40} fill="var(--text)" />
          <rect x={doorX - 10} y={top - 54} width={doorW + 20} height={32} fill="var(--exit-sign)" />
          <text x={doorX + doorW / 2} y={top - 30} textAnchor="middle" fontSize="22" fill="#fff" fontFamily="var(--font-pixel)" fontWeight="700" letterSpacing="3">
            EXIT
          </text>
        </g>
        {doorLabel && <text x={doorX + doorW / 2} y={floor + (narrow ? 44 : 39)} textAnchor="middle" fontSize={narrow ? 18 : 14} fill="var(--muted)" fontFamily="var(--font-mono)" letterSpacing="1">
          {status !== "ok" ? (narrow ? "?% OPEN" : "DOOR ?% OPEN") : narrow ? `${pct}% OPEN` : `DOOR ${pct}% OPEN`}
        </text>}
        </>}
        {scene === "passage" && <g aria-hidden="true">
          <rect x={viewX + (W - viewX) / 2 - 106} y="44" width="212" height="41" fill="#0d1b14" stroke="#25402e" strokeWidth="2" />
          <text x={viewX + (W - viewX) / 2} y="70" textAnchor="middle" fontSize="16" fill="#8aac98" fontFamily="var(--font-mono)" fontWeight="700" letterSpacing="3">STILL IN LINE</text>
        </g>}
        {scene === "arrival" && <g aria-hidden="true" transform={`translate(${entranceX - 41} 0)`}>
          <rect x="41" y={floor - 155} width="104" height="155" fill="#11251a" stroke="#41614a" strokeWidth="5" />
          <rect x="51" y={floor - 145} width="84" height="145" fill="#07100c" />
          <rect x="34" y={floor - 190} width="118" height="27" fill="#193925" stroke="#41614a" strokeWidth="3" />
          <text x="93" y={floor - 171} textAnchor="middle" fontSize="13" fill="var(--exit)" fontFamily="var(--font-mono)" fontWeight="800">FOMO IN</text>
          <text x="93" y={floor - 99} textAnchor="middle" fontSize="17" fill="#83b892" fontFamily="var(--font-mono)" fontWeight="800">BUY?</text>
          <text x="93" y={floor - 49} textAnchor="middle" fontSize="37" fill="var(--exit)" fontFamily="var(--font-mono)" fontWeight="800">→</text>
        </g>}

        {/* ghosts that already left */}
        {scene === "door" && ghosts > 0 && (
          <g className={styles.ghost}>
            <Trader skin="ghost" cx={doorX + doorW + 36} floor={floor - 8} opacity={0.55} px={1.2} />
          </g>
        )}

        {scene === "door" && event?.kind === "exit" && (
          <g key={event.key} className={styles.exitEvent}>
            <Trader skin="ghost" cx={doorX + 52} floor={floor - 8} opacity={0.7} px={1.25} />
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <rect key={n} x={doorX + 18 - n * 8} y={floor - 72 + (n % 3) * 9} width="5" height="5" fill="var(--exit)" className={styles.pointBit} style={{ animationDelay: `${n * 0.08}s` }} />
            ))}
          </g>
        )}

        {selectedIndex >= 0 && selectedIndex < shown.length - 1 && (
          <g className={styles.liquidityMark}>
            <path
              d={`M${front - (shown.length - 1) * step + lineOffset - 24} 34v-8H${front - (selectedIndex + 1) * step + lineOffset + 24}v8`}
              fill="none"
              stroke="var(--exit)"
              strokeWidth="2"
            />
            <text
              x={(front - (shown.length - 1) * step + lineOffset - 24 + front - (selectedIndex + 1) * step + lineOffset + 24) / 2}
              y="23"
              textAnchor="middle"
              fontSize="16"
              fill="var(--exit)"
              fontFamily="var(--font-pixel)"
              letterSpacing="1"
            >
              {highlight && shown[selectedIndex].wallet === highlight ? "YOUR " : ""}EXIT LIQUIDITY · {shown[selectedIndex].behind}
            </text>
          </g>
        )}

        {/* the line, drawn back to front so the ones nearer the door overlap the ones behind */}
        {shown.map((e, i) => ({ e, i })).reverse().map(({ e, i }) => {
          // Let the host rest against the corridor's outer right frame, not the EXIT door.
          // the dev leans on the corridor's right wall, just past the door
          const cx = e.isCreator ? W - (SPRITES.doorghost.w * (px * (SPRITES.suit.h / SPRITES.doorghost.h))) / 2 - 2 : front - i * step + lineOffset;
          const hl = !!highlight && e.wallet === highlight;
          const picked = !!selected && e.wallet === selected;
          const behindPicked = selectedIndex >= 0 && i > selectedIndex;
          const aheadPicked = selectedIndex >= 0 && i < selectedIndex;
          const eventClass = event?.wallet === e.wallet ? (event.kind === "buy" ? styles.entering : event.kind === "sell" ? styles.selling : "") : "";
          // the dev ghost is drawn at the height of everyone else (its art is taller, so scale it down)
          const artPx = e.isCreator ? px * (SPRITES.suit.h / SPRITES.doorghost.h) : px;
          const artSkin: Skin = e.isCreator ? "doorghost" : e.skin;
          const h = SPRITES[artSkin].h * artPx;
          const label = `${e.wallet.slice(0, 5)}…${e.wallet.slice(-3)}`;
          const labelY = floor - h - 34;
          const showLabel = !e.isCreator && !hl && showWallets;
          const trader = (
            <g
              className={`${styles.person} ${picked ? styles.selected : ""} ${behindPicked ? styles.behind : ""} ${aheadPicked ? styles.ahead : ""} ${e.isCreator ? styles.dev : ""} ${eventClass}`}
              style={{ animationDelay: `${(i % 5) * 0.17}s` }}
            >
                <title>{`#${e.place} · ${short(e.wallet)} · ${e.lp} pts`}</title>
                <Trader skin={artSkin} cx={cx} floor={floor} px={artPx} face={e.isCreator ? "left" : "right"} />
                {showLabel && (
                  <g className={styles.walletLabel}>
                    <path d={`M${cx} ${labelY + 21}V${floor - h - 5}`} stroke="var(--exit)" strokeWidth="2" opacity="0.7" />
                    <rect x={cx - 39} y={labelY} width="78" height="21" fill="#050a07" stroke={picked ? "var(--amber)" : "#41614a"} strokeWidth="2" />
                    <text x={cx} y={labelY + 15} textAnchor="middle" fontSize="11" fill={picked ? "var(--amber)" : "var(--text)"} fontFamily="var(--font-mono)" fontWeight="700">{label}</text>
                  </g>
                )}
                {e.isCreator && (
                  <g className={styles.devTag}>
                    <rect x={W - 123} y={floor - h - 37} width="110" height="25" fill="#07100c" stroke="var(--exit)" strokeWidth="2" />
                    <text x={W - 68} y={floor - h - 19} textAnchor="middle" fontSize="15" fill="var(--text)" fontFamily="var(--font-mono)" fontWeight="800" letterSpacing="1">{hl ? "YOU · DEV" : "THE DEV"}</text>
                  </g>
                )}
                {hl && !e.isCreator && (
                  <>
                    <rect x={cx - 37} y={floor - h - 42} width="74" height="25" fill="var(--exit)" stroke="#07100c" strokeWidth="2" />
                    <text x={cx} y={floor - h - 24} textAnchor="middle" fontSize="16" fill="#06120a" fontFamily="var(--font-mono)" fontWeight="900" letterSpacing="2">YOU</text>
                    <path d={`M${cx - 7} ${floor - h - 17}h14l-7 9z`} fill="var(--exit)" />
                  </>
                )}
            </g>
          );
          return onSelect ? (
            <g
              key={e.wallet}
              className={styles.personButton}
              role="button"
              tabIndex={0}
              aria-label={`Open ticket for #${e.place} ${e.wallet}`}
              onClick={() => onSelect(e)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(e);
                }
              }}
            >
              {trader}
            </g>
          ) : (
            <Link key={e.wallet} href={`/t/${e.wallet}`} aria-label={`#${e.place} ${e.wallet}`} prefetch={false}>
              {trader}
            </Link>
          );
        })}
        {showRest && rest > 0 && (
          <text x={viewX + 16} y={narrow ? 44 : floor - 64} fontSize={narrow ? 22 : 14} fill="var(--muted)" fontFamily="var(--font-pixel)">
            {"<"} +{rest.toLocaleString("en-US")} MORE
            <tspan x={viewX + 16} dy={narrow ? 28 : 20}>
              DOWN THE BLOCK
            </tspan>
          </text>
        )}
        {/* unknown: an empty door, no text (the page shows one "Reconnecting" plate) */}
        {(inLine === 0 || status === "loading") && status !== "unknown" && shown.length === 0 && (
          <text
            x={doorX - 60}
            y={floor - 70}
            textAnchor="end"
            fontSize={narrow ? 22 : 20}
            fill="var(--muted)"
            fontFamily="var(--font-pixel)"
            fontWeight="700"
          >
            {status === "loading" ? "READING THE CHAIN..." : narrow ? "EMPTY. FOR NOW." : "THE LINE IS EMPTY. FOR NOW."}
          </text>
        )}
      </svg>
      {egg && (
        <div className={styles.egg} role="status">
          <span>Nothing is outside. That&apos;s the joke.</span>
          <Link href="/manifesto">read the manifesto</Link>
        </div>
      )}
    </div>
  );
}
