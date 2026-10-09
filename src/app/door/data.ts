// Graduation watch (/door): who is about to walk through the door, who just did.
// Server only. One shared snapshot for every viewer, rebuilt at most once a minute and only when asked.
//
// Upstream cost per rebuild (vibe/vibe public API, nothing from the chain):
//   1-2  /launches?minimumProgressBps=8500 (the board's door sort, filtered to 85 %+; ~6 s each)
//   <=40 /launches/<t>/flow24h (the same URL and data cache as the board's ETA; memo 2 min)
//   1    /launches?lifecycle=GRADUATED&limit=100 (has curve.graduatedAt)
//   1    /sparklines for the graduations of the last 24 h (raw closes: price at the door vs now)
// The +1h move after the door comes from the State of vibe snapshot (chain), read with peekState():
// it never starts a build.
import "server-only";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAIN_ID } from "@/lib/config";
import { peekState } from "@/lib/state";
import type { DoorSnap, GradRow, NearCard } from "./types";

const API = `https://testnet.vibevibe.fun/api/v1/chains/${CHAIN_ID}`;
// same headers as src/lib/launches.ts, so identical URLs share the Next data cache with the board
const HEADERS = { accept: "application/json", origin: "https://testnet.vibevibe.fun", "user-agent": "exitliquid.fun (read-only directory)" };

const NEAR_BPS = 8_500; // within 15 % of the door
const FLOW_CAP = 60; // ETA reads per rebuild (busiest first; memo 2 min + data cache 5 min); the rest are listed as "pace not checked"
const SNAP_TTL = 60_000;
const DAY = 86_400;

/* ---------------- helpers ---------------- */

const isInt = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const wei = (v: unknown) => (isInt(v) ? Number(BigInt(v) / 10n ** 9n) / 1e9 : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const text = (v: unknown, n: number) => String(v ?? "").replace(CTRL, "").trim().slice(0, n);

function gateway(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice(7).split("/")[0];
    return /^[a-zA-Z0-9]{46,100}$/.test(cid) ? `/api/img/${cid}?w=96` : null;
  }
  return uri.startsWith("https://") ? uri : null;
}

async function api<T>(path: string, revalidate: number, timeout: number): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: HEADERS, next: { revalidate }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`vibe api ${r.status}`);
  return (await r.json()) as T;
}

function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(fallback); },
    );
  });
}

/* ---------------- near the door ---------------- */

type ApiItem = {
  tokenAddress?: string; name?: string; symbol?: string; createdAt?: string;
  content?: { image?: { uri?: string } }; moderation?: { visibility?: string };
  curve?: { lifecycle?: string; progressBps?: number; ethRemainingWei?: string; graduatedAt?: string | null; completedAt?: string | null };
  analytics?: { volume24hWei?: string; volume1hWei?: string; uniqueBuyers1h?: number; buyCount1h?: number; sellCount1h?: number; priceChange1hBps?: string };
  holderCount?: number;
};
type ApiPage = { data?: { items?: ApiItem[]; page?: { nextCursor?: string; hasMore?: boolean } } };

const visible = (x: ApiItem) => !!x.tokenAddress && /^0x[0-9a-fA-F]{40}$/.test(x.tokenAddress) && x.moderation?.visibility !== "HIDDEN";

function nearCard(x: ApiItem): NearCard {
  const a = x.analytics ?? {};
  const lc = x.curve?.lifecycle;
  const progressBps = Math.max(0, Math.min(10_000, Number(x.curve?.progressBps ?? 0)));
  const remainingEth = wei(x.curve?.ethRemainingWei);
  // at the door = the curve is complete and the pool is being opened (100 % on a trading curve is a rounded 99.99 %)
  const atDoor = lc === "CURVE_COMPLETE" || lc === "GRADUATING";
  // a curve complete for over an hour whose pool never opened is not "opening now" (seen 07.10: three since 02.10)
  const doneAt = Math.floor(Date.parse(x.curve?.completedAt ?? "") / 1000);
  const stuckH = atDoor && Number.isFinite(doneAt) && doneAt > 0 ? (Date.now() / 1000 - doneAt) / 3600 : 0;
  return {
    token: String(x.tokenAddress).toLowerCase(),
    symbol: text(x.symbol, 16),
    name: text(x.name, 40),
    image: gateway(x.content?.image?.uri),
    createdAt: Math.floor(Date.parse(x.createdAt ?? "") / 1000) || 0,
    progressBps,
    holders: num(x.holderCount),
    remainingEth,
    vol1hEth: wei(a.volume1hWei),
    buys1h: num(a.buyCount1h),
    sells1h: num(a.sellCount1h),
    buyers1h: num(a.uniqueBuyers1h),
    change1hBps: num(a.priceChange1hBps),
    dayPaceEth: null,
    etaLoH: null,
    etaHiH: null,
    deltaBps: null,
    deltaMin: null,
    phase: stuckH > 1 ? "stalled" : atDoor ? "door" : "unknown",
    why: stuckH > 1 ? `curve complete ${stuckH >= 48 ? `${Math.floor(stuckH / 24)}d` : `${Math.floor(stuckH)}h`} ago, door not opened` : null,
  };
}

// the door sort costs vibe 6-9 s: keep the last good list for 15 min when it fails
let lastNear: { at: number; items: ApiItem[]; more: boolean } | null = null;

async function nearList(): Promise<{ items: ApiItem[]; more: boolean }> {
  const base = `minimumProgressBps=${NEAR_BPS}&maximumProgressBps=10000&lifecycle=CURVE_TRADING,CURVE_COMPLETE,GRADUATING&sort=PROGRESS_DESC&limit=100`;
  try {
    const p1 = await api<ApiPage>(`/launches?${base}`, 60, 15_000);
    const items = [...(p1.data?.items ?? [])];
    let more = !!p1.data?.page?.hasMore;
    // vibe's cursors expire at once on this sort (409 CURSOR_SNAPSHOT_EXPIRED, checked 07.10) and offset paging
    // answers 503 LISTING_BUSY: the next 100 are a fresh range query below the lowest door % seen (ties deduped)
    const low = Math.min(...items.map((x) => Number(x.curve?.progressBps ?? 10_000)));
    if (more && items.length && Number.isFinite(low) && low > NEAR_BPS) {
      try {
        const p2 = await api<ApiPage>(`/launches?${base.replace("maximumProgressBps=10000", `maximumProgressBps=${low}`)}`, 60, 15_000);
        const seen = new Set(items.map((x) => x.tokenAddress?.toLowerCase()));
        for (const x of p2.data?.items ?? []) if (!seen.has(x.tokenAddress?.toLowerCase())) items.push(x);
        more = !!p2.data?.page?.hasMore;
      } catch {
        /* the first 100 still stand; `more` stays true */
      }
    }
    lastNear = { at: Date.now(), items, more };
    return { items, more };
  } catch (e) {
    if (lastNear && Date.now() - lastNear.at < 15 * 60_000) return lastNear;
    throw e;
  }
}

type Flow = { data?: { buyVolumeWei?: string; sellVolumeWei?: string } };
const flowMemo = new Map<string, { at: number; v: { buy: number | null; sell: number | null } }>();

async function flow(token: string): Promise<{ buy: number | null; sell: number | null }> {
  const hit = flowMemo.get(token);
  if (hit && Date.now() - hit.at < 120_000) return hit.v;
  const f = await api<Flow>(`/launches/${token}/flow24h`, 300, 4_000);
  const v = { buy: wei(f.data?.buyVolumeWei), sell: wei(f.data?.sellVolumeWei) };
  if (flowMemo.size > 500) flowMemo.clear();
  flowMemo.set(token, { at: Date.now(), v });
  return v;
}

/**
 * The board's ETA rule (src/lib/launches.ts etaFor), plus the fast end of the range:
 *   day  = net ETH inflow over the last 24 h (or since launch) per hour
 *   hour = last hour's volume (buys + sells: an upper bound of the hour's net inflow)
 *   no buys this hour, a flat or draining day, or an hour under 10 % of the day = stalled
 *   slow end = remaining / min(day, hour) (= the board's ETA), fast end = remaining / max(day, hour)
 */
async function withPace(c: NearCard, nowS: number): Promise<NearCard> {
  if (c.phase === "door" || c.phase === "stalled") return c;
  if (c.buys1h === 0) return { ...c, phase: "stalled", why: "no buys this hour" };
  if (c.buys1h === null || c.remainingEth === null) return c;
  const ageH = (nowS - c.createdAt) / 3600;
  if (!(ageH >= 1)) return c; // under an hour of history is noise, not a rate
  const f = await within(flow(c.token), 4_500, null);
  if (!f || f.buy === null || f.sell === null) return c;
  const day = (f.buy - f.sell) / Math.min(24, ageH);
  if (!(day > 0)) return { ...c, dayPaceEth: day, phase: "stalled", why: day < 0 ? "more sold than bought today" : "flat today" };
  const hour = c.vol1hEth;
  if (hour !== null && hour < day * 0.1) return { ...c, dayPaceEth: day, phase: "stalled", why: "last hour far slower than the day" };
  const slow = hour === null ? day : Math.min(day, hour);
  const fast = hour === null ? day : Math.max(day, hour);
  return { ...c, dayPaceEth: day, etaLoH: c.remainingEth / fast, etaHiH: c.remainingEth / slow, phase: "walking" };
}

async function mapLimit<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await f(xs[k]);
      }
    }),
  );
  return out;
}

// door % samples seen by this server (token -> [ms, bps][]), for "+0.4% in 38m". Two hours kept, 200 tokens max.
const samples = new Map<string, [number, number][]>();
function sampleDelta(c: NearCard, now: number): NearCard {
  const s = (samples.get(c.token) ?? []).filter((x) => now - x[0] <= 2 * 3600_000);
  if (!s.length || now - s[s.length - 1][0] >= 4 * 60_000) s.push([now, c.progressBps]); // about one sample per 5 min
  samples.set(c.token, s.slice(-40));
  // the oldest sample that is at most an hour old and at least 10 min old
  const ref = s.find((x) => now - x[0] <= 61 * 60_000 && now - x[0] >= 10 * 60_000);
  if (!ref) return c;
  const deltaBps = c.progressBps - ref[1];
  const deltaMin = Math.round((now - ref[0]) / 60_000);
  // the pace says "walking" but the door % itself has not moved for 30+ min: what we saw wins
  if (c.phase === "walking" && deltaMin >= 30 && deltaBps <= 0) {
    return { ...c, deltaBps, deltaMin, phase: "stalled", why: deltaBps < 0 ? `door % fell in ${deltaMin}m` : `door % flat for ${deltaMin}m` };
  }
  return { ...c, deltaBps, deltaMin };
}

// graduations of lines this page saw at 85 %+ (vibe's graduated list is sorted by launch date, so an old
// launch that graduates today is past its first 100 rows: checked 07.10, a wave of Sep-4..9 launches)
type SeenGrad = { symbol: string | null; name: string | null; image: string | null; gradTs: number; holders: number | null; vol24hEth: number | null };
const seenGrads = new Map<string, SeenGrad>();
const recheck = new Map<string, number>(); // token -> when it was last looked up after leaving the list

// samples and seen graduations survive a restart (a small JSON next to the State snapshot); best effort only
const SAMPLE_FILE = join(tmpdir(), "exitliq-door-v1.json");
let samplesLoaded = false;
async function loadSamples() {
  if (samplesLoaded) return;
  samplesLoaded = true;
  try {
    const j = JSON.parse(await readFile(SAMPLE_FILE, "utf8")) as { samples?: Record<string, [number, number][]>; grads?: Record<string, SeenGrad> };
    for (const [t, v] of Object.entries(j.samples ?? {})) {
      if (/^0x[0-9a-f]{40}$/.test(t) && Array.isArray(v)) samples.set(t, v.filter((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite)).slice(-40));
    }
    for (const [t, g] of Object.entries(j.grads ?? {})) if (/^0x[0-9a-f]{40}$/.test(t) && g && Number.isFinite(g.gradTs)) seenGrads.set(t, g);
  } catch {
    /* none yet */
  }
}
async function saveSamples() {
  try {
    await writeFile(SAMPLE_FILE, JSON.stringify({ samples: Object.fromEntries(samples), grads: Object.fromEntries(seenGrads) }));
  } catch {
    /* read-only disk: memory only */
  }
}

/** Lines seen at 85 %+ in the last 2 h that left the list: graduated (kept with their time) or slid back. */
async function resolveLeavers(current: Set<string>, now: number) {
  const nowS = Math.floor(now / 1000);
  for (const [t, g] of seenGrads) if (nowS - g.gradTs > DAY) seenGrads.delete(t);
  const gone = [...samples.keys()].filter((t) => !current.has(t) && !seenGrads.has(t) && now - (recheck.get(t) ?? 0) > 10 * 60_000).slice(0, 30);
  await mapLimit(gone, 4, async (t) => {
    recheck.set(t, now);
    try {
      // the single-token endpoint carries curve.graduatedAt (the batched cards one does not); 0.2-1.3 s
      const j = await api<{ data?: ApiItem }>(`/launches/${t}`, 300, 3_000);
      const x = j.data;
      const ts = Math.floor(Date.parse(x?.curve?.graduatedAt ?? "") / 1000);
      if (x && visible(x) && x.curve?.lifecycle === "GRADUATED" && Number.isFinite(ts) && nowS - ts <= DAY) {
        seenGrads.set(t, {
          symbol: text(x.symbol, 16) || null,
          name: text(x.name, 40) || null,
          image: gateway(x.content?.image?.uri),
          gradTs: ts,
          holders: num(x.holderCount),
          vol24hEth: wei(x.analytics?.volume24hWei),
        });
        samples.delete(t);
      }
    } catch {
      /* unknown this round: asked again in 10 min */
    }
  });
  if (recheck.size > 1000) recheck.clear();
}

/* ---------------- just graduated ---------------- */

type ApiSpark = { data?: { tokens?: Record<string, { times?: unknown; closes?: unknown }> } };

async function gradsFeed(nowS: number): Promise<GradRow[] | null> {
  const [listR, stR] = await Promise.allSettled([
    api<ApiPage>(`/launches?lifecycle=GRADUATED&limit=100`, 60, 10_000),
    peekState(),
  ]);
  const st = stR.status === "fulfilled" ? stR.value : null;
  const doorRows = st?.door?.rows ?? [];
  const byChain = new Map(doorRows.map((r) => [r.token.toLowerCase(), r]));
  const rows = new Map<string, GradRow>();
  if (listR.status === "fulfilled") {
    for (const x of (listR.value.data?.items ?? []).filter(visible)) {
      const ts = Math.floor(Date.parse(x.curve?.graduatedAt ?? "") / 1000);
      if (!Number.isFinite(ts) || ts <= 0 || nowS - ts > DAY || ts > nowS + 300) continue;
      const t = String(x.tokenAddress).toLowerCase();
      rows.set(t, {
        token: t,
        symbol: text(x.symbol, 16) || null,
        name: text(x.name, 40) || null,
        image: gateway(x.content?.image?.uri),
        gradTs: ts,
        holders: num(x.holderCount),
        vol24hEth: wei(x.analytics?.volume24hWei),
        ret1h: null,
        ret1hSrc: null,
        sinceDoor: null,
        path: [],
      });
    }
  }
  // lines this page saw leave 85 %+ through the door
  for (const [t, g] of seenGrads) {
    if (rows.has(t) || nowS - g.gradTs > DAY) continue;
    rows.set(t, { token: t, ...g, ret1h: null, ret1hSrc: null, sinceDoor: null, path: [] });
  }
  // graduations the chain saw that vibe's list (100 newest launches that graduated) does not carry
  for (const r of doorRows) {
    const t = r.token.toLowerCase();
    if (rows.has(t) || nowS - r.gradTs > DAY) continue;
    rows.set(t, { token: t, symbol: r.symbol, name: null, image: null, gradTs: r.gradTs, holders: null, vol24hEth: null, ret1h: null, ret1hSrc: null, sinceDoor: null, path: [] });
  }
  if (listR.status === "rejected" && !rows.size) return null; // unknown, not "none"
  for (const [t, g] of rows) {
    const c = byChain.get(t);
    if (c && c.ret1h !== null && Number.isFinite(c.ret1h)) {
      g.ret1h = c.ret1h;
      g.ret1hSrc = "chain";
    }
  }
  const list = [...rows.values()].sort((a, b) => b.gradTs - a.gradTs).slice(0, 60);
  if (list.length) {
    try {
      // vibe answers 400 above 60 tokens per call
      const key = list.map((g) => g.token).sort().join(",");
      const s = await api<ApiSpark>(`/sparklines?interval=15m&tokens=${key}`, 60, 6_000);
      const toks = s.data?.tokens ?? {};
      for (const g of list) {
        const v = toks[g.token] ?? toks[Object.keys(toks).find((k) => k.toLowerCase() === g.token) ?? ""];
        if (!v || !Array.isArray(v.times) || !Array.isArray(v.closes) || v.times.length !== v.closes.length) continue;
        const pts: { t: number; p: number }[] = [];
        for (let i = 0; i < v.times.length; i++) {
          const t = Number(v.times[i]);
          const p = isInt(v.closes[i]) ? Number(v.closes[i]) : NaN;
          if (Number.isFinite(t) && Number.isFinite(p) && p > 0) pts.push({ t, p });
        }
        pts.sort((a, b) => a.t - b.t);
        // the candle the door opened in (its close is the first pool price, near enough at 15 min)
        const door = [...pts].reverse().find((q) => q.t <= g.gradTs) ?? null;
        const after = pts.filter((q) => q.t > g.gradTs);
        if (!door) continue;
        // no candle after the door yet = unknown, not "flat"
        g.sinceDoor = after.length ? after[after.length - 1].p / door.p - 1 : null;
        if (g.ret1h === null && nowS - g.gradTs >= 3600) {
          const h = [...pts].reverse().find((q) => q.t <= g.gradTs + 3600);
          if (h && h.t > door.t) {
            g.ret1h = h.p / door.p - 1;
            g.ret1hSrc = "candles";
          }
        }
        const path = [door, ...after].map((q) => q.p);
        const lo = Math.min(...path);
        const hi = Math.max(...path);
        g.path = path.length > 1 ? path.map((p) => (hi === lo ? 500 : Math.round(((p - lo) / (hi - lo)) * 1000))) : [];
      }
    } catch {
      /* no candles: the moves stay unknown (—) */
    }
  }
  return list;
}

/* ---------------- snapshot ---------------- */

let snap: DoorSnap | null = null;
let building: Promise<DoorSnap> | null = null;

async function build(): Promise<DoorSnap> {
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  const notes: string[] = [];
  await loadSamples();
  const [nearR, stR] = await Promise.allSettled([nearList(), peekState()]);

  let near: NearCard[] | null = null;
  let unchecked: NearCard[] = [];
  let total85: number | null = null;
  if (nearR.status === "fulfilled") {
    const cards = nearR.value.items.filter(visible).map(nearCard);
    total85 = nearR.value.more ? null : cards.length;
    if (nearR.value.more) notes.push(`More than ${cards.length} tokens sit at 85%+: the ${cards.length} closest are checked.`);
    // ETA reads for the busiest lines first (last hour's volume); the rest wait for a later round
    const busy = cards
      .filter((c) => c.phase !== "door" && (c.buys1h ?? 0) > 0)
      .sort((a, b) => (b.vol1hEth ?? 0) - (a.vol1hEth ?? 0));
    const pick = new Set(busy.slice(0, FLOW_CAP).map((c) => c.token));
    const paced = await mapLimit(cards, 6, (c) => (pick.has(c.token) || c.buys1h === 0 || c.phase === "door" ? withPace(c, nowS) : Promise.resolve(c)));
    const all = paced.map((c) => sampleDelta(c, now));
    unchecked = all.filter((c) => c.phase === "unknown" && (c.buys1h ?? 0) > 0 && !pick.has(c.token));
    near = all.filter((c) => !unchecked.includes(c));
    await resolveLeavers(new Set(cards.map((c) => c.token)), now);
    // forget tokens that left the 85 %+ list two hours ago (slid back)
    for (const [t, s] of samples) if (!s.length || now - s[s.length - 1][0] > 2 * 3600_000) samples.delete(t);
    void saveSamples();
  } else {
    notes.push("vibe/vibe's list did not answer: tokens near the door are unknown right now.");
  }
  const grads = await gradsFeed(nowS).catch(() => null);
  if (!grads) notes.push("Graduations did not load: unknown right now.");
  const st = stR.status === "fulfilled" ? stR.value : null;
  return { builtAt: now, near, total85, unchecked, grads, stateAt: st?.builtAt ?? null, notes };
}

/** The shared snapshot: fresh for 60 s; callers at the same time share one build. Never throws. */
export function getDoor(): Promise<DoorSnap> {
  if (snap && Date.now() - snap.builtAt < SNAP_TTL) return Promise.resolve(snap);
  if (!building) {
    building = build()
      .then((s) => {
        // a failed list keeps the last good one on screen (marked by its own time)
        if (!s.near && snap?.near && Date.now() - snap.builtAt < 15 * 60_000) s = { ...s, near: snap.near, unchecked: snap.unchecked, total85: snap.total85 };
        if (!s.grads && snap?.grads && Date.now() - snap.builtAt < 15 * 60_000) s = { ...s, grads: snap.grads };
        snap = s;
        return s;
      })
      .finally(() => {
        building = null;
      });
  }
  return building;
}

/** The snapshot if one is ready within `ms` (a stale one is better than a blank page), else null. */
export async function getDoorWithin(ms: number): Promise<DoorSnap | null> {
  const p = getDoor();
  const got = await within(p, ms, null);
  return got ?? snap;
}

/** The last snapshot, never starts a build (for the OG image). */
export function peekDoor(): DoorSnap | null {
  return snap;
}
