import type { Metadata } from "next";
import PageHead from "@/components/PageHead";
import Sprite from "@/components/Sprite";
import { SPRITES, spriteSrc, type Skin } from "@/lib/skins";
import k from "../_kit/kit.module.css";
import styles from "./kit.module.css";

export const metadata: Metadata = {
  alternates: { canonical: "/kit" },
  title: "Press kit",
  description: "The 8-bit $EXIT cast as downloadable sprites, colors, type and usage rules.",
};

const CAST: [Skin, string][] = [
  ["plain", "Rank 1"],
  ["hood", "Rank 2"],
  ["bag", "Rank 3"],
  ["getaway", "Rank 4"],
  ["suit", "Rank 5"],
  ["doorghost", "Place #1"],
  ["ghost", "Exited"],
];

const COLORS = [
  ["Exit green", "#3DDC84"],
  ["Sign plate", "#08803E"],
  ["Risk red", "#F0616D"],
  ["Page", "#0A0C0B"],
  ["Surface", "#0F1211"],
  ["Text", "#E9EDE9"],
];

export default function Kit() {
  return (
    <section>
      <div className="wrap">
        <PageHead title="Use the cast">
          The traders are yours. Scale by whole numbers. No real-company logos.
        </PageHead>

        <div className={k.secHead} style={{ marginBottom: 24 }}>
          <h2 className={k.h2}>The cast</h2>
          <p className={k.lead}>Transparent PNG. 1× is true size; 4× and 8× are ready for posts.</p>
        </div>
        <div className={styles.cast}>
          {CAST.map(([s, tag]) => {
            const sp = SPRITES[s];
            return (
              <div key={s} className={styles.slot}>
                <span className={styles.tag}>{tag}</span>
                <div className={styles.stage}>
                  <Sprite skin={s} scale={s === "doorghost" ? 1.4 : 2} alt={sp.name} />
                </div>
                <h3 className={k.h3}>{sp.name}</h3>
                <div className={styles.blurb}>{sp.blurb}</div>
                <div className={styles.dl}>
                  <a href={spriteSrc(s, 1)} download={`exit_${s}_1x.png`}>1×</a>
                  <a href={spriteSrc(s, 4)} download={`exit_${s}_4x.png`}>4×</a>
                  <a href={spriteSrc(s, 8)} download={`exit_${s}_8x.png`}>8×</a>
                </div>
                <div className={`${k.num} ${styles.size}`}>
                  {sp.w}×{sp.h} px
                </div>
              </div>
            );
          })}
        </div>
        <p className={styles.note}>
          The Ghost is ~55% opacity on the site; the file is opaque.
        </p>

        <div className={k.secHead} style={{ marginTop: 64, paddingTop: 64, borderTop: "1px solid var(--line)", marginBottom: 24 }}>
          <h2 className={k.h2}>Palette</h2>
        </div>
        <div className={styles.colors}>
          {COLORS.map(([n, hex]) => (
            <div key={hex} className={styles.color}>
              <span className={styles.swatch} style={{ background: hex }} />
              <div>
                <div className={styles.cname}>{n}</div>
                <div className={`${k.num} ${k.dim}`} style={{ fontSize: 13 }}>{hex}</div>
              </div>
            </div>
          ))}
        </div>
        <p className={styles.note}>
          Type: <b>Space Grotesk</b> for text, <b>Departure Mono</b> for numbers, <b>Silkscreen</b> only for the wordmark and the EXIT sign. All free (OFL).
        </p>
      </div>
    </section>
  );
}
