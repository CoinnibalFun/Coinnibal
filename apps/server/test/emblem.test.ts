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

function setup(arenas: ChainArena[] = [{ id: 1, entryFee: 10, maxSessions: 0, openSessions: 0, enabled: true, pot: 0 }], o: { noShow?: (s: ChainSession) => boolean; index?: boolean } = {}) {
  const owners = new Map<string, string>(); // token id -> wallet (lower)
  const journal = new Journal(null);
  const flags: Candidate[] = [];
  const logs: string[] = [];
  const live = new Set<string>();
  let now = 1_800_000_000_000;
  const claims = new EmblemClaims(null, () => {}, () => now);
  /** `excuseNoShow` calls: `<arenaId>:<player lower>` (the stale sweeper's refund of that ticket is then no no-show). */
  const excused: string[] = [];
  const chain = {
    status: () => ({ fees: FEES }),
    listArenas: async () => arenas,
    kick: () => {},
    excuseNoShow: (arenaId: number, player: string) => excused.push(`${arenaId}:${player.toLowerCase()}`),
  } as unknown as ChainGateway;
  const tokensOf = (w: string) => [...owners].filter(([, o]) => o === w.toLowerCase()).map(([id]) => id);
  const gate = new EmblemGate({
    chain,
    journal,
    claims,
    isHolder: async (w) => tokensOf(w).length > 0,
    // `index: false`: the token index cannot tell (never read, the RPC refuses logs)
    emblemTokens: async (w) => (o.index === false ? null : tokensOf(w)),
    flag: (c) => flags.push(c),
    liveSessions: () => live,
    noShow: o.noShow,
    log: (m) => logs.push(m),
    now: () => now,
  });
  return { owners, journal, flags, logs, live, claims, gate, excused, tick: (ms: number) => (now += ms), tokensOf };
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
    expect(refused).toMatchObject({ code: 'game_closed', message: expect.stringMatching(/needs a Coinnibal NFT/) });
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

describe('a holder ticket refused at its seat is a no-show when the player moved its emblem (audit R4-M1)', () => {
  it('one emblem passed from wallet to wallet cannot refund unplayed holder tickets past the no-show rules', async () => {
    const h = setup(undefined, { noShow: () => true });
    const a = testSigner().address;
    const b = testSigner().address;
    const c = testSigner().address;
    h.owners.set('7', a.toLowerCase());
    const ta = ticket(a);
    expect(await h.gate.seat(a, ta)).toBeNull();
    // the emblem goes to B, which bought a holder ticket with it: refused, back in full, a no-show
    h.owners.set('7', b.toLowerCase());
    const tb = ticket(b);
    expect(await h.gate.seat(b, tb)).toMatchObject({ code: 'game_closed' });
    expect(h.journal.pending).toEqual([expect.objectContaining({ key: tb.key, reason: 'stale', noShow: true })]);
    // then to C; B's next holder ticket finds no emblem in B's wallet: a no-show too
    h.owners.set('7', c.toLowerCase());
    const tb2 = { ...ticket(b), arenaId: 1 };
    h.journal.remove(tb.key);
    expect(await h.gate.seat(b, tb2)).toMatchObject({ message: expect.stringMatching(/needs a Coinnibal NFT/) });
    expect(h.journal.pending).toEqual([expect.objectContaining({ key: tb2.key, reason: 'stale', payout: tb2.entryFee, noShow: true })]);
    expect(h.logs.some((m) => /already serves/.test(m) && /a no-show/.test(m))).toBe(true);
  });

  it('never a no-show when the server cannot tell, or the arena takes no seat (or the server owes the excuse)', async () => {
    // the token index cannot confirm that the wallet holds none (a failed `balanceOf` reads as "none")
    const unsure = setup(undefined, { noShow: () => true, index: false });
    const a = testSigner().address;
    const ta = ticket(a);
    expect(await unsure.gate.seat(a, ta)).toMatchObject({ code: 'game_closed' });
    expect(unsure.journal.pending).toHaveLength(1);
    expect(unsure.journal.pending[0]).not.toHaveProperty('noShow');
    // the arena is closed or the server refused this ticket a seat before: the caller says so
    const closed = setup(undefined, { noShow: () => false });
    const b = testSigner().address;
    const tb = ticket(b);
    expect(await closed.gate.seat(b, tb)).toMatchObject({ code: 'game_closed' });
    expect(closed.journal.pending[0]).not.toHaveProperty('noShow');
  });
});

describe('a holder\'s own last game still holding its emblem is no no-show (audit R4b-M2)', () => {
  /** The bell: `t`'s coin leaves its room and its settlement waits in the journal (RPC back-off, a batch, a payout held). */
  const bell = (h: ReturnType<typeof setup>, t: ChainSession) => {
    h.live.delete(t.key);
    h.journal.commit({
      enqueue: [
        { kind: 'settle', key: t.key, player: t.player, arenaId: t.arenaId, session: t.key, sessionId: t.id, payout: 12_000_000, entryFee: t.entryFee, score: 1, kills: 0, xp: 0, reason: 'round', attempts: 0, nextAttemptAt: 0, createdAt: 0 },
      ],
    });
  };

  it('one emblem, its arena-1 settlement pending: the arena-2 seat waits, the ticket is kept and excused, and seats once settled', async () => {
    const h = setup(undefined, { noShow: () => true });
    const a = testSigner().address;
    h.owners.set('7', a.toLowerCase());
    const t1 = ticket(a, HOLDER, 1);
    expect(await h.gate.seat(a, t1)).toBeNull();
    h.live.add(t1.key);
    bell(h, t1);
    h.tick(30_000);
    const t2 = ticket(a, HOLDER, 2);
    const refused = await h.gate.seat(a, t2);
    expect(refused).toEqual({ code: 'emblem_busy', message: expect.stringMatching(/^Your last game \(arena #1\) is still being settled.+This ticket stays yours: try again in a moment\.$/) });
    // nothing queued for the arena-2 ticket (no refund, no no-show), and its refund, should it never sit, is excused
    expect(h.journal.pending.map((p) => p.key)).toEqual([t1.key]);
    expect(h.excused).toEqual([`2:${a.toLowerCase()}`]);
    expect(h.flags).toEqual([]);
    expect(h.logs.some((m) => /a no-show/.test(m))).toBe(false);
    // the arena-1 settlement is mined (its Settled event frees the emblem): the arena-2 ticket seats on the next try
    h.journal.remove(t1.key);
    h.gate.settled(t1.key);
    expect(await h.gate.seat(a, t2)).toBeNull();
    expect(h.claims.ticketOf('7')?.session).toBe(t2.key);
  });

  it('one emblem playing in arena 1 now: an arena-2 seat waits (excused); a claim of its own ticket not seated waits without the excuse', async () => {
    const h = setup(undefined, { noShow: () => true });
    const a = testSigner().address;
    h.owners.set('7', a.toLowerCase());
    const t1 = ticket(a, HOLDER, 1);
    expect(await h.gate.seat(a, t1)).toBeNull();
    h.live.add(t1.key);
    const t2 = ticket(a, HOLDER, 2);
    expect(await h.gate.seat(a, t2)).toMatchObject({ code: 'emblem_busy', message: expect.stringMatching(/serves your game in arena #1/) });
    expect(h.excused).toEqual([`2:${a.toLowerCase()}`]);
    expect(h.journal.pending).toEqual([]);
    // the emblem check passed for t1 but its seat never happened (the round closed meanwhile): t3 waits, not excused,
    // since sitting with t1 is the player's way on (and a refused seat must not buy excuses for every other arena)
    h.live.delete(t1.key);
    const t3 = ticket(a, HOLDER, 3);
    expect(await h.gate.seat(a, t3)).toMatchObject({ code: 'emblem_busy', message: expect.stringMatching(/not seated yet/) });
    expect(h.excused).toEqual([`2:${a.toLowerCase()}`]);
    expect(h.journal.pending).toEqual([]);
  });

  it('an emblem of another wallet among the claims is still the passed-on case: a no-show', async () => {
    const h = setup(undefined, { noShow: () => true });
    const a = testSigner().address;
    const b = testSigner().address;
    h.owners.set('7', a.toLowerCase());
    h.owners.set('8', b.toLowerCase());
    const ta = ticket(a, HOLDER, 1);
    const tb = ticket(b, HOLDER, 1);
    expect(await h.gate.seat(a, ta)).toBeNull();
    expect(await h.gate.seat(b, tb)).toBeNull();
    bell(h, ta);
    // B passes emblem 8 (still serving B's ticket) to A: A's next ticket finds 7 its own (settling) and 8 B's
    h.owners.set('8', a.toLowerCase());
    const ta2 = ticket(a, HOLDER, 2);
    expect(await h.gate.seat(a, ta2)).toMatchObject({ code: 'game_closed' });
    expect(h.journal.pending).toEqual([expect.objectContaining({ key: ta.key }), expect.objectContaining({ key: ta2.key, reason: 'stale', noShow: true })]);
    expect(h.excused).toEqual([]);
    expect(h.flags).toEqual([expect.objectContaining({ subtype: 'emblem_shared', wallets: [a.toLowerCase(), b.toLowerCase()] })]);
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
