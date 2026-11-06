import { describe, expect, it } from 'vitest';
import { drill, type PathProfile } from './netsim';

const PROFILES: { name: string; p: PathProfile }[] = [
  { name: 'clean (10 ms)', p: { rttMs: 10, loss: 0 } },
  { name: '150 ms RTT, 2 % loss', p: { rttMs: 150, loss: 0.02 } },
  { name: '180 ms RTT, 2 % loss', p: { rttMs: 180, loss: 0.02 } },
];

describe('network drill: the jitter buffer on a lossy path', () => {
  it('reports freezes per minute, before (direct) and after (buffered)', () => {
    const rows = PROFILES.map(({ name, p }) => {
      // five seeds of a minute each
      const runs = (mode: 'direct' | 'buffered') => [1, 2, 3, 4, 5].map((seed) => drill(mode, p, 62, seed));
      const avg = (rs: ReturnType<typeof drill>[], k: keyof ReturnType<typeof drill>) => rs.reduce((s, r) => s + r[k], 0) / rs.length;
      const d = runs('direct');
      const b = runs('buffered');
      return {
        name,
        directFreezes: avg(d, 'freezesPerMin'),
        bufferedFreezes: avg(b, 'freezesPerMin'),
        directHitches: avg(d, 'hitchesPerMin'),
        bufferedHitches: avg(b, 'hitchesPerMin'),
        directJumps: avg(d, 'jumpsPerMin'),
        bufferedJumps: avg(b, 'jumpsPerMin'),
        directLongest: Math.max(...d.map((r) => r.longestStillMs)),
        bufferedLongest: Math.max(...b.map((r) => r.longestStillMs)),
        directErr: avg(d, 'meanErr'),
        bufferedErr: avg(b, 'meanErr'),
      };
    });
    if (process.env.NETSIM_REPORT) console.log(JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v]))), null, 1));
    const target = rows[1];
    expect(target.bufferedFreezes).toBeLessThan(target.directFreezes / 4);
    expect(target.bufferedFreezes).toBeLessThan(1);
    expect(target.bufferedHitches).toBeLessThan(target.directHitches / 4);
    // and the drawn coin stays as close to the server's as before (the delay is paid back by easing over the real step)
    expect(target.bufferedErr).toBeLessThan(target.directErr * 1.25);
    // a clean path never freezes either way
    expect(rows[0].bufferedFreezes).toBe(0);
  });
});
