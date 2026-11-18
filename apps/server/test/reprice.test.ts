import { roundAt } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import type { ChainArena } from '../src/chain/types';
import { RepriceScheduler } from '../src/site/reprice';
import { Journal } from '../src/stake/journal';

const ROUND = 300_000;
const CLOSE = 60_000;

function setup() {
  const clock = { now: 1_800_000_000_000 - (1_800_000_000_000 % ROUND) + 10_000 }; // 10 s into a round
  const arenas: ChainArena[] = [{ id: 1, entryFee: 10_000, maxSessions: 0, openSessions: 3, enabled: true, pot: 0 }];
  const live = { n: 2 };
  const logs: string[] = [];
  let sweeps = 0;
  const journal = new Journal(null);
  const r = new RepriceScheduler({
    listArenas: async () => arenas.map((a) => ({ ...a })),
    journal,
    roundWindow: (n = clock.now) => roundAt(n, ROUND, CLOSE),
    now: () => clock.now,
    liveStakes: () => live.n,
    sweepNow: () => sweeps++,
    file: null,
    log: (m) => logs.push(m),
  });
  return { clock, arenas, live, logs, r, sweeps: () => sweeps, journal };
}

describe('Re-price at next bell', () => {
  it('closes joins at the last minute, drains after the bell, is ready to sign, opens once the new price is on chain', async () => {
    const h = setup();
    await h.r.schedule([1], '0xOwner');
    expect(h.r.view()[0].phase).toBe('waiting');
    expect(h.r.closedForSeats(1)).toBe(false);
    // the round's last minute: joins close (they do anyway); the bell is waited for
    h.clock.now += ROUND - CLOSE - 10_000;
    await h.r.tick();
    expect(h.r.view()[0]).toMatchObject({ phase: 'closing', bellAt: roundAt(h.clock.now, ROUND, CLOSE).endsAt });
    // the bell: the break after it does not reopen the arena; the unseated tickets are cancelled at once
    h.clock.now += CLOSE + 1_000;
    await h.r.tick();
    expect(h.r.view()[0].phase).toBe('draining');
    expect(h.r.closedForSeats(1)).toBe(true);
    expect(h.r.closedArenas()).toEqual(new Set([1]));
    expect(h.sweeps()).toBeGreaterThanOrEqual(1);
    expect(h.r.view()[0].open).toEqual({ onChain: 3, journal: 0, live: 2 });
    // the bell settled the coins, the sweeper cancelled the unplayed ticket: nothing is open
    h.live.n = 0;
    h.arenas[0].openSessions = 0;
    h.clock.now += 6_000;
    await h.r.tick();
    expect(h.r.view()[0].phase).toBe('ready');
    expect(h.logs.join('\n')).toMatch(/READY TO SIGN/);
    // a ticket bought meanwhile on chain: back to draining
    h.arenas[0].openSessions = 1;
    h.clock.now += 6_000;
    await h.r.tick();
    expect(h.r.view()[0].phase).toBe('draining');
    h.arenas[0].openSessions = 0;
    h.clock.now += 6_000;
    await h.r.tick();
    expect(h.r.view()[0].phase).toBe('ready');
    // the owner signed updateArena: the new entry fee is on chain, the arena opens again
    h.arenas[0].entryFee = 12_000;
    h.clock.now += 6_000;
    await h.r.tick();
    expect(h.r.view()).toEqual([]);
    expect(h.r.closedForSeats(1)).toBe(false);
  });

  it('asked during the last minute it waits for this bell; cancel opens it again; an unknown arena is refused', async () => {
    const h = setup();
    h.clock.now += ROUND - CLOSE;
    await h.r.schedule([1], '0xOwner');
    expect(h.r.view()[0].phase).toBe('closing');
    h.r.cancel([1], '0xOwner');
    expect(h.r.view()).toEqual([]);
    await expect(h.r.schedule([9], '0xOwner')).rejects.toThrow(/does not exist/);
  });
});
