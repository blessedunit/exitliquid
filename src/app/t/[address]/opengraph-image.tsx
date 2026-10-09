import { ImageResponse } from "next/og";
import { getTicket, isAddress } from "@/lib/ticket";
import { buildState } from "@/lib/service";
import { short } from "@/lib/queue";
import { ogFonts, ogSprite, OgImg, OG } from "@/lib/og";
import { headers } from "next/headers";
import { clientIp, LIMITS, rateLimit } from "@/lib/limits";

export const alt = "An $EXIT boarding pass";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  // the page 404s on a bad address, so there is nothing to draw (and no CPU to burn)
  if (!isAddress(address)) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  // each render is ~0.3-1.4 s of CPU plus a possible RPC call; the only user text on the card
  // is a validated, shortened address, everything else is fixed copy or numbers
  if (!(await rateLimit(LIMITS.og, clientIp(await headers())))) {
    return new Response(null, { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
  }
  const built = await buildState();
  const t: Awaited<ReturnType<typeof getTicket>> | null = await getTicket(address, built);
  // wallets not in line yet get the static site card: no render, cheap to spam (the redirect is cached briefly,
  // so a wallet that buys in shows its real pass within a minute)
  if (t?.status === "never") {
    return new Response(null, {
      status: 307,
      headers: { location: "/opengraph-image", "cache-control": "public, max-age=0, s-maxage=60", "vercel-cdn-cache-control": "max-age=60" },
    });
  }
  const e = t?.entry;
  const exited = t?.status === "exited";
  const [fonts, sprite] = await Promise.all([ogFonts(), ogSprite(e?.isCreator ? "doorghost" : e?.skin ?? (exited ? "ghost" : "plain"), e?.isCreator ? 2 : 3, "right")]);
  const place = e ? `#${e.place}` : exited ? `#${t!.exit!.exitedAtPlace}` : "—";
  const unknown = t?.status === "unknown" || !t;
  const headline = unknown ? "LINE UNAVAILABLE" : e ? "IN LINE" : exited ? "EXITED" : "NOT IN LINE YET";
  const sub = e
    ? `exit liquidity for ${e.ahead.toLocaleString("en-US")} ahead · ${e.behind.toLocaleString("en-US")} in line behind`
    : exited
      ? `${t!.exit!.behindAtExit.toLocaleString("en-US")} people moved up. thanks for the liquidity.`
      : "every ponzi needs exit liquidity";
  const rank = e ? (t?.tierName ?? "") : exited ? "Ghost" : "";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: OG.bg, padding: 36, fontFamily: "Body" }}>
        <div style={{ flex: 1, display: "flex", background: OG.ink, border: `8px solid ${OG.text}`, boxShadow: "14px 14px 0 #000" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "30px 38px", color: OG.text }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `4px solid ${OG.hair}`, paddingBottom: 16 }}>
              <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 18, letterSpacing: 2, whiteSpace: "nowrap" }}>
                EXIT LIQUIDITY · BOARDING PASS
              </div>
              <div style={{ display: "flex", flexShrink: 0, whiteSpace: "nowrap", fontFamily: "Pixel", fontSize: 13, background: OG.exit, color: "#04130a", padding: "6px 12px", border: "3px solid #000" }}>
                $EXIT
              </div>
            </div>
            <div style={{ display: "flex", gap: 44, marginTop: 22, fontFamily: "Pixel", fontSize: 15, color: OG.faint, letterSpacing: 2 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                PASSENGER
                <span style={{ fontFamily: "Body", fontWeight: 700, color: OG.text, fontSize: 30, letterSpacing: 0 }}>{isAddress(address) ? short(address.toLowerCase()) : "?"}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                GROUP
                <span style={{ fontFamily: "Body", fontWeight: 700, color: OG.text, fontSize: 27, letterSpacing: 0 }}>{e ? t!.group : exited ? "HALL OF EXITS" : "—"}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                RANK
                <span style={{ fontFamily: "Body", fontWeight: 700, color: OG.text, fontSize: 27, letterSpacing: 0 }}>{rank || "—"}</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 28, marginTop: 18 }}>
              <div style={{ fontFamily: "Body", fontWeight: 700, fontSize: 150, lineHeight: 1, letterSpacing: -9, color: exited ? OG.red : OG.exit }}>{place}</div>
              <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 34, paddingBottom: 22 }}>{headline}</div>
            </div>
            <div style={{ display: "flex", fontSize: 28, color: OG.muted, marginTop: "auto" }}>{sub}</div>
          </div>
          <div
            style={{
              width: 300,
              background: OG.sign,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              borderLeft: `6px dashed ${OG.text}`,
            }}
          >
            <OgImg s={sprite} opacity={exited ? 0.55 : 1} />
            <div style={{ fontFamily: "Pixel", fontSize: 21, color: "#fff", marginTop: 18 }}>THANKS FOR THE</div>
            <div style={{ fontFamily: "Pixel", fontSize: 21, color: "#fff" }}>LIQUIDITY</div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts,
      // let the CDN absorb repeat fetches (X, Telegram, Discord crawlers); a place changes slowly
      headers: {
        ...(!t || t.status === "unknown" || built.stale
          ? { "cache-control": "no-store" }
          : {
              "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
              // 5 min for every state: an exited wallet can buy back in, and its card must follow within minutes
              "vercel-cdn-cache-control": "max-age=300, stale-while-revalidate=600",
            }),
      },
    },
  );
}
