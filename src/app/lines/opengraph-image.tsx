import { ImageResponse } from "next/og";
import { ogFonts, ogSprite, OgImg, OG } from "@/lib/og";

export const alt = "My Lines — find your wallet in every line";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const [fonts, a, b, c] = await Promise.all([ogFonts(), ogSprite("plain", 2), ogSprite("hood", 2), ogSprite("bag", 2)]);
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", background: OG.bg, color: OG.text, padding: 48, fontFamily: "Body" }}>
      <div style={{ width: "100%", display: "flex", flexDirection: "column", border: `6px solid ${OG.hair}`, background: OG.ink, padding: "38px 46px", boxShadow: "14px 14px 0 #000" }}>
        <div style={{ display: "flex", color: OG.exit, fontFamily: "Pixel", fontSize: 18, letterSpacing: 5 }}>EXIT LIQUIDITY · WALLET TRACKER</div>
        <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 78, letterSpacing: 6, marginTop: 34 }}>MY LINES</div>
        <div style={{ display: "flex", fontSize: 28, color: OG.muted, marginTop: 18 }}>One wallet. Every vibe/vibe line. Your exact place.</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 28, flex: 1, borderBottom: `6px solid ${OG.exit}`, paddingLeft: 80 }}>
          <OgImg s={a} /><OgImg s={b} /><OgImg s={c} />
          <div style={{ display: "flex", marginLeft: "auto", color: OG.exit, fontFamily: "Pixel", fontSize: 22, paddingBottom: 36, letterSpacing: 3 }}>FIND ME →</div>
        </div>
      </div>
    </div>,
    { ...size, fonts },
  );
}
