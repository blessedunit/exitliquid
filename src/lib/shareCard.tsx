// Share cards: the 1200x630 PNGs behind /line/<t>, /w/<a> and /dev/<a> links (og:image + "Download card PNG").
// One look for all three: EXIT wordmark, who it is, one big thing (grade / PnL / launches), 4 facts in words.
// Cheap on purpose: the data comes from the engines' own caches under a short budget, the finished PNG is kept
// in memory for 10 min (2 min when part of it was unknown), and only cache misses count against the og limit.
// Signals, not verdicts: no money talk, unknown is drawn as "—" and never as 0.
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { BoundedTtlMap } from "@/lib/bounded";
import { ipfsImage, isCid } from "@/lib/ipfsImage";
import { clientIp, LIMITS, rateLimit } from "@/lib/limits";
import { ogSprite, OgImg, type OgSprite } from "@/lib/og";
import type { Skin } from "@/lib/skins";

export const CARD_SIZE = { width: 1200, height: 630 };

/* ---------------- palette (globals.css tokens) ---------------- */

export const C = {
  bg: "#0a0c0b",
  s1: "#0f1211",
  s2: "#141816",
  line: "#1d2320",
  line2: "#29302c",
  t1: "#e9ede9",
  t2: "#a2aba5",
  t3: "#7d8781",
  exit: "#3ddc84",
  sign: "#08803e",
  down: "#f0616d",
  warn: "#e09a4f",
  vip: "#e8c66a",
};
export type Tone = "good" | "bad" | "warn" | "plain" | "vip";
const TONE: Record<Tone, string> = { good: C.exit, bad: C.down, warn: C.warn, plain: C.t1, vip: C.t1 }; // VIP is retired: the "vip" tone renders as plain

/* ---------------- text safety ---------------- */

/** printable ASCII (+ … · − ×, which the card fonts carry): satori would fetch fallback fonts over the network for anything else */
export function clean(s: string | null | undefined, max = 18): string {
  const t = String(s ?? "").replace(/[^\x20-\x7e…·−×]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
export const shortA = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/* ---------------- fonts (read once) ---------------- */

type Font = { name: string; data: Buffer; weight: 400 | 500 | 700; style: "normal" };
let fontsP: Promise<Font[]> | null = null;
function fonts(): Promise<Font[]> {
  if (!fontsP) {
    const dir = path.join(process.cwd(), "src", "assets", "fonts");
    fontsP = Promise.all([
      readFile(path.join(dir, "Silkscreen-700.ttf")),
      readFile(path.join(dir, "SpaceGrotesk-500.ttf")),
      readFile(path.join(dir, "SpaceGrotesk-700.ttf")),
      readFile(path.join(dir, "DepartureMono-Regular.ttf")),
    ]).then(([px, ui, uiBold, num]) => [
      { name: "Pixel", data: px, weight: 700, style: "normal" },
      { name: "Body", data: ui, weight: 500, style: "normal" },
      { name: "Body", data: uiBold, weight: 700, style: "normal" },
      { name: "Num", data: num, weight: 400, style: "normal" },
    ]);
    fontsP.catch(() => (fontsP = null));
  }
  return fontsP;
}

/* ---------------- token picture, pixelated ---------------- */

const avatarMemo = new BoundedTtlMap<string | null>(500);

/** The token's picture as a 32x32 pixel-art PNG scaled to `px` (data URI); null = no picture in time. */
export async function pixelAvatar(image: string | null | undefined, px = 144, budgetMs = 2_500): Promise<string | null> {
  if (!image) return null;
  const cid = image.match(/\/api\/img\/([a-zA-Z0-9]{46,100})/)?.[1] ?? image.match(/\/ipfs\/([a-zA-Z0-9]{46,100})/)?.[1] ?? null;
  const key = cid ?? image;
  const hit = avatarMemo.get(key);
  if (hit !== undefined) return hit;
  let body: ArrayBuffer | null = null;
  try {
    if (cid && isCid(cid)) body = (await ipfsImage(cid, budgetMs))?.body ?? null;
    else if (image.startsWith("https://")) {
      const r = await fetch(image, { signal: AbortSignal.timeout(budgetMs) });
      const type = r.headers.get("content-type") ?? "";
      if (r.ok && type.startsWith("image/") && !type.includes("svg")) {
        const b = await r.arrayBuffer();
        if (b.byteLength < 4_000_000) body = b;
      }
    }
  } catch {
    body = null;
  }
  if (!body) {
    avatarMemo.set(key, null, 60_000); // try again in a minute (a fresh IPFS file can be slow)
    return null;
  }
  try {
    const small = await sharp(Buffer.from(body), { animated: false, limitInputPixels: 40_000_000 }).resize(32, 32, { fit: "cover" }).png().toBuffer();
    const big = await sharp(small).resize(px, px, { kernel: "nearest" }).png().toBuffer();
    const uri = `data:image/png;base64,${big.toString("base64")}`;
    avatarMemo.set(key, uri, 24 * 3600_000);
    return uri;
  } catch {
    avatarMemo.set(key, null, 10 * 60_000);
    return null;
  }
}

/** settle within `ms` or give null (the card is drawn with what came back) */
export function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/* ---------------- PNG cache + headers ---------------- */

const pngMemo = new BoundedTtlMap<{ png: ArrayBuffer; full: boolean }>(300);
const inflight = new Map<string, Promise<{ png: ArrayBuffer; full: boolean } | Response>>();
const FULL_TTL = 10 * 60_000;
const PARTIAL_TTL = 2 * 60_000;

function pngResponse(png: ArrayBuffer, full: boolean) {
  return new Response(png, {
    headers: {
      "content-type": "image/png",
      // crawlers fetch once per share; the card follows the data within ~10 min
      "cache-control": full ? "public, max-age=600, s-maxage=600, stale-while-revalidate=86400" : "public, max-age=60, s-maxage=120",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * The cached PNG for `key`, or one fresh render. `draw` returns the card (and whether every part was known)
 * or a Response (404 / redirect) to pass through untouched.
 */
export async function cachedCard(hdrs: Headers | null, key: string, draw: () => Promise<{ el: React.ReactElement; full: boolean } | Response>): Promise<Response> {
  const hit = pngMemo.get(key);
  if (hit) return pngResponse(hit.png, hit.full);
  let job = inflight.get(key);
  if (!job) {
    if (hdrs && !(await rateLimit(LIMITS.og, clientIp(hdrs), { localOnly: true }))) {
      return new Response(null, { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
    }
    job = (async () => {
      const d = await draw();
      if (d instanceof Response) return d;
      const img = new ImageResponse(d.el, { ...CARD_SIZE, fonts: await fonts() });
      const png = await img.arrayBuffer();
      const v = { png, full: d.full };
      pngMemo.set(key, v, d.full ? FULL_TTL : PARTIAL_TTL);
      return v;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  try {
    const v = await job;
    return v instanceof Response ? v.clone() : pngResponse(v.png, v.full);
  } catch {
    return new Response(null, { status: 503, headers: { "cache-control": "no-store", "retry-after": "30" } });
  }
}

/* ---------------- the frame ---------------- */

export type CardFact = { value: string; label: string; tone?: Tone };
export type CardChip = { label: string; tone: Tone };

const sprites = new Map<string, Promise<OgSprite>>();
export function sprite(skin: Skin, scale: 2 | 3 | 4 = 2): Promise<OgSprite> {
  const k = `${skin}@${scale}`;
  let p = sprites.get(k);
  if (!p) {
    p = ogSprite(skin, scale, "right");
    p.catch(() => sprites.delete(k));
    sprites.set(k, p);
  }
  return p;
}

function Fact({ f }: { f: CardFact }) {
  const unknown = f.value === "—";
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", width: 340, height: 104, padding: "0 22px", background: C.s1, border: `3px solid ${C.line2}` }}>
      <div style={{ display: "flex", fontFamily: "Num", fontSize: 46, lineHeight: 1, color: unknown ? C.t3 : TONE[f.tone ?? "plain"] }}>{f.value}</div>
      <div style={{ display: "flex", fontFamily: "Body", fontWeight: 500, fontSize: 22, color: C.t2, marginTop: 10 }}>{f.label}</div>
    </div>
  );
}

function Chip({ c }: { c: CardChip }) {
  const col = TONE[c.tone];
  return (
    <div style={{ display: "flex", fontFamily: "Num", fontSize: 19, color: c.tone === "plain" ? C.t2 : col, border: `2px solid ${c.tone === "plain" ? C.line2 : col}`, padding: "5px 10px", marginRight: 10, marginTop: 10, background: C.s1 }}>
      {c.label}
    </div>
  );
}

/**
 * kind: "LINE HEALTH" / "WALLET" / "DEV PASSPORT". ident: the avatar (picture or sprite). big: the right-hand box.
 */
export function CardFrame(p: {
  kind: string;
  avatar: string | null;
  avatarSprite?: OgSprite | null;
  fallbackLetter?: string;
  title: string;
  subtitle: string;
  chips: CardChip[];
  big: { value: string; label: string; sub?: string; tone: Tone; letter?: boolean };
  facts: CardFact[];
  path: string;
  people: OgSprite[];
}) {
  const bigCol = p.big.value === "?" || p.big.value === "—" ? C.t3 : TONE[p.big.tone];
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: C.bg, fontFamily: "Body", color: C.t1 }}>
      <div style={{ display: "flex", height: 8, background: `repeating-linear-gradient(-45deg, ${C.exit} 0 16px, ${C.bg} 16px 32px)` }} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "26px 48px 0" }}>
        {/* top: wordmark + kind */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", background: C.sign, border: `4px solid ${C.t1}`, padding: "2px 14px", fontFamily: "Pixel", fontSize: 26, color: "#fff", letterSpacing: 4 }}>EXIT</div>
            <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 20, color: C.exit, letterSpacing: 3, marginLeft: 18 }}>{p.kind}</div>
          </div>
          <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 15, color: C.t3, letterSpacing: 2 }}>SIGNALS, NOT VERDICTS</div>
        </div>

        <div style={{ display: "flex", flex: 1, marginTop: 24 }}>
          {/* left: who + facts */}
          <div style={{ display: "flex", flexDirection: "column", width: 700 }}>
            <div style={{ display: "flex", alignItems: "center", height: 150 }}>
              <div style={{ display: "flex", width: 140, height: 140, flexShrink: 0, alignItems: !p.avatar && p.avatarSprite ? "flex-start" : "center", paddingTop: !p.avatar && p.avatarSprite ? 12 : 0, justifyContent: "center", border: `4px solid ${C.t1}`, background: C.s2, boxShadow: "8px 8px 0 #000", overflow: "hidden" }}>
                {p.avatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.avatar} width={132} height={132} alt="" />
                ) : p.avatarSprite ? (
                  <OgImg s={p.avatarSprite} />
                ) : (
                  <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 64, color: C.exit }}>{(p.fallbackLetter || "?").slice(0, 1)}</div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", marginLeft: 30, minWidth: 0 }}>
                {p.title.startsWith("0x") ? (
                  // an address: the number face, lower case (the pixel face would shout it and lose the ellipsis)
                  <div style={{ display: "flex", fontFamily: "Num", fontSize: 54, lineHeight: 1, color: C.t1 }}>{p.title}</div>
                ) : (
                  <div style={{ display: "flex", fontFamily: "Pixel", fontSize: p.title.length > 10 ? 44 : 60, lineHeight: 1, color: C.t1 }}>{p.title}</div>
                )}
                {p.subtitle ? <div style={{ display: "flex", fontFamily: "Body", fontWeight: 500, fontSize: 24, color: C.t2, marginTop: 10 }}>{p.subtitle}</div> : null}
                {p.chips.length ? <div style={{ display: "flex", flexWrap: "wrap", maxWidth: 520, maxHeight: 48, overflow: "hidden" }}>{p.chips.slice(0, 4).map((c, i) => <Chip key={i} c={c} />)}</div> : null}
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", marginTop: 20, width: 700, justifyContent: "space-between" }}>
              {p.facts.slice(0, 4).map((f, i) => (
                <div key={i} style={{ display: "flex", marginBottom: 12 }}><Fact f={f} /></div>
              ))}
            </div>
          </div>

          {/* right: the one big thing */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: 360, height: 400, marginLeft: 44, background: C.s1, border: `4px solid ${bigCol}`, boxShadow: "12px 12px 0 #000" }}>
            <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 20, letterSpacing: 3, color: C.t3 }}>{p.big.label}</div>
            <div style={{ display: "flex", fontFamily: p.big.letter ? "Pixel" : "Num", fontSize: p.big.letter ? 230 : p.big.value.length > 8 ? 60 : 84, lineHeight: 1, color: bigCol, marginTop: p.big.letter ? 0 : 26 }}>{p.big.value}</div>
            {p.big.sub ? <div style={{ display: "flex", fontFamily: "Body", fontWeight: 500, fontSize: 23, color: C.t2, marginTop: p.big.letter ? 0 : 22, textAlign: "center", padding: "0 18px" }}>{p.big.sub}</div> : null}
          </div>
        </div>
      </div>

      {/* bottom: the line walking to the site name */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", height: 96, padding: "0 48px 8px", borderTop: `3px solid ${C.line}` }}>
        <div style={{ display: "flex", alignItems: "center", height: 84 }}>
          <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 24, color: C.t1, letterSpacing: 2 }}>EXITLIQUID.FUN</div>
          <div style={{ display: "flex", fontFamily: "Num", fontSize: 19, color: C.t3, marginLeft: 16 }}>{p.path}</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", borderBottom: `3px solid ${C.line2}` }}>
          {p.people.map((s, i) => (
            <div key={i} style={{ display: "flex", marginLeft: 6 }}><OgImg s={s} /></div>
          ))}
          <div style={{ display: "flex", width: 30, height: 56, marginLeft: 14, border: `4px solid ${C.t1}`, borderBottom: "none", background: "rgba(61,220,132,.45)" }} />
        </div>
      </div>
    </div>
  );
}

/** three small people for the bottom strip */
export async function crowd(skins: Skin[]): Promise<OgSprite[]> {
  const list = await Promise.all(skins.map((s) => sprite(s, 2)));
  // the 2x files drawn at 1x (73-81 px tall): whole pixels, no smoothing
  return list.map((s) => ({ ...s, w: s.w / 2, h: s.h / 2 }));
}
