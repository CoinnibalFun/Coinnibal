/** Tiny fixed-window limiter for REST endpoints (per key: an IP or a wallet). */
export class Limiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    /** Keys tracked at most (expired, then oldest windows are evicted beyond it). */
    private readonly maxKeys = 10_000,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      if (h) this.hits.delete(key);
      if (this.hits.size >= this.maxKeys) this.evict(now);
      // re-inserted: Map order stays oldest window first
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }

  /** Tracked keys (tests). */
  get size(): number {
    return this.hits.size;
  }

  /**
   * Makes room without resetting every counter: drops expired windows, then (still full) the oldest
   * windows of keys still under their limit, and only when every tracked key is over its limit the
   * oldest of those. A flood of fresh keys therefore never lifts the block of a rate-limited key.
   */
  private evict(now: number): void {
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    if (this.hits.size < this.maxKeys) return;
    let drop = Math.max(1, Math.floor(this.maxKeys / 10));
    for (const [k, v] of this.hits) {
      if (drop <= 0) return;
      if (v.n <= this.max) {
        this.hits.delete(k);
        drop--;
      }
    }
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) return;
      this.hits.delete(k);
    }
  }
}

/**
 * Per-key token buckets: `rate` tokens a second, at most `burst` saved up. A smooth bound: unlike `Limiter`'s fixed
 * window, a key that spent its burst gets one token per `1 / rate` seconds, never a whole new window at once, so a few
 * keys cannot take a shared pool in bursts every minute. A key not tracked (never seen, or dropped) has a full bucket.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly rate: number,
    readonly burst: number,
    /** Keys tracked at most (full buckets, then the least recently used ones, are dropped beyond it). */
    private readonly maxKeys = 10_000,
  ) {}

  /** The tokens `key` holds now (refilled up to `burst`). */
  tokens(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b) return this.burst;
    return Math.min(this.burst, b.tokens + (Math.max(0, now - b.at) / 1000) * this.rate);
  }

  /** Whether `key` has a whole token now (none is taken). */
  has(key: string, now = Date.now()): boolean {
    return this.tokens(key, now) >= 1;
  }

  /** Whether `key`'s bucket is full: it took no token for `burst / rate` seconds. */
  full(key: string, now = Date.now()): boolean {
    return this.tokens(key, now) >= this.burst;
  }

  /** Takes one token of `key` (callers check `has` first). */
  take(key: string, now = Date.now()): void {
    const tokens = this.tokens(key, now) - 1;
    this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) this.evict(now);
    // re-inserted: Map order stays least recently used first
    this.buckets.set(key, { tokens, at: now });
  }

  /** `has`, then `take`. */
  allow(key: string, now = Date.now()): boolean {
    if (!this.has(key, now)) return false;
    this.take(key, now);
    return true;
  }

  /** Tracked keys (tests). */
  get size(): number {
    return this.buckets.size;
  }

  /** Drops full buckets (they hold nothing a new one would not), then the least recently used tenth. */
  private evict(now: number): void {
    for (const k of [...this.buckets.keys()]) if (this.full(k, now)) this.buckets.delete(k);
    if (this.buckets.size < this.maxKeys) return;
    let drop = Math.max(1, Math.floor(this.maxKeys / 10));
    for (const k of this.buckets.keys()) {
      if (drop-- <= 0) return;
      this.buckets.delete(k);
    }
  }
}
