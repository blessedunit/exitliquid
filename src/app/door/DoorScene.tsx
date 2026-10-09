// One pixel door per card: a short corridor, the EXIT door on the right (its glass fills with the last
// 15 % of the curve), and a few people from the line standing as close to it as the curve is filled.
// Walking lines bob, stalled lines stand still and fade, a line at the door has the door lit open.
// Plain markup + the real sprites; no hooks, so it renders on the server too.
import Sprite from "@/components/Sprite";
import { crowdSize } from "@/components/MiniLine";
import type { Skin } from "@/lib/skins";
import type { Phase } from "./types";
import styles from "./door.module.css";

const CAST: Skin[] = ["plain", "hood", "bag", "getaway", "suit"];

function seedOf(s: string): number {
  let h = 0;
  for (let i = 2; i < Math.min(s.length, 14); i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 0..1 inside the 85-100 % window */
export const doorFrac = (bps: number) => Math.max(0, Math.min(1, (bps - 8_500) / 1_500));

export default function DoorScene({ token, bps, holders, phase }: { token: string; bps: number; holders: number | null; phase: Phase }) {
  const f = phase === "door" ? 1 : doorFrac(bps);
  const n = holders === null ? 1 : Math.min(5, crowdSize(holders));
  const h = seedOf(token);
  const people = Array.from({ length: n }, (_, i) => CAST[(h + i * 3 + (i >> 1)) % CAST.length]);
  // the front of the line: a quarter of the way in at 85 %, at the door at 100 %
  const front = 0.25 + 0.75 * f;
  const cls = [styles.scene, phase === "stalled" ? styles.isStalled : "", phase === "door" ? styles.isOpen : "", phase === "walking" ? styles.isWalking : ""].join(" ");
  return (
    <div className={cls} aria-hidden>
      <div className={styles.track}>
        <div className={styles.crowd} style={{ right: `${(1 - front) * 100}%` }}>
          {people.map((s, i) => (
            <span key={i} className={styles.person} style={{ animationDelay: `${(i % 3) * 0.23}s`, zIndex: 10 - i }}>
              <Sprite skin={s} scale={1} face="right" style={holders === null ? { opacity: 0.35 } : undefined} />
            </span>
          ))}
          {phase === "stalled" && <span className={styles.zz}>zz</span>}
        </div>
      </div>
      <div className={styles.door}>
        <span className={styles.plate}>EXIT</span>
        <span className={styles.glass}>
          <span className={styles.fill} style={{ height: `${Math.round(f * 100)}%` }} />
        </span>
        <span className={styles.knob} />
      </div>
      <span className={styles.floor} />
    </div>
  );
}
