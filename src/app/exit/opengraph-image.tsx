// The $EXIT line keeps the $EXIT card; the root card (/) can move to Departures independently.
import { ImageResponse } from "next/og";
import { ogFonts, ogSprite, OgImg, OG } from "@/lib/og";
import type { Skin } from "@/lib/skins";

export const alt = "Exit Liquidity ($EXIT): every ponzi needs exit liquidity. We made it a leaderboard.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// left to right: the back of the line first, the dev at the door
const LINE: Skin[] = ["plain", "hood", "plain", "bag", "hood", "getaway", "plain", "bag", "hood", "suit", "getaway", "bag", "doorghost"];

export default async function Image() {
  const [fonts, sprites] = await Promise.all([ogFonts(), Promise.all(LINE.map((s) => ogSprite(s, 2, "right")))]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: OG.bg, fontFamily: "Body", color: OG.text }}>
        <div style={{ display: "flex", height: 10, background: `repeating-linear-gradient(-45deg, ${OG.exit} 0 18px, ${OG.bg} 18px 36px)` }} />
        <div style={{ display: "flex", flexDirection: "column", padding: "44px 64px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
            <div style={{ display: "flex", background: OG.sign, border: `5px solid ${OG.text}`, padding: "6px 18px", fontFamily: "Pixel", fontSize: 34, color: "#fff", letterSpacing: 4 }}>
              EXIT
            </div>
            <div style={{ fontFamily: "Pixel", fontSize: 20, color: OG.exit, letterSpacing: 3 }}>$EXIT · AN ON-CHAIN LINE TO THE DOOR</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontFamily: "Pixel", fontSize: 68, lineHeight: 1.15, marginTop: 34, letterSpacing: 2 }}>
            <span>EVERY PONZI NEEDS</span>
            <span style={{ color: OG.exit }}>EXIT LIQUIDITY.</span>
          </div>
          <div style={{ display: "flex", fontSize: 30, color: OG.muted, marginTop: 14 }}>We made it a leaderboard. Your place has a story.</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "flex-end", marginTop: "auto", padding: "0 64px", borderBottom: `8px solid ${OG.exit}` }}>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
          {sprites.map((s, i) => (
            <div key={i} style={{ display: "flex", marginRight: -14 }}>
              <OgImg s={s} />
            </div>
          ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginLeft: 30 }}>
            <div style={{ display: "flex", background: OG.sign, border: `4px solid ${OG.text}`, fontFamily: "Pixel", fontSize: 20, color: "#fff", padding: "2px 10px", marginBottom: 10 }}>
              EXIT
            </div>
            <div style={{ display: "flex", width: 96, height: 160, border: `8px solid ${OG.text}`, borderBottom: "none", background: "rgba(61,220,132,.35)" }} />
          </div>
        </div>
        <div style={{ display: "flex", height: 34, background: OG.bg2 }} />
      </div>
    ),
    { ...size, fonts },
  );
}
