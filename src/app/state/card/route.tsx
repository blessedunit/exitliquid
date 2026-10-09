// /state/card: the weekly "State of vibe" card, 1200x1500 PNG (portrait 4:5, fits X and Telegram).
// Reads the snapshot /api/state already keeps (memory, then Redis): no chain reads of its own.
// A rendered card is kept for an hour per process, so a weekly post or a burst of downloads costs one render
// (redrawn sooner only when the card is 15+ min old and a newer snapshot has landed).
// No snapshot yet -> a "Reading the chain" card, never cached, header x-card: warming (the weekly state job retries).
import { after } from "next/server";
import { ImageResponse } from "next/og";
import { ogFonts, OG } from "@/lib/og";
import { peekState, pendingBuild, readState, type StateSnapshot } from "@/lib/state";
import { clientIp, rateLimit, tooMany, type Limit } from "@/lib/limits";

export const dynamic = "force-dynamic";

const W = 1200;
const H = 1500;
const TTL_MS = 60 * 60_000;
const REDRAW_MS = 15 * 60_000;
const CARD_V = 4; // bump when the layout changes: a running server drops the old cached card
const LIMIT: Limit = { name: "state-card", limit: 20, windowSec: 60 };

type Cached = { png: ArrayBuffer; at: number; builtAt: number; weekOf: string; v: number };
const G = globalThis as unknown as { __exitStateCard?: Cached | null; __exitStateCardJob?: Promise<Cached> | null };

/* ------------------------------------------------------------------ formatting (unknown is "—", never 0) */

const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const int = (n: number | null | undefined) => (ok(n) ? n.toLocaleString("en-US") : "—");
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function isoDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
function stamp(ts: number): string {
  const d = new Date(ts * 1000);
  return `${dayLabel(ts)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
/** words, not "21.9d": in the pixel face a D reads as a 0 */
function dur(sec: number | null | undefined): string {
  if (!ok(sec)) return "—";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} MIN`;
  if (sec < 86_400) {
    const h = sec / 3600;
    return `${h.toFixed(h < 10 ? 1 : 0)} H`;
  }
  const d = sec / 86_400;
  const v = d.toFixed(d < 10 ? 1 : 0);
  return `${v} ${v === "1.0" ? "DAY" : "DAYS"}`;
}
function pct(num: number | null | undefined, den: number | null | undefined): string {
  if (!ok(num) || !ok(den) || den <= 0) return "—";
  const p = (num / den) * 100;
  if (p === 0) return "0%";
  if (p < 0.1) return `${p.toFixed(2)}%`;
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${p.toFixed(0)}%`;
}
function eth(v: number): string {
  if (!ok(v)) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
/** on-chain strings: printable, short */
const clean = (s: string | null | undefined, max: number) => {
  const t = (s ?? "").replace(/[^\x20-\x7e]/g, "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/* ------------------------------------------------------------------ pieces */

const label = { display: "flex", fontFamily: "Pixel", fontSize: 18, color: OG.faint, letterSpacing: 2 } as const;
const hair = `2px solid ${OG.hair}`;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: OG.bg, fontFamily: "Body", color: OG.text }}>
      <div style={{ display: "flex", height: 12, background: `repeating-linear-gradient(-45deg, ${OG.exit} 0 18px, ${OG.bg} 18px 36px)` }} />
      <div style={{ display: "flex", flexDirection: "column", padding: "40px 64px 0", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ display: "flex", background: OG.sign, border: `5px solid ${OG.text}`, padding: "6px 16px", fontFamily: "Pixel", fontSize: 28, color: "#fff", letterSpacing: 4 }}>EXIT</div>
          <div style={{ fontFamily: "Pixel", fontSize: 20, color: OG.exit, letterSpacing: 3 }}>DEPARTURES BOARD · VIBE/VIBE</div>
        </div>
        {children}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "26px 64px", borderTop: hair, background: OG.bg2 }}>
        <div style={{ display: "flex", fontSize: 24, color: OG.muted }}>Signals, not verdicts. Read from the chain.</div>
        <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 34, color: OG.exit, letterSpacing: 2 }}>EXITLIQUID.FUN</div>
      </div>
      <div style={{ display: "flex", height: 10, background: OG.exit }} />
    </div>
  );
}

/** a number in the pixel face; a trailing % is set in the body face (the pixel % reads as a glyph soup) */
function Num({ v, size, color }: { v: string; size: number; color: string }) {
  const p = v.endsWith("%");
  return (
    <div style={{ display: "flex", alignItems: "baseline", color }}>
      <span style={{ fontFamily: "Pixel", fontSize: size, letterSpacing: 1 }}>{p ? v.slice(0, -1) : v}</span>
      {p ? <span style={{ fontFamily: "Body", fontWeight: 700, fontSize: Math.round(size * 0.8), marginLeft: 4 }}>%</span> : null}
    </div>
  );
}

function Stat({ k, v, extra, sub, tone }: { k: string; v: string; extra?: string; sub: string; tone?: string }) {
  const color = v === "—" ? OG.faint : tone ?? OG.text;
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 520, padding: "20px 26px", background: OG.bg2, border: hair, flexShrink: 0 }}>
      <div style={label}>{k}</div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: 12 }}>
        <Num v={v} size={56} color={color} />
        {extra && extra !== "—" ? (
          <div style={{ display: "flex", alignItems: "baseline", marginLeft: 20 }}>
            <Num v={extra} size={34} color={OG.muted} />
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", fontSize: 22, color: OG.muted, marginTop: 8 }}>{sub}</div>
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginTop: 26, flexShrink: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingBottom: 10, borderBottom: hair }}>
        <div style={{ ...label, color: OG.exit }}>{title}</div>
        {right ? <div style={{ display: "flex", fontSize: 18, color: OG.faint }}>{right}</div> : null}
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ the card */

function Card({ d }: { d: StateSnapshot }) {
  const t = d.totals;
  const c = t.cohort;
  const x = d.snipers;
  const vols = (d.volumes?.rows ?? []).filter((r) => ok(r.volume24hEth) && r.volume24hEth > 0).slice(0, 3);
  const dev = d.devs?.week?.[0] ?? null;
  const days = d.days ?? [];
  const vals = days.map((r) => (r.launches ? r.launches.curve + r.launches.taxed : null));
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  const BAR_H = 76;

  return (
    <Frame>
      <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 84, marginTop: 22, letterSpacing: 2, lineHeight: 1, flexShrink: 0 }}>STATE OF VIBE</div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 16, flexShrink: 0 }}>
        <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 30, color: OG.exit, letterSpacing: 2 }}>WEEK OF {dayLabel(d.windowStart)}</div>
        <div style={{ display: "flex", fontSize: 20, color: OG.faint }}>
          snapshot {stamp(d.builtAt)} · block #{int(d.headBlock)}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 26, flexShrink: 0 }}>
        <Stat k="LAUNCHES · 7 DAYS" v={int(t.launches7d)} sub="all four launch factories" />
        <Stat
          k="GRADUATED SO FAR"
          v={c && c.launched > 0 ? int(c.graduated) : "—"}
          extra={c && c.launched > 0 ? pct(c.graduated, c.launched) : undefined}
          sub={c && c.launched > 0 ? `of ${int(c.launched)} launched this week` : "not read yet"}
          tone={OG.exit}
        />
        <Stat k="MEDIAN TIME TO THE DOOR" v={d.ttg && d.ttg.n > 0 ? dur(d.ttg.medianS) : "—"} sub={d.ttg && d.ttg.n > 0 ? `launch to graduation, ${int(d.ttg.n)} tokens` : "not read yet"} />
        <Stat
          k="5+ SNIPERS AT THE FRONT"
          v={x && x.formed > 0 ? pct(x.withFive, x.formed) : "—"}
          sub={x && x.formed > 0 ? `of ${int(x.formed)} formed lines, first 20 buyers` : "not read yet"}
          tone={OG.red}
        />
      </div>

      {vals.length > 0 && (
        <Section title="LAUNCHES PER DAY" right="UTC days, today so far">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 10 }}>
            {days.map((r, i) => {
              const v = vals[i];
              return (
                <div key={r.day} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 132 }}>
                  <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 18, color: v === null ? OG.faint : OG.text, marginBottom: 6 }}>{v === null ? "—" : int(v)}</div>
                  <div
                    style={{
                      display: "flex",
                      width: 96,
                      height: v === null ? 4 : Math.max(4, Math.round((v / max) * BAR_H)),
                      background: v === null ? OG.hair : OG.exit,
                      opacity: r.partial ? 0.5 : 1,
                    }}
                  />
                  <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 14, color: OG.faint, marginTop: 8, letterSpacing: 1 }}>
                    {DOW[new Date(r.day * 1000).getUTCDay()]} {String(new Date(r.day * 1000).getUTCDate()).padStart(2, "0")}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="TOP 3 BY 24H VOLUME" right="ETH, last 24 hours at snapshot">
        {vols.length ? (
          vols.map((r, i) => (
            <div key={r.token} style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: hair }}>
              <div style={{ display: "flex", width: 52, fontFamily: "Pixel", fontSize: 26, color: OG.faint }}>{i + 1}</div>
              <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <div style={{ display: "flex", fontSize: 30, fontWeight: 700 }}>${clean(r.symbol, 14) || short(r.token)}</div>
                <div style={{ display: "flex", fontSize: 18, color: OG.faint }}>{clean(r.name, 40) || short(r.token)}</div>
              </div>
              <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 14, letterSpacing: 1, padding: "4px 10px", marginRight: 24, border: `2px solid ${r.graduated ? OG.exit : OG.hair}`, color: r.graduated ? OG.exit : OG.muted }}>
                {r.graduated ? "GRADUATED" : "ON CURVE"}
              </div>
              <div style={{ display: "flex", alignItems: "baseline" }}>
                <span style={{ fontFamily: "Pixel", fontSize: 34 }}>{eth(r.volume24hEth)}</span>
                <span style={{ fontFamily: "Pixel", fontSize: 18, color: OG.muted, marginLeft: 10 }}>ETH</span>
              </div>
            </div>
          ))
        ) : (
          <div style={{ display: "flex", fontSize: 22, color: OG.faint, padding: "14px 0" }}>Not read at this snapshot.</div>
        )}
      </Section>

      <Section title="TOP DEV BY GRADUATIONS">
        {dev ? (
          <div style={{ display: "flex", alignItems: "center", padding: "10px 0" }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
              <div style={{ display: "flex", fontSize: 32, fontWeight: 700 }}>{short(dev.creator)}</div>
              <div style={{ display: "flex", fontSize: 20, color: OG.faint }}>
                {int(dev.grads)} graduated of {int(dev.launches)} launches, all time{dev.lastSymbol ? ` · latest $${clean(dev.lastSymbol, 14)}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 44, color: OG.exit }}>{int(dev.grads7d)}</div>
            <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 16, color: OG.faint, marginLeft: 12, letterSpacing: 1 }}>THIS WEEK</div>
          </div>
        ) : (
          <div style={{ display: "flex", fontSize: 22, color: OG.faint, padding: "14px 0" }}>{d.devs ? "No graduations this week." : "Not read at this snapshot."}</div>
        )}
      </Section>
    </Frame>
  );
}

function Warming({ stage }: { stage: string }) {
  return (
    <Frame>
      <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 84, marginTop: 22, letterSpacing: 2, lineHeight: 1, flexShrink: 0 }}>STATE OF VIBE</div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", marginBottom: "auto" }}>
        <div style={{ display: "flex", fontFamily: "Pixel", fontSize: 56, color: OG.exit, letterSpacing: 2 }}>READING THE CHAIN</div>
        <div style={{ display: "flex", fontSize: 28, color: OG.muted, marginTop: 18 }}>Every launch factory, from the start. The card fills in a few minutes.</div>
        {stage && stage !== "idle" ? <div style={{ display: "flex", fontSize: 22, color: OG.faint, marginTop: 10 }}>Step: {clean(stage, 60)}</div> : null}
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ handler */

async function render(node: React.ReactElement): Promise<ArrayBuffer> {
  const fonts = await ogFonts();
  return new ImageResponse(node, { width: W, height: H, fonts }).arrayBuffer();
}

export async function GET(req: Request) {
  if (!(await rateLimit(LIMIT, clientIp(req), { localOnly: true }))) return tooMany();
  // dev only: preview the "Reading the chain" card without a cold start
  if (process.env.NODE_ENV === "development" && new URL(req.url).searchParams.get("preview") === "warming") {
    return new Response(await render(<Warming stage="factory logs 3/4" />), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
  const now = Date.now();
  const hit = G.__exitStateCard;
  let fresh = hit && hit.v === CARD_V && now - hit.at < TTL_MS ? hit : null;
  // a card older than 15 min gives way to a newer snapshot (a memory read; never starts a build)
  if (fresh && now - fresh.at >= REDRAW_MS) {
    const s = await peekState().catch(() => null);
    if (s && s.builtAt > fresh.builtAt) fresh = null;
  }

  let card: Cached | null = fresh;
  let warmStage = "";
  if (!card) {
    // never waits: the last snapshot (memory or Redis); a stale one starts the same background build /state starts
    const r = await readState(0);
    const job = pendingBuild();
    if (job) after(() => job.catch(() => undefined));
    if (r.snapshot) {
      const snap = r.snapshot;
      if (!G.__exitStateCardJob) {
        G.__exitStateCardJob = render(<Card d={snap} />)
          .then((png) => (G.__exitStateCard = { png, at: Date.now(), builtAt: snap.builtAt, weekOf: isoDay(snap.windowStart), v: CARD_V }))
          .finally(() => {
            G.__exitStateCardJob = null;
          });
      }
      try {
        card = await G.__exitStateCardJob;
      } catch {
        card = hit ?? null; // a failed render keeps the older card rather than nothing
      }
      if (!card) return new Response("render failed", { status: 500, headers: { "cache-control": "no-store" } });
    } else if (hit) {
      card = hit; // the snapshot went away (restart, no Redis): an hour-old card beats a blank one
    } else {
      warmStage = r.stage;
    }
  }

  if (!card) {
    const png = await render(<Warming stage={warmStage} />);
    return new Response(png, {
      headers: { "content-type": "image/png", "cache-control": "no-store", "x-card": "warming", "retry-after": "60" },
    });
  }

  const left = Math.max(60, Math.round((TTL_MS - (Date.now() - card.at)) / 1000));
  return new Response(card.png, {
    headers: {
      "content-type": "image/png",
      "content-disposition": `inline; filename="state-of-vibe-${card.weekOf}.png"`,
      "cache-control": `public, max-age=${left}, s-maxage=${left}`,
      "x-card": "ready",
      "x-snapshot-built-at": String(card.builtAt),
    },
  });
}
