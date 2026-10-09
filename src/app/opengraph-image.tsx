// Root card: "/" (and every page without its own card) is the Departures board.
// /exit keeps the $EXIT card (app/exit/opengraph-image.tsx).
// Static on purpose: no live data, so crawlers always get the card fast and it never shows stale numbers.
import { ImageResponse } from "next/og";
import { ogFonts, ogSprite, OgImg, OG, type OgSprite } from "@/lib/og";
import type { Skin } from "@/lib/skins";

export const alt = "Exit Liquidity: the live departures board for vibe/vibe. Every token is a line of holders walking to the same door.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// three illustrative lines (no token names: the card must never read as a live quote)
const ROWS: { skins: Skin[]; pct: number; tag: string }[] = [
  { skins: ["plain", "hood", "bag", "getaway", "suit", "hood", "plain", "bag", "getaway"], pct: 86, tag: "NEAR THE DOOR" },
  { skins: ["hood", "plain", "bag", "plain", "getaway"], pct: 48, tag: "HOT" },
  { skins: ["plain", "bag"], pct: 9, tag: "NEW" },
];
const LANE = 660; // corridor width per row, px
const DOOR = 34;
const STEP = 30; // horizontal step between people, px

export default async function Image() {
  const uniq = Array.from(new Set(ROWS.flatMap((r) => r.skins)));
  const [fonts, list] = await Promise.all([ogFonts(), Promise.all(uniq.map((s) => ogSprite(s, 2, "right")))]);
  // draw the 2x files at 1x so three rows fit under the title
  const sprite: Record<string, OgSprite> = Object.fromEntries(uniq.map((s, i) => [s, { ...list[i], w: list[i].w / 2, h: list[i].h / 2 }]));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: OG.bg, fontFamily: "Body", color: OG.text }}>
        <div style={{ display: "flex", height: 10, background: `repeating-linear-gradient(-45deg, ${OG.exit} 0 18px, ${OG.bg} 18px 36px)` }} />
        <div style={{ display: "flex", flexDirection: "column", padding: "34px 64px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <div style={{ display: "flex", background: OG.sign, border: `5px solid ${OG.text}`, padding: "4px 16px", fontFamily: "Pixel", fontSize: 28, color: "#fff", letterSpacing: 4 }}>
              EXIT
            </div>
            <div style={{ fontFamily: "Pixel", fontSize: 20, color: OG.exit, letterSpacing: 3 }}>THE LIVE BOARD FOR VIBE/VIBE</div>
          </div>
          <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 60, marginTop: 20, letterSpacing: 2 }}>DEPARTURES</div>
          <div style={{ display: "flex", fontSize: 27, color: OG.muted, marginTop: 4 }}>Every token is a line of real holders walking to the same door.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "18px 64px 0" }}>
          {ROWS.map((r, i) => {
            // the front of the line stands at pct of the corridor, the rest queue behind it
            const front = Math.round((LANE - DOOR - 50) * (r.pct / 100)) + 10;
            const left = Math.max(0, front - (r.skins.length - 1) * STEP);
            const hot = r.pct >= 80;
            return (
              <div key={i} style={{ display: "flex", alignItems: "flex-end", borderBottom: `2px solid ${OG.hair}`, paddingTop: 8 }}>
                <div style={{ display: "flex", width: 260, fontFamily: "Pixel", fontSize: 18, color: hot ? OG.exit : OG.faint, letterSpacing: 2, paddingBottom: 12 }}>{r.tag}</div>
                <div style={{ display: "flex", position: "relative", width: LANE, height: 88 }}>
                  {r.skins.map((s, k) => (
                    <div key={k} style={{ display: "flex", position: "absolute", left: left + k * STEP, bottom: 0 }}>
                      <OgImg s={sprite[s]} />
                    </div>
                  ))}
                  <div style={{ display: "flex", position: "absolute", right: 0, bottom: 0, width: DOOR, height: 70, border: `5px solid ${OG.text}`, borderBottom: "none", background: hot ? "rgba(61,220,132,.45)" : OG.bg2 }} />
                </div>
                <div style={{ display: "flex", width: 150, justifyContent: "flex-end", fontFamily: "Body", fontWeight: 700, fontSize: 34, color: hot ? OG.exit : OG.text, paddingBottom: 8 }}>{r.pct}%</div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", marginTop: "auto", height: 30, background: OG.bg2 }} />
      </div>
    ),
    { ...size, fonts },
  );
}
