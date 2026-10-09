// What the in-memory caches last did, for /status. Kept on globalThis: route handlers and pages can get
// separate copies of a module in one process, and /status must see the refreshes any of them made.
// Writing a beat is a map set: no I/O, safe on every hot path.
export type Beat = { okAt: number; failAt: number; err: string | null; n: number };

const G = globalThis as { __exitBeats?: Map<string, Beat> };
const beats = (G.__exitBeats ??= new Map<string, Beat>());

/** record one refresh of a cache: ok, or failed with a short reason */
export function beat(name: string, ok: boolean, err?: unknown) {
  const b = beats.get(name) ?? { okAt: 0, failAt: 0, err: null, n: 0 };
  if (ok) b.okAt = Date.now();
  else {
    b.failAt = Date.now();
    b.err = String((err as Error)?.message ?? err ?? "failed").slice(0, 120);
  }
  b.n++;
  beats.set(name, b);
}

export function readBeat(name: string): Beat | null {
  const b = beats.get(name);
  return b ? { ...b } : null;
}
