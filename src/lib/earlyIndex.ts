// The Early Index (sniper / farm / verified-early wallet labels), read at RUNTIME from disk.
// the hourly index job rewrites the JSON every hour (atomic temp + rename); before, the file was imported and baked
// into the build, so a fresh index needed a rebuild. Now:
// - path: env EARLY_INDEX_PATH, else <cwd>/src/data/early-index.json (next start runs in the project dir);
// - the file's mtime is checked at most once a minute, the JSON re-read only when it changed;
// - an unreadable / broken file keeps the last good copy; with none yet, the copy bundled at build time.
// Every call returns the same object until the file changes: per-index derived data can sit in a WeakMap.
// Server only.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import bundled from "@/data/early-index.json";
import type { EarlyIndex } from "./health";

export type EarlyIndexFile = EarlyIndex & { headBlock?: number };

const CHECK_MS = 60_000;
const FILE = process.env.EARLY_INDEX_PATH || path.join(/* turbopackIgnore: true */ process.cwd(), "src", "data", "early-index.json");

function valid(x: unknown): x is EarlyIndexFile {
  const o = x as Partial<EarlyIndexFile> | null;
  return !!o && typeof o.generatedAt === "number" && o.generatedAt > 0 && Array.isArray(o.snipers) && Array.isArray(o.farms);
}
function normalize(o: EarlyIndexFile): EarlyIndexFile {
  // older files may lack a field: an empty list, never a crash in a consumer
  return { ...o, verifiedEarly: Array.isArray(o.verifiedEarly) ? o.verifiedEarly : [] };
}

const BUNDLED: EarlyIndexFile = normalize(bundled as unknown as EarlyIndexFile);
let current: EarlyIndexFile = BUNDLED;
let source: "disk" | "bundled" = "bundled";
let mtimeMs = -1;
let checkedAt = 0;

function refresh() {
  try {
    const st = fs.statSync(FILE);
    if (st.mtimeMs === mtimeMs) return;
    const j: unknown = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!valid(j)) throw new Error("bad early index");
    mtimeMs = st.mtimeMs;
    // the file on disk is the source of truth, even when it is older than the one in memory:
    // that is how a bad build gets rolled back (the hourly index job has its own sanity check before writing)
    current = normalize(j);
    source = "disk";
  } catch {
    /* unreadable or half-written: keep what we have (last good disk copy, or the bundled one) */
  }
}

/** The current Early Index (same object until the file on disk changes). */
export function earlyIndex(): EarlyIndexFile {
  const now = Date.now();
  if (now - checkedAt >= CHECK_MS) {
    checkedAt = now;
    refresh();
  }
  return current;
}

/** Where the index in memory came from: the file on disk or the copy bundled into the build. */
export function earlyIndexSource(): "disk" | "bundled" {
  earlyIndex();
  return source;
}

/** seconds since the index in memory was built */
export function earlyIndexAgeSec(nowSec = Math.floor(Date.now() / 1000)): number {
  return Math.max(0, nowSec - earlyIndex().generatedAt);
}

const derived = new WeakMap<object, Map<string, unknown>>();
/** `make(ix)` once per index build and key: label sets etc. are rebuilt only when the index changes. */
export function perIndex<T>(key: string, make: (ix: EarlyIndexFile) => T): T {
  const ix = earlyIndex();
  let m = derived.get(ix);
  if (!m) derived.set(ix, (m = new Map()));
  if (!m.has(key)) m.set(key, make(ix));
  return m.get(key) as T;
}
