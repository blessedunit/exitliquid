// A Map with a hard size cap and per-entry expiry, for caches keyed by attacker-chosen input.
/** Map with a hard size cap and per-entry expiry. Attacker-chosen keys can't grow it unbounded. */
export class BoundedTtlMap<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  has(k: string) {
    return this.get(k) !== undefined;
  }
  set(k: string, v: V, ttlMs: number) {
    this.m.delete(k); // re-insert at the end (insertion order = age)
    this.m.set(k, { v, exp: Date.now() + ttlMs });
    if (this.m.size > this.max) this.prune();
  }
  delete(k: string) {
    this.m.delete(k);
  }
  get size() {
    return this.m.size;
  }
  private prune() {
    const now = Date.now();
    for (const [k, e] of this.m) if (e.exp <= now) this.m.delete(k);
    // still full of live entries: drop the oldest ones
    const over = this.m.size - this.max;
    if (over > 0) {
      let i = 0;
      for (const k of this.m.keys()) {
        if (i++ >= over) break;
        this.m.delete(k);
      }
    }
  }
}
