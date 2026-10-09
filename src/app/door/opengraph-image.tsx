import { ImageResponse } from "next/og";
import { ogFonts, ogSprite, OgImg, OG } from "@/lib/og";
import { peekDoor } from "./data";
import { splitNear } from "./types";

export const alt = "Graduation watch — who is about to walk through the door on vibe/vibe";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

export default async function Image() {
  const [fonts, a, b, c] = await Promise.all([ogFonts(), ogSprite("suit", 2), ogSprite("getaway", 2), ogSprite("hood", 2)]);
  // live counts only when this server already has a snapshot (an OG fetch never starts a build)
  const s = peekDoor();
  const split = s?.near ? splitNear(s.near) : null;
  const walking = split ? split.go.filter((x) => x.phase !== "unknown").length : null;
  const grads = s?.grads ? s.grads.length : null;
  const stat = (label: string, v: number | null) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", fontSize: 18, color: OG.faint, letterSpacing: 3, fontFamily: "Pixel" }}>{label}</div>
      <div style={{ display: "flex", fontSize: 54, fontWeight: 700, color: OG.text }}>{v === null ? "—" : String(v)}</div>
    </div>
  );
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", background: OG.bg, color: OG.text, padding: 48, fontFamily: "Body" }}>
      <div style={{ width: "100%", display: "flex", flexDirection: "column", border: `6px solid ${OG.hair}`, background: OG.ink, padding: "38px 46px", boxShadow: "14px 14px 0 #000" }}>
        <div style={{ display: "flex", color: OG.exit, fontFamily: "Pixel", fontSize: 18, letterSpacing: 5 }}>EXIT LIQUIDITY · GRADUATION WATCH</div>
        <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 74, letterSpacing: 6, marginTop: 26 }}>AT THE DOOR</div>
        <div style={{ display: "flex", fontSize: 28, color: OG.muted, marginTop: 14 }}>85%+ to graduation, live pace, ETA range. Signals, not verdicts.</div>
        <div style={{ display: "flex", alignItems: "flex-end", flex: 1, borderBottom: `6px solid ${OG.exit}`, gap: 48 }}>
          <div style={{ display: "flex", gap: 48, paddingBottom: 26 }}>
            {stat("NEAR THE DOOR", walking)}
            {stat("GRADUATED 24H", grads)}
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", marginLeft: "auto", gap: 6 }}>
            <OgImg s={c} />
            <OgImg s={b} />
            <OgImg s={a} />
            {/* the door: frame, lit glass, EXIT plate */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginLeft: 18 }}>
              <div style={{ display: "flex", background: OG.sign, color: "#fff", fontFamily: "Pixel", fontSize: 18, padding: "6px 10px 4px", letterSpacing: 3 }}>EXIT</div>
              <div style={{ display: "flex", width: 104, height: 168, marginTop: 8, border: `8px solid ${OG.exit}`, borderBottom: "0", background: OG.exit, opacity: 0.85 }} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    { ...size, fonts },
  );
}
