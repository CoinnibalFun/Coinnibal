import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import type { ChainGateway } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { healthReport } from '../src/health';
import type { RoomManager } from '../src/rooms/manager';
import { Journal } from '../src/stake/journal';

const NOW = 1_800_000_000_000;
const rooms = { pool: null, online: () => 3, roomCount: 2 } as unknown as RoomManager;
const cfg = loadConfig({ EVM_RPC_URL: 'https://rpc.example', SERVER_PRIVATE_KEY: generatePrivateKey() } as unknown as NodeJS.ProcessEnv);

function chain(over: Record<string, unknown> = {}): ChainGateway {
  return {
    enabled: true,
    rpcReachable: () => true,
    lastRpcOkAt: () => NOW - 5_000,
    clockSkewMs: () => 400,
    gasRunway: () => ({ level: 'ok', balanceWei: '1', spendWeiPerDay: '1', days: 30, floorWei: '1', warnDays: 7, criticalDays: 2, sampledHours: 24 }),
    booksGuard: () => new Map(),
    ...over,
  } as unknown as ChainGateway;
}

const settle = (key: string, createdAt: number, held = false) => ({
  kind: 'settle' as const,
  key,
  player: '0x' + '1'.repeat(40),
  arenaId: 1,
  sessionId: 1,
  payout: 1,
  score: 0,
  kills: 0,
  xp: 0,
  attempts: 0,
  nextAttemptAt: createdAt,
  createdAt,
  ...(held ? { held: { at: createdAt, score: 95, why: 'x', flags: [] } } : {}),
});

describe('/api/health', () => {
  it('is ok when nothing needs a person', () => {
    const r = healthReport({ cfg, rooms, journal: new Journal(null), chain: chain(), startedAt: NOW - 60_000, now: NOW });
    expect(r).toMatchObject({ ok: true, reasons: [], uptimeS: 60, online: 3, chain: { configured: true, reachable: true, lastOkS: 5, clockSkewS: 0 } });
  });

  it('names every reason: backlog, stuck queue, RPC away, low gas, books guard, clock skew', () => {
    const journal = new Journal(null);
    journal.commit({ enqueue: Array.from({ length: 401 }, (_, i) => settle(`k${i}`, NOW - 1000)) });
    journal.commit({ enqueue: [settle('old', NOW - 20 * 60_000), settle('held', NOW - 3 * 3600_000, true)] });
    const r = healthReport({
      cfg,
      rooms,
      journal,
      chain: chain({
        rpcReachable: () => false,
        clockSkewMs: () => -45_000,
        gasRunway: () => ({ level: 'critical', balanceWei: '1', spendWeiPerDay: '1', days: 1.5, floorWei: '1', warnDays: 7, criticalDays: 2, sampledHours: 24 }),
        booksGuard: () => new Map([[2, 'the vault holds less']]),
      }),
      startedAt: NOW - 60_000,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      '402 settlements pending (over 400)',
      // a held item waits for a person on purpose: it is not "stuck"
      'the oldest pending settlement is 1200 s old (over 900 s)',
      'the chain RPC is unreachable',
      "the server clock is -45 s off the chain's",
      "the server key's gas is low (1.5 day(s) left)",
      'arena #2 payouts stopped by the books guard',
    ]);
    expect(r.journal).toMatchObject({ pending: 402, held: 1, oldestDueS: 1200 });
  });

  it('a practice-only server (no chain configured) is not "unreachable"', () => {
    const bare = loadConfig({} as NodeJS.ProcessEnv);
    const r = healthReport({ cfg: bare, rooms, journal: new Journal(null), chain: { enabled: false } as ChainGateway, startedAt: NOW, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.chain.reachable).toBeNull();
  });
});
