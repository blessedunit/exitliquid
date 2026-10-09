// State of vibe share card: the week's numbers when a snapshot exists (memory or Redis), a plain card otherwise.
// Never starts a build: the card must render in well under a second.
import { ImageResponse } from "next/og";
import { ogFonts, OG } from "@/lib/og";
import { peekState } from "@/lib/state";

export const alt = "State of vibe: independent vibe/vibe launchpad stats from the chain.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 1800;

function dur(sec: number): string {
  // words, not "21.9d": in the pixel face a D reads as a 0
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} MIN`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} H`;
  return `${Math.round(sec / 86_400)} DAYS`;
}
const int = (n: number) => n.toLocaleString("en-US");

export default async function Image() {
  const [fonts, snap] = await Promise.all([ogFonts(), peekState().catch(() => null)]);
  const days = snap?.days ?? null;
  const vals = days ? days.map((d) => (d.launches ? d.launches.curve + d.launches.taxed : null)) : null;
  const max = vals ? Math.max(1, ...vals.map((v) => v ?? 0)) : 1;
  const stats: [string, string][] = snap
    ? [
        ["LAUNCHES 7D", snap.totals.launches7d === null ? "—" : int(snap.totals.launches7d)],
        ["GRADUATIONS 7D", snap.totals.grads7d === null ? "—" : int(snap.totals.grads7d)],
        ["MEDIAN TO GRAD", snap.ttg ? dur(snap.ttg.medianS) : "—"],
      ]
    : [];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: OG.bg, fontFamily: "Body", color: OG.text }}>
        <div style={{ display: "flex", height: 10, background: `repeating-linear-gradient(-45deg, ${OG.exit} 0 18px, ${OG.bg} 18px 36px)` }} />
        <div style={{ display: "flex", flexDirection: "column", padding: "48px 64px 0", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <div style={{ display: "flex", background: OG.sign, border: `5px solid ${OG.text}`, padding: "6px 16px", fontFamily: "Pixel", fontSize: 28, color: "#fff", letterSpacing: 4 }}>EXIT</div>
            <div style={{ fontFamily: "Pixel", fontSize: 20, color: OG.exit, letterSpacing: 3 }}>DEPARTURES BOARD · VIBE/VIBE</div>
          </div>
          <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 76, marginTop: 30, letterSpacing: 2 }}>STATE OF VIBE</div>
          <div style={{ display: "flex", fontSize: 28, color: OG.muted, marginTop: 8 }}>Launches, graduations, snipers, devs. Read from the chain.</div>
          {snap ? (
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: "auto", paddingBottom: 44 }}>
              <div style={{ display: "flex", gap: 44 }}>
                {stats.map(([k, v]) => (
                  <div key={k} style={{ display: "flex", flexDirection: "column" }}>
                    <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 16, color: OG.faint, letterSpacing: 2 }}>{k}</div>
                    <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 52, color: k.startsWith("GRAD") ? OG.exit : OG.text, marginTop: 6 }}>{v}</div>
                  </div>
                ))}
              </div>
              {vals && (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 130 }}>
                  {vals.map((v, i) => (
                    <div key={i} style={{ display: "flex", width: 26, height: v === null ? 4 : Math.max(4, Math.round((v / max) * 130)), background: v === null ? OG.hair : OG.exit, opacity: i === vals.length - 1 ? 0.55 : 1 }} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", marginTop: "auto", paddingBottom: 44, fontFamily: "Pixel", fontSize: 22, color: OG.faint, letterSpacing: 2 }}>EXITLIQUID.FUN/STATE</div>
          )}
        </div>
        <div style={{ display: "flex", height: 8, background: OG.exit }} />
      </div>
    ),
    { ...size, fonts },
  );
}
