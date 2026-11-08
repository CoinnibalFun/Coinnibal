/**
 * One emblem, one holder perk at a time (the audit's "emblem passed around" finding, AuditFindings.t.sol): a token id
 * serves one open holder ticket, the holder discount on power-ups and the free daily room go to one wallet per token
 * id a day.
 */
import { describe, expect, it } from 'vitest';
import type { ChainArena, ChainGateway, ChainSession } from '../src/chain/types';
import type { Candidate } from '../src/integrity/detectors';
import { EmblemClaims } from '../src/site/emblem-claims';
import { EmblemGate } from '../src/site/emblem-gate';
import { Journal } from '../src/stake/journal';
import { testSigner } from './signers';

const FEES = { burnBps: 1500, vaultBps: 500, holderBurnBps: 800, holderVaultBps: 200, holderPerks: true, paymentBurnBps: 5000, burnMode: 0 };
const HOLDER = { burnBps: 800, vaultBps: 200 };
const NORMAL = { burnBps: 1500, vaultBps: 500 };

function setup(arenas: ChainArena[] = [{ id: 1, entryFee: 10, maxSessions: 0, openSessions: 0, enabled: true, pot: 0 }]) {
  const owners = new Map<string, string>(); // token id -> wallet (lower)
  const journal = new Journal(null);
  const flags: Candidate[] = [];
  const logs: string[] = [];
  const live = new Set<string>();
  let now = 1_800_000_000_000;
  const claims = new EmblemClaims(null, () => {}, () => now);
  const chain = { status: () => ({ fees: FEES }), listArenas: async () => arenas, kick: () => {} } as unknown as ChainGateway;
  const tokensOf = (w: string) => [...owners].filter(([, o]) => o === w.toLowerCase()).map(([id]) => id);
  const gate = new EmblemGate({
    chain,
    journal,
    claims,
    isHolder: async (w) => tokensOf(w).length > 0,
    emblemTokens: async (w) => tokensOf(w),
    flag: (c) => flags.push(c),
    liveSessions: () => live,
    log: (m) => logs.push(m),
    now: () => now,
  });
  return { owners, journal, flags, logs, live, claims, gate, tick: (ms: number) => (now += ms), tokensOf };
}

let seq = 1;
const ticket = (player: string, rates = HOLDER, arenaId = 1): ChainSession => {
  const id = seq++;
  return { key: `${arenaId}:${player.toLowerCase()}:${id}`, id, player, arenaId, entryFee: 10_000_000, rates, value: 10_000_000, openedAt: 0, finalized: false, owed: 0 };
};

describe('one emblem token id serves one open holder ticket', () => {
  it('the emblem passed on while its ticket is open: the second holder ticket is refused, refunded in full, and flagged', async () => {
    const h = setup();
    const a = testSigner().address;
    const b = testSigner().address;
    h.owners.set('7', a.toLowerCase());
    const ta = ticket(a);
    expect(await h.gate.seat(a, ta)).toBeNull();
    expect(h.claims.ticketOf('7')?.session).toBe(ta.key);
    // A passes the emblem to B (one transfer) while A's coin plays on; B bought a ticket at the holder rate
    h.owners.set('7', b.toLowerCase());
    const tb = ticket(b);
    const refused = await h.gate.seat(b, tb);
    expect(refused).toMatchObject({ code: 'game_closed', message: expect.stringMatching(/already serves another open holder ticket/) });
    // B's ticket goes back in full at once (a `cancel`: reason stale, payout = the entry fee)
    expect(h.journal.pending).toEqual([expect.objectContaining({ key: tb.key, reason: 'stale', payout: tb.entryFee })]);
    expect(h.flags).toEqual([expect.objectContaining({ subtype: 'emblem_shared', id: 'emblem_shared:7', wallets: [b.toLowerCase(), a.toLowerCase()] })]);
    // once A's ticket is settled, the emblem serves B's next ticket
    h.gate.settled(ta.key);
    const tb2 = ticket(b);
    expect(await h.gate.seat(b, tb2)).toBeNull();
    expect(h.claims.ticketOf('7')?.session).toBe(tb2.key);
  });

  it('a ticket with the normal rates in an open arena is not a holder ticket: no claim, no check', async () => {
    const h = setup();
    const a = testSigner().address;
    expect(await h.gate.seat(a, ticket(a, NORMAL))).toBeNull();
    expect(h.claims.tickets()).toEqual([]);
  });

  it('a holders-only arena: a ticket of a wallet that no longer holds the emblem is refused and refunded', async () => {
    const h = setup([{ id: 4, entryFee: 10, maxSessions: 0, openSessions: 0, enabled: true, pot: 0, holdersOnly: true }]);
    const a = testSigner().address;
    const t = ticket(a, NORMAL, 4);
    const refused = await h.gate.seat(a, t);
    expect(refused).toMatchObject({ code: 'game_closed', message: expect.stringMatching(/needs an Elymum emblem/) });
    expect(h.journal.pending).toEqual([expect.objectContaining({ key: t.key, reason: 'stale' })]);
  });

  it('two emblems in one wallet serve two open holder tickets; a reseat of the same ticket keeps its token', async () => {
    const h = setup();
    const a = testSigner().address;
    h.owners.set('1', a.toLowerCase());
    h.owners.set('2', a.toLowerCase());
    const t1 = ticket(a);
    const t2 = { ...ticket(a), arenaId: 2, key: `2:${a.toLowerCase()}:${seq++}` };
    expect(await h.gate.seat(a, t1)).toBeNull();
    expect(await h.gate.seat(a, t1)).toBeNull();
    expect(await h.gate.seat(a, t2)).toBeNull();
    expect(h.claims.tickets().map((t) => t.tokenId).sort()).toEqual(['1', '2']);
  });

  it('a claim whose ticket is gone (neither seated nor in the journal) is let go after 10 minutes', async () => {
    const h = setup();
    const a = testSigner().address;
    h.owners.set('9', a.toLowerCase());
    const t = ticket(a);
    expect(await h.gate.seat(a, t)).toBeNull();
    h.live.add(t.key);
    h.tick(11 * 60_000);
    expect(h.gate.sweep()).toBe(0);
    h.live.delete(t.key);
    expect(h.gate.sweep()).toBe(1);
    expect(h.claims.ticketOf('9')).toBeNull();
  });
});

describe('daily holder perks: one wallet per token id a day', () => {
  it('the power-up discount and the free room follow the token id, not the wallet', () => {
    let now = Date.UTC(2026, 10, 6, 12);
    const claims = new EmblemClaims(null, () => {}, () => now);
    const a = testSigner().address;
    const b = testSigner().address;
    expect(claims.daily('shop', a, ['5'], true)).toBe('5');
    expect(claims.daily('shop', a, ['5'], true)).toBe('5'); // the same wallet again: fine
    expect(claims.daily('shop', b, ['5'])).toBeNull(); // passed on the same day: no discount
    expect(claims.daily('room', b, ['5'], true)).toBe('5'); // another perk is counted apart
    now += 12 * 3600_000; // the next UTC day
    expect(claims.daily('shop', b, ['5'], true)).toBe('5');
  });
});
