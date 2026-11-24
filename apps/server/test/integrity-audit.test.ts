import type { IntegrityTransfer } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/game/rng';
import { IntegrityService } from '../src/integrity/service';
import { IntegrityStore } from '../src/integrity/store';
import { emptyInput, type SessionSummary } from '../src/integrity/types';
import { Journal, type SettlementItem } from '../src/stake/journal';

const FEE = 1_000_000;
const ROUND = 330_000;
const T0 = 1_791_000_000_000 - (1_791_000_000_000 % ROUND);

let seq = 0;
function sess(wallet: string, r: number, over: Partial<SessionSummary> = {}): SessionSummary {
  const n = ++seq;
  const start = T0 + r * ROUND;
  return {
    key: `S${n}#${n}`,
    wallet,
    arenaId: 1,
    roomId: 'arena-1-1',
    entryFee: FEE,
    round: r,
    roundStartsAt: start,
    joinsCloseAt: start + ROUND - 90_000,
    roundEndsAt: start + ROUND,
    joinedAt: start + 31_000,
    endedAt: start + ROUND,
    endReason: 'round',
    payout: FEE,
    ipHash: `ip-${wallet}`,
    fpHash: `fp-${wallet}`,
    afkMs: 0,
    afkAtEnd: false,
    receivedWhileAfk: 0,
    input: emptyInput(),
    ejects: { eatenBy: {}, eatenOther: 0 },
    death: null,
    ...over,
  };
}

const settleItem = (player: string, payout: number): SettlementItem => ({
  kind: 'settle',
  key: `k-${player}-${++seq}`,
  player,
  arenaId: 1,
  session: `s-${player}`,
  sessionId: seq,
  payout,
  score: 0,
  kills: 0,
  xp: 0,
  reason: 'round',
  attempts: 0,
  nextAttemptAt: 0,
  createdAt: 0,
});

/** A window at the service's caps: 1,000 wallets, 20,000 tickets, 60,000 transfers (a busy server fills it in hours). */
function busyService(now: () => number, mono: () => number): { svc: IntegrityService; wallets: string[] } {
  const rng = mulberry32(5);
  const svc = new IntegrityService({ store: new IntegrityStore(null), journal: new Journal(null), kick: () => {}, now, mono });
  const wallets = Array.from({ length: 1000 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
  const all: SessionSummary[] = [];
  for (let i = 0; i < 20_000; i++) {
    const w = wallets[Math.floor(rng() * wallets.length)];
    const near: Record<string, number> = {};
    for (let k = 0; k < 6; k++) near[wallets[Math.floor(rng() * wallets.length)]] = 1 + Math.floor(rng() * 40);
    const s = sess(w, Math.floor(i / 40), { roomId: `arena-1-${1 + Math.floor(rng() * 20)}`, near, ipHash: `ip-${wallets.indexOf(w) >> 1}` });
    for (let b = 0; b < s.input.turnHist.length; b++) s.input.turnHist[b] = Math.floor(rng() * 200);
    all.push(s);
    svc.ingestSession(s);
  }
  for (let i = 0; i < 60_000; i++) {
    const a = all[Math.floor(rng() * all.length)];
    const b = all[Math.floor(rng() * all.length)];
    const t: IntegrityTransfer = { at: a.joinedAt + 1000, arenaId: 1, roomId: a.roomId, round: a.round, from: a.wallet, to: b.wallet, amount: FEE / 10, fee: FEE, fromKey: a.key, toKey: b.key, others: 30, afkEater: false };
    svc.ingestTransfer(t);
  }
  return { svc, wallets };
}

describe('audit: integrity auto-hold at a bell (fixed)', () => {
  it('a bell of 300 winners at the window caps decides every hold in about one detector run, not one per ticket', () => {
    let mono = 0;
    const now = T0 + 520 * ROUND;
    const { svc, wallets } = busyService(() => now, () => mono);
    svc.updateSettings({ autoHold: true, holdScore: 90 }, 'test');
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) {
      svc.holdDecision(settleItem(wallets[i], FEE * 2), FEE);
      mono += 2; // a bell settles them all within a few milliseconds of each other
    }
    const ms = performance.now() - t0;
    // before: one scoped run per decision over most of the window, about 70 s of main thread for this bell
    expect(ms).toBeLessThan(6_000);
  }, 120_000);

  it('a burst still holds what a scoped decision holds: a shared browser, and the ticket that just ended parked at the bell', () => {
    let mono = 0;
    let now = T0 + 20 * ROUND;
    const svc = new IntegrityService({ store: new IntegrityStore(null), journal: new Journal(null), kick: () => {}, now: () => now, mono: () => mono });
    // two wallets on one browser, both in the arena for whole rounds: a shared-device flag (score 60 + same room 10)
    for (let r = 10; r < 13; r++) {
      svc.ingestSession(sess('0xAlt', r, { fpHash: 'fp-same' }));
      svc.ingestSession(sess('0xMain', r, { fpHash: 'fp-same' }));
    }
    // a wallet that parked three late joins idle until the bell before (a fourth makes 55)
    const parked = (r: number) => {
      const start = T0 + r * ROUND;
      return sess('0xParker', r, { joinedAt: start + ROUND - 100_000, joinsCloseAt: start + ROUND - 90_000, afkMs: 99_000, afkAtEnd: true });
    };
    svc.ingestSession(parked(13));
    svc.ingestSession(parked(14));
    svc.ingestSession(parked(15));
    for (let i = 0; i < 20; i++) svc.ingestSession(sess(`0xHonest${i}`, 16));
    svc.updateSettings({ autoHold: true, holdScore: 50 }, 'test');

    // the bell: honest winners first (the second decision starts the shared run), then the two
    const a = settleItem('0xHonest0', FEE * 2);
    svc.holdDecision(a, FEE);
    mono += 1;
    const b = settleItem('0xHonest1', FEE * 2);
    svc.holdDecision(b, FEE);
    expect(a.held).toBeUndefined();
    expect(b.held).toBeUndefined();
    // the parker's fourth parked ticket ends after the shared run was made: it still counts
    svc.ingestSession(parked(16));
    mono += 1;
    const p = settleItem('0xParker', FEE * 2);
    svc.holdDecision(p, FEE);
    expect(p.held?.why).toMatch(/late joins left idle/);
    mono += 1;
    const m = settleItem('0xMain', FEE * 2);
    svc.holdDecision(m, FEE);
    expect(m.held?.why).toMatch(/same arena at the same time from one browser/);
    // a decision long after the burst runs on its own (scoped) again
    mono += 10_000;
    now += 10_000;
    const later = settleItem('0xAlt', FEE * 2);
    svc.holdDecision(later, FEE);
    expect(later.held).toBeDefined();
  });
});
