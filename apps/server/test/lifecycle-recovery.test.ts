/**
 * Round / room lifecycle and failure recovery: what must still hold on the slow paths (a reorg noticed only after
 * the stale sweeper already read the ticket closed, a restart between a send and its receipt, ...).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '@coinnibal/sdk';
import type { Hash } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { EvmChain } from '../src/chain/evm';
import { sessionKey, type SettledEvent } from '../src/chain/types';
import { loadConfig } from '../src/config';
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
