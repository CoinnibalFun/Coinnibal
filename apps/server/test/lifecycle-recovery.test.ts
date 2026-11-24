/**
 * Round / room lifecycle and failure recovery: what must still hold on the slow paths (a reorg noticed only after
 * the stale sweeper already read the ticket closed, a restart between a send and its receipt, ...).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '@coinnibal/sdk';
import type { Hash } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { EvmChain } from '../src/chain/evm';
import { sessionKey, type SettledEvent } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { healthReport } from '../src/health';
import type { RoomManager } from '../src/rooms/manager';
import { Journal, type SettlementItem } from '../src/stake/journal';
import { ARENA, E18, FakeEvm } from './fake-evm';
import { testSigner } from './signers';

const T0 = 1_760_000_000_000;
const K = 1_000 * 1e6;
const wallet = () => testSigner().address;

async function harness(env: Record<string, string> = {}, journal = new Journal(null), dir: string | null = null, evm = new FakeEvm()) {
  if (!evm.arenaMap.has(1)) evm.addArena(1, 1_000n);
  const h = { evm, journal, logs: [] as string[], settled: [] as SettledEvent[], clock: { now: T0 }, chain: null as unknown as EvmChain };
  const cfg = loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey(), ...env } as unknown as NodeJS.ProcessEnv);
  h.chain = new EvmChain(cfg, journal, (m) => h.logs.push(m), { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => h.clock.now, receiptTimeoutMs: 10, cacheDir: dir });
  h.chain.setLiveSessionProvider(() => new Set());
  h.chain.onSettled((e) => h.settled.push(e));
  await h.chain.start();
  return h;
}

function item(s: SessionInfo, payout: number, overrides: Partial<SettlementItem> = {}): SettlementItem {
  const key = sessionKey(s.arenaId, s.player, s.id);
  return { kind: 'settle', key, player: s.player, arenaId: s.arenaId, session: key, sessionId: Number(s.id), payout, score: 1, kills: 0, xp: 0, reason: 'round', attempts: 0, nextAttemptAt: T0, createdAt: T0, ...overrides };
}

const calls = (evm: FakeEvm, name: string) => evm.sent.filter((c) => c.functionName === name);

describe('a restart between a settlement send and its receipt', () => {
  it('the restarted server books the earlier transaction: settled log record (reorg protection, standing) and the settled event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-lost-receipt-'));
    const path = join(dir, 'journal.json');
    const evm = new FakeEvm();
    const a = await harness({ STALE_SESSION_AFTER_S: '7200' }, new Journal(path), dir, evm);
    const winner = wallet();
    const s = evm.join(1, winner, { openedAt: Math.floor(T0 / 1000) - 600 });
    evm.join(1, wallet());
    a.journal.enqueue(item(s, 2 * K));
    // the batch is mined, but the server is killed before it sees the receipt
    evm.holdReceipts = true;
    await a.chain.processPending();
    expect(calls(evm, 'settle')).toHaveLength(1);
    expect(a.settled).toHaveLength(0);
    await a.chain.stop();

    // SIGKILL: a new process on the same DATA_DIR, the receipt is there now
    evm.holdReceipts = false;
    const b = await harness({ STALE_SESSION_AFTER_S: '7200' }, new Journal(path), dir, evm);
    b.clock.now += 30_000;
    await b.chain.processPending();
    const key = sessionKey(1, winner, s.id);
    expect(b.journal.pending).toHaveLength(0);
    // never sent twice, never treated as the player's own refund
    expect(calls(evm, 'settle')).toHaveLength(1);
    expect(b.journal.forfeits()).toHaveLength(0);
    // booked as this server's settlement, as if the receipt had been seen before the crash
    expect(b.chain.settledLog.get(key, ARENA)).toMatchObject({ kind: 'settle', amount: 2 * K });
    expect(b.settled.map((e) => [e.key, e.payout])).toEqual([[key, 2 * K]]);
  });
});

describe('reorg protection outlives the first stale sweep', () => {
  it('a settlement reorged out after the sweeper read its ticket closed is still re-sent with the same payout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-late-reorg-'));
    const h = await harness({ STALE_SESSION_AFTER_S: '7200' }, new Journal(null), dir);
    const winner = wallet();
    const s = h.evm.join(1, winner, { openedAt: Math.floor(T0 / 1000) - 3600 });
    h.evm.join(1, wallet());
    h.journal.enqueue(item(s, 2 * K));
    await h.chain.processPending();
    expect(h.settled.map((e) => e.payout)).toEqual([2 * K]);
    // the next sweeps read the ticket closed (the usual state right after a bell)
    expect(await h.chain.sweepStale()).toBe(0);
    h.clock.now += 5 * 60_000;
    expect(await h.chain.sweepStale()).toBe(0);
    // minutes later the block with the batch is reorged away: no receipt, the session open again, the stakes back
    const key = sessionKey(1, winner, s.id);
    const done = h.chain.settledLog.get(key, ARENA)!;
    h.evm.receipts.delete(done.tx as Hash);
    h.evm.sessions.set(`1:${winner.toLowerCase()}`, s);
    h.evm.arenaMap.get(1)!.vault += 2_000n * E18;
    h.evm.arenaMap.get(1)!.openSessions += 1;
    h.clock.now += 5 * 60_000;
    expect(await h.chain.sweepStale()).toBe(1);
    expect(h.journal.pending[0]).toMatchObject({ kind: 'settle', key, payout: 2 * K, reason: 'round' });
    await h.chain.processPending();
    expect(calls(h.evm, 'settle')).toHaveLength(2);
    expect(calls(h.evm, 'cancel')).toHaveLength(0);
  });
});

describe('deploys and reboots wait out the paid ticket rooms (they play on their own clock)', () => {
  it('/api/health names the end of the last open paid ticket room', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    const room = (opts: Record<string, unknown>) => ({ opts });
    const rooms = {
      pool: null,
      online: () => 0,
      roomCount: 3,
      customRooms: () => [
        room({ mode: 'arena', code: 'AAAA', custom: {}, stake: { arenaId: 1 }, ownRound: { startsAt: T0, endsAt: T0 + 30 * 60_000 } }),
        room({ mode: 'arena', code: 'BBBB', custom: {}, stake: { arenaId: 2 }, ownRound: { startsAt: T0, endsAt: T0 + 50 * 60_000 } }),
        room({ mode: 'private', code: 'CCCC', custom: {} }),
      ],
    } as unknown as RoomManager;
    const r = healthReport({ cfg, rooms, chain: { enabled: false } as never, startedAt: T0, now: T0 });
    expect(r.paidRooms).toEqual({ open: 2, endsAt: T0 + 50 * 60_000 });
    expect(r.ok).toBe(true);
    const none = healthReport({ cfg, rooms: { ...rooms, customRooms: () => [] } as unknown as RoomManager, chain: { enabled: false } as never, startedAt: T0, now: T0 });
    expect(none.paidRooms).toEqual({ open: 0, endsAt: null });
  });

  // wait_for_round_break of deploy/vps/lib.sh with docker, the clock and sleep faked: the app answers the room's end
  // (ms) until it is over. Returns the log lines and the fake time it returned at.
  function waitForBreak(opts: { endsAtS: number | null; nowS: number; waitS?: number }): { out: string; at: number } {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const tmp = mkdtempSync(join(tmpdir(), 'coinnibal-break-'));
    const env = join(tmp, '.env');
    writeFileSync(env, 'ROUND_SECONDS=300\nROUND_BREAK_SECONDS=30\n');
    const script = [
      'set -euo pipefail',
      `export COINNIBAL_ENV='${env}'`,
      `. '${join(repoRoot, 'deploy/vps/lib.sh')}'`,
      ...(opts.waitS !== undefined ? [`PAID_ROOM_WAIT_S=${opts.waitS}`] : []),
      `now=${opts.nowS}`,
      `ends=${opts.endsAtS ?? ''}`,
      'dc() { echo cid; }',
      'docker() { if [[ "$1" == exec && -n "$ends" ]] && ((now < ends + 5)); then printf %s "$((ends * 1000))"; fi; return 0; }',
      'date() { if [[ "$*" == "+%s" ]]; then echo "$now"; else command date "$@"; fi; }',
      'sleep() { now=$((now + ${1%.*} + 1)); }',
      'log() { printf "%s\\n" "$*"; }',
      'wait_for_round_break',
      'echo "AT $now"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return { out: r.stdout, at: Number(/AT (\d+)/.exec(r.stdout)?.[1]) };
  }

  const CYCLE = 330;
  // 100 s into a round: well inside the play
  const mid = 1_800_000_000 - (1_800_000_000 % CYCLE) + 100;
  const inBreak = (t: number) => t % CYCLE >= 2 && t % CYCLE <= 22;

  it('without a paid room: the next arena break, as before', () => {
    const r = waitForBreak({ endsAtS: null, nowS: mid });
    expect(r.out).not.toMatch(/paid ticket room/);
    expect(r.out).toMatch(/in the break after the bell/);
    expect(inBreak(r.at)).toBe(true);
  });

  it('a paid room open past the next arena break: the swap waits for its end, then for the arena break after it', () => {
    const ends = mid + 900;
    const r = waitForBreak({ endsAtS: ends, nowS: mid });
    expect(r.out).toMatch(/a paid ticket room plays until .* UTC; waiting for its end/);
    expect(r.at).toBeGreaterThan(ends);
    expect(inBreak(r.at)).toBe(true);
  });

  it('never waits past PAID_ROOM_WAIT_S', () => {
    const r = waitForBreak({ endsAtS: mid + 3_600, nowS: mid, waitS: 0 });
    expect(r.out).toMatch(/still plays after 0 min of waiting; going on/);
    expect(r.at).toBeLessThan(mid + 3_600);
  });
});
