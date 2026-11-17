// Append-only grade journal (for backtesting grades against what the tokens did later).
// One JSON line per grade that changed (or at most once an hour per token when nothing did):
//   {t, at, rulesV, grade, score, verdict, mcapPair, pairUnit, holders, trades24h, graduated, ageMin}
// File: env GRADE_LOG_PATH, else <cwd>/data/grade-log.jsonl (the site folder, outside src/ and public/, so it is
// never bundled, deployed or copied to the Cloudflare build). Rotated to .1 past 50 MB (one old file kept).
// Writes are queued and appended in the background: never awaited by the loop, never throws into it.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { ScreenerRow } from "@/lib/screener-types";

const FILE = process.env.GRADE_LOG_PATH || path.join(/* turbopackIgnore: true */ process.cwd(), "data", "grade-log.jsonl");
const ROTATE_BYTES = 50 * 1024 * 1024;
const SAME_EVERY_MS = 3600_000;
const FLUSH_MS = 5_000;
const MAX_QUEUE = 5_000;
const MAX_LAST = 20_000;

type LogState = {
  queue: string[];
  /** per token: the logged fingerprint and when */
  last: Map<string, { key: string; at: number }>;
  flushing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  written: number;
  dropped: number;
  bytes: number;
  lastError: string | null;
};
const G = globalThis as unknown as { __exitGradeLog?: LogState };
const S: LogState = (G.__exitGradeLog ??= { queue: [], last: new Map(), flushing: false, timer: null, written: 0, dropped: 0, bytes: 0, lastError: null });

const r2 = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** what counts as "the row changed" (numbers rounded so a wobble in the 5th digit is not a change) */
function fingerprint(r: ScreenerRow): string {
  const m = r.metrics;
  return [r.rulesV, r.grade, r.score, r.verdict, r.graduated ? 1 : 0, m.holders, m.trades24h, m.mcapPair === null ? null : Number(m.mcapPair.toPrecision(3))].join("|");
}

/** queue one line for this graded row (no-op when nothing changed and the token was logged within the hour) */
export function logGrade(r: ScreenerRow): void {
  try {
    if (!r.checkedAt) return;
    const key = fingerprint(r);
    const prev = S.last.get(r.token);
    if (prev && prev.key === key && r.checkedAt - prev.at < SAME_EVERY_MS) return;
    if (S.queue.length >= MAX_QUEUE) {
      S.dropped++;
      return;
    }
    const m = r.metrics;
    S.queue.push(JSON.stringify({
      t: r.token, at: r.checkedAt, rulesV: r.rulesV ?? null, grade: r.grade, score: r.score, verdict: r.verdict,
      mcapPair: r2(m.mcapPair), pairUnit: m.pairUnit, holders: m.holders, trades24h: m.trades24h, graduated: r.graduated, ageMin: r.ageMin,
    }));
    S.last.delete(r.token); // re-insert: insertion order = oldest first, for the cap below
    S.last.set(r.token, { key, at: r.checkedAt });
    if (S.last.size > MAX_LAST) for (const k of [...S.last.keys()].slice(0, S.last.size - MAX_LAST)) S.last.delete(k);
    S.timer ??= setTimeout(() => { S.timer = null; void flush(); }, FLUSH_MS);
  } catch {
    /* never into the loop */
  }
}

async function flush(): Promise<void> {
  if (S.flushing || !S.queue.length) return;
  S.flushing = true;
  const lines = S.queue.splice(0, S.queue.length);
  try {
    await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
    const size = await fs.promises.stat(FILE).then((s) => s.size, () => 0);
    // replaces the older .1; a reader holding the file open (Windows EPERM) must not drop every line from now on
    if (size > ROTATE_BYTES) await fs.promises.rename(FILE, `${FILE}.1`).catch((e) => { S.lastError = `rotate: ${String((e as Error)?.message ?? e).slice(0, 100)}`; });
    const body = lines.join("\n") + "\n";
    await fs.promises.appendFile(FILE, body, "utf8");
    S.written += lines.length;
    S.bytes += Buffer.byteLength(body);
  } catch (e) {
    S.lastError = String((e as Error)?.message ?? e).slice(0, 120);
    S.dropped += lines.length; // a full disk must not grow the queue forever
  } finally {
    S.flushing = false;
    if (S.queue.length) S.timer ??= setTimeout(() => { S.timer = null; void flush(); }, FLUSH_MS);
  }
}

export function gradeLogStats() {
  return { path: FILE, written: S.written, bytes: S.bytes, queued: S.queue.length, dropped: S.dropped, error: S.lastError };
}
