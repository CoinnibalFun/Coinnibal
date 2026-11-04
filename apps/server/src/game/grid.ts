export interface Gridded {
  x: number;
  y: number;
  /** Bucket index inside the grid that owns this item (-1 when not inserted). */
  gk: number;
}

/**
 * Uniform spatial hash keyed by an item's centre. Queries return items whose
 * centre lies in the buckets overlapping the rectangle; callers expand the
 * rectangle by the largest radius they care about and filter precisely.
 */
export class Grid<T extends Gridded> {
  readonly cols: number;
  readonly rows: number;
  private readonly buckets: T[][];
  /** Buckets that may hold items since the last `clear` (so `clear` skips the empty ones). */
  private readonly used: number[] = [];
  private readonly usedFlag: Uint8Array;
  size = 0;

  constructor(
    width: number,
    height: number,
    readonly cellSize = 256,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
    this.usedFlag = new Uint8Array(this.cols * this.rows);
  }

  private touch(k: number): void {
    if (this.usedFlag[k] === 0) {
      this.usedFlag[k] = 1;
      this.used.push(k);
    }
  }

  private col(x: number): number {
    const c = Math.floor(x / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private row(y: number): number {
    const r = Math.floor(y / this.cellSize);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  private keyOf(x: number, y: number): number {
    return this.row(y) * this.cols + this.col(x);
  }

  insert(item: T): void {
    const k = this.keyOf(item.x, item.y);
    item.gk = k;
    this.buckets[k].push(item);
    this.touch(k);
    this.size++;
  }

  remove(item: T): void {
    if (item.gk < 0) return;
    const bucket = this.buckets[item.gk];
    const i = bucket.indexOf(item);
    if (i >= 0) {
      const last = bucket.pop()!;
      if (i < bucket.length) bucket[i] = last;
      this.size--;
    }
    item.gk = -1;
  }

  /** Re-buckets an item after it moved. */
  update(item: T): void {
    const k = this.keyOf(item.x, item.y);
    if (k === item.gk) return;
    this.remove(item);
    item.gk = k;
    this.buckets[k].push(item);
    this.touch(k);
    this.size++;
  }

  /** Empties the grid: only the buckets used since the last clear are visited (the dynamic grid is rebuilt every tick). */
  clear(): void {
    for (const k of this.used) {
      const b = this.buckets[k];
      for (const item of b) item.gk = -1;
      b.length = 0;
      this.usedFlag[k] = 0;
    }
    this.used.length = 0;
    this.size = 0;
  }

  /** Calls `fn` for every item whose bucket overlaps the rectangle. Return `true` to stop early. */
  forEachIn(x0: number, y0: number, x1: number, y1: number, fn: (item: T) => boolean | void): void {
    const c0 = this.col(x0);
    const c1 = this.col(x1);
    const r0 = this.row(y0);
    const r1 = this.row(y1);
    for (let r = r0; r <= r1; r++) {
      const base = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const bucket = this.buckets[base + c];
        // iterate backwards so callers may remove the current item safely
        for (let i = bucket.length - 1; i >= 0; i--) {
          const item = bucket[i];
          if (item === undefined) continue;
          if (fn(item) === true) return;
        }
      }
    }
  }
}
