import { describe, expect, it } from 'vitest';
import { RULES, roundAt, roundCycleMs } from '../src';

describe('arena round clock', () => {
  it('defaults to 5 minutes of play whose joins close in the last minute, then a 30 s break', () => {
    expect(RULES.roundMs).toBe(300_000);
    expect(RULES.roundJoinCloseMs).toBe(60_000);
    expect(RULES.roundBreakMs).toBe(30_000);
    expect(roundCycleMs()).toBe(330_000);
  });

  it('aligns rounds to Unix time', () => {
    const t = 1_791_000_123_456;
    const r = roundAt(t);
    expect(r.n).toBe(Math.floor(t / 300_000));
    expect(r.startsAt).toBe(r.n * 300_000);
    expect(r.endsAt).toBe(r.startsAt + 300_000);
    expect(r.joinsCloseAt).toBe(r.endsAt - 60_000);
    expect(r.startsAt).toBeLessThanOrEqual(t);
    expect(t).toBeLessThan(r.endsAt);
  });

  it('opens the next round exactly at the end of the previous one (no break)', () => {
    const start = 600_000 * 3000;
    expect(roundAt(start - 1).n).toBe(roundAt(start).n - 1);
    expect(roundAt(start - 1).endsAt).toBe(start);
    expect(roundAt(start)).toEqual({ n: start / 300_000, startsAt: start, endsAt: start + 300_000, joinsCloseAt: start + 240_000, opensAt: start });
    // the closing instant belongs to the closed window
    const r = roundAt(start);
    expect(roundAt(r.joinsCloseAt).n).toBe(r.n);
    expect(roundAt(r.endsAt - 1).n).toBe(r.n);
  });

  it('takes other lengths (tests, localnet e2e)', () => {
    expect(roundAt(95_000, 30_000, 5_000)).toEqual({ n: 3, startsAt: 90_000, opensAt: 90_000, endsAt: 120_000, joinsCloseAt: 115_000 });
    expect(roundAt(0, 30_000, 0)).toEqual({ n: 0, startsAt: 0, opensAt: 0, endsAt: 30_000, joinsCloseAt: 30_000 });
  });

  describe('the break comes on top of the full play (5:00 + 0:30 = 5:30 cycles)', () => {
    const P = RULES.roundMs;
    const C = RULES.roundJoinCloseMs;
    const B = RULES.roundBreakMs;
    const at = (t: number) => roundAt(t, P, C, B);
    // a slot boundary: a multiple of 330 s
    const n = 5_427_273;
    const slot = n * 330_000;

    it('one slot: break 0:00-0:30, play 0:30-5:30 (5:00), joins open 0:30-4:30, bell at 5:30', () => {
      const r = at(slot + 1_000);
      expect(r).toEqual({ n, startsAt: slot, opensAt: slot + 30_000, joinsCloseAt: slot + 270_000, endsAt: slot + 330_000 });
      expect(r.endsAt - r.opensAt).toBe(300_000); // the full 5:00 of play
      expect(r.joinsCloseAt - r.opensAt).toBe(240_000); // joins open for the first 4:00 of play
      expect(r.endsAt - r.joinsCloseAt).toBe(60_000); // closed in the last 1:00
    });

    it('boundaries: the bell starts the next slot (its break); no off-by-one', () => {
      const r = at(slot);
      expect(at(slot - 1).n).toBe(n - 1);
      expect(at(slot - 1).endsAt).toBe(slot); // the previous round's bell is this slot's start
      expect(at(slot).n).toBe(n);
      expect(at(r.opensAt - 1).opensAt).toBe(r.opensAt); // still the break
      expect(at(r.opensAt).n).toBe(n);
      expect(at(r.joinsCloseAt).n).toBe(n);
      expect(at(r.endsAt - 1).n).toBe(n);
      expect(at(r.endsAt).n).toBe(n + 1);
      expect(at(r.endsAt)).toMatchObject({ startsAt: r.endsAt, opensAt: r.endsAt + 30_000, endsAt: r.endsAt + 330_000 });
    });

    it('joins are open only in [opensAt, joinsCloseAt): closed in the last minute of play and in the break', () => {
      const open = (t: number) => {
        const w = at(t);
        return t >= w.opensAt && t < w.joinsCloseAt;
      };
      expect(open(slot)).toBe(false); // the break right after the bell
      expect(open(slot + 29_999)).toBe(false);
      expect(open(slot + 30_000)).toBe(true); // play starts
      expect(open(slot + 269_999)).toBe(true);
      expect(open(slot + 270_000)).toBe(false); // the last minute
      expect(open(slot + 329_999)).toBe(false);
      expect(open(slot + 330_000)).toBe(false); // the next break
    });

    it('an example UTC timeline', () => {
      // 2026-11-09T12:00:00Z (1_794_225_600_000 ms) falls in the slot of round 5_437_047
      const r = at(Date.UTC(2026, 10, 9, 12, 0, 0));
      expect(r.n).toBe(5_437_047);
      const iso = (ms: number) => new Date(ms).toISOString().slice(11, 19);
      expect([iso(r.startsAt), iso(r.opensAt), iso(r.joinsCloseAt), iso(r.endsAt)]).toEqual(['11:58:30', '11:59:00', '12:03:00', '12:04:00']);
    });

    it('never closes joins before the play starts', () => {
      expect(roundAt(0, 10_000, 15_000, 9_000)).toEqual({ n: 0, startsAt: 0, opensAt: 9_000, joinsCloseAt: 9_000, endsAt: 19_000 });
    });
  });
});
