import { TICK_MS } from '@elymum/shared';
import { describe, expect, it } from 'vitest';
import { RENDER_DELAY_MS, SnapshotTimeline } from '../src/game/jitter';

describe('SnapshotTimeline (the jitter buffer)', () => {
  it('releases each snapshot RENDER_DELAY_MS after its place on the timeline, in order', () => {
    const tl = new SnapshotTimeline<number>();
    // ticks 1..3 arrive 50 ms after the server sent them
    tl.push(1, 1, TICK_MS + 50);
    tl.push(2, 2, 2 * TICK_MS + 50);
    tl.push(3, 3, 3 * TICK_MS + 50);
    expect(tl.due(TICK_MS + 50 + RENDER_DELAY_MS - 1)).toEqual([]);
    const first = tl.due(TICK_MS + 50 + RENDER_DELAY_MS);
    expect(first.map((d) => d.item)).toEqual([1]);
    expect(first[0].step).toBeCloseTo(TICK_MS);
    // (the offset creeps up a quarter of a millisecond per snapshot)
    expect(tl.due(3 * TICK_MS + 50 + RENDER_DELAY_MS + 1).map((d) => d.item)).toEqual([2, 3]);
    expect(tl.size).toBe(0);
  });

  it('hides arrival jitter: a burst after a stall plays at the snapshots own times', () => {
    const tl = new SnapshotTimeline<number>();
    tl.push(1, 1, TICK_MS + 40);
    // ticks 2..4 were held by a retransmission and land together, 90 ms late
    for (const k of [2, 3, 4]) tl.push(k, k, 4 * TICK_MS + 40 + 90);
    const at = (k: number) => k * TICK_MS + 40 + RENDER_DELAY_MS + 1;
    expect(tl.due(at(1)).map((d) => d.item)).toEqual([1]);
    expect(tl.due(at(2)).map((d) => d.item)).toEqual([2]);
    expect(tl.due(at(3)).map((d) => d.item)).toEqual([3]);
    expect(tl.due(at(4)).map((d) => d.item)).toEqual([4]);
  });

  it('follows the fastest path: the offset snaps down to an earlier arrival and creeps up slowly', () => {
    const tl = new SnapshotTimeline<number>();
    // the first snapshot came late (120 ms), the next ones in 40 ms
    tl.push(1, 1, TICK_MS + 120);
    tl.push(2, 2, 2 * TICK_MS + 40);
    // never released before the one ahead of it
    const both = tl.due(2 * TICK_MS + 120 + RENDER_DELAY_MS);
    expect(both.map((d) => d.item)).toEqual([1, 2]);
    // a path that got slower for good: later snapshots still play, a little late at first
    for (let k = 3; k < 200; k++) tl.push(k, k, k * TICK_MS + 140);
    expect(tl.due(199 * TICK_MS + 140 + RENDER_DELAY_MS, false).length).toBe(197);
  });

  it('restarts on another room (its ticks jump), and drains everything for a hidden tab', () => {
    const tl = new SnapshotTimeline<string>();
    tl.push('a', 5000, 5000 * TICK_MS + 30);
    tl.push('b', 12, 1_000_000);
    // the old room's snapshot is gone; the new one has its own offset
    const d = tl.due(1_000_000 + RENDER_DELAY_MS);
    expect(d.map((x) => x.item)).toEqual(['b']);
    tl.push('c', 13, 1_000_000 + TICK_MS);
    tl.push('d', 14, 1_000_000 + 2 * TICK_MS);
    expect(tl.due(0, true).map((x) => x.item)).toEqual(['c', 'd']);
    tl.push('e', 15, 1_000_000 + 3 * TICK_MS);
    tl.clear();
    expect(tl.size).toBe(0);
  });

  it('a skipped snapshot (a slow socket) eases over the whole gap, within bounds', () => {
    const tl = new SnapshotTimeline<number>();
    tl.push(1, 1, TICK_MS);
    tl.push(3, 3, 3 * TICK_MS);
    tl.push(30, 30, 30 * TICK_MS);
    const d = tl.due(30 * TICK_MS + RENDER_DELAY_MS + 1);
    expect(d[1].step).toBeCloseTo(2 * TICK_MS);
    expect(d[2].step).toBe(150);
  });
});
