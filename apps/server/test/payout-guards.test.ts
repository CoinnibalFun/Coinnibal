/**
 * What limits the damage a bug, a tampered journal or a misused server key can do through the settlement
 * worker: the payout guard (a ticket paid more than PAYOUT_GUARD_MULTIPLE entry fees is held for an admin),
 * the books guard (nothing leaves a vault that does not cover the journal), held tickets that the player
 * refunded, and reorg protection (a settlement reorged out is re-sent, never refunded at the entry fee).
 */
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '@elymum/sdk';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { EvmChain } from '../src/chain/evm';
import { sessionKey, type SettledEvent } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Journal, type SettlementItem } from '../src/stake/journal';
import { SettledLog } from '../src/stake/settled-log';
import { ARENA, E18, FakeEvm } from './fake-evm';
import { testSigner } from './signers';

const T0 = 1_760_000_000_000;
const K = 1_000 * 1e6;
const wallet = () => testSigner().address;

async function harness(env: Record<string, string> = {}, journal = new Journal(null), dir: string | null = null) {
  const evm = new FakeEvm();
  evm.addArena(1, 1_000n);
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

describe('server-key blast radius', () => {
  it('holds a payout above PAYOUT_GUARD_MULTIPLE entry fees for an admin; a release pays it exactly once', async () => {
    const h = await harness({ PAYOUT_GUARD_MULTIPLE: '3' });
    const big = wallet();
    const s = h.evm.join(1, big);
    for (let i = 0; i < 6; i++) h.evm.join(1, wallet());
    const ok = h.evm.join(1, wallet());
    h.journal.commit({ enqueue: [item(s, 4 * K), item(ok, 3 * K, { createdAt: T0 + 1 })] });
    await h.chain.processPending();
    // the item at the limit goes out; the one above it is held, never sent
    expect(h.settled.map((e) => e.payout)).toEqual([3 * K]);
    const held = h.journal.held();
    expect(held.map((i) => [i.key, i.held!.flags])).toEqual([[sessionKey(1, big, s.id), ['payout_guard']]]);
    expect(h.logs.join()).toMatch(/HELD for review — payout guard/);
    h.clock.now += 3_600_000;
    await h.chain.processPending();
    expect(calls(h.evm, 'settle')).toHaveLength(1);
    // the admin looked at it: released, it goes out as it was and is not held again
    h.journal.release(held[0].key, h.clock.now);
    await h.chain.processPending();
    expect(h.settled.map((e) => e.payout)).toEqual([3 * K, 4 * K]);
    expect(h.journal.pending).toHaveLength(0);
  });

  it('defaults to 100 entry fees; PAYOUT_GUARD_MULTIPLE=0 turns it off (the contract still caps a payout at the vault)', async () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).chain.payoutGuardMultiple).toBe(100);
    const h = await harness({ PAYOUT_GUARD_MULTIPLE: '0' });
    const s = h.evm.join(1, wallet());
    for (let i = 0; i < 200; i++) h.evm.join(1, wallet());
    h.journal.enqueue(item(s, 150 * K));
    await h.chain.processPending();
    expect(h.settled).toHaveLength(1);
  });

  it('a held settlement whose ticket the player refunded after 24 h is dropped (it no longer counts as owed)', async () => {
    const h = await harness();
    const p = wallet();
    const s = h.evm.join(1, p);
    h.journal.enqueue({ ...item(s, 2 * K), held: { at: T0, score: 95, why: 'test', flags: ['pair_transfer'] } });
    await h.chain.processPending();
    expect(h.journal.held()).toHaveLength(1);
    h.evm.close(1, p); // the player's refund after 24 h
    h.clock.now += 11 * 60_000;
    await h.chain.processPending();
    expect(h.journal.pending).toHaveLength(0);
    expect(h.logs.join()).toMatch(/held settlement .* dropped/);
    expect(h.journal.owedByArena(1)).toBe(0);
  });

  it('a settlement reorged out is re-sent with the same payout, never refunded at the entry fee', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-reorg-'));
    const h = await harness({ STALE_SESSION_AFTER_S: '60' }, new Journal(null), dir);
    const winner = wallet();
    const s = h.evm.join(1, winner, { openedAt: Math.floor(T0 / 1000) - 3600 });
    h.evm.join(1, wallet());
    h.journal.enqueue(item(s, 2 * K));
    await h.chain.processPending();
    expect(h.settled.map((e) => e.payout)).toEqual([2 * K]);
    const key = sessionKey(1, winner, s.id);
    expect(h.chain.settledLog.get(key)).toMatchObject({ kind: 'settle', amount: 2 * K, net: 1_800 * 1e6, fee: 200 * 1e6, reason: 'round' });
    // the block with the batch is reorged away: the session is open again and the vault holds the stakes again
    h.evm.sessions.set(`1:${winner.toLowerCase()}`, s);
    h.evm.arenaMap.get(1)!.vault += 2_000n * E18;
    h.evm.arenaMap.get(1)!.openSessions += 1;
    expect(await h.chain.sweepStale()).toBe(1);
    expect(h.journal.pending[0]).toMatchObject({ kind: 'settle', key, payout: 2 * K, reason: 'round' });
    expect(h.logs.join()).toMatch(/open again \(reorg\?\) — re-sending the same payout/);
    await h.chain.processPending();
    expect(calls(h.evm, 'settle')).toHaveLength(2);
    expect(calls(h.evm, 'cancel')).toHaveLength(0);
    // the record is on disk (DATA_DIR/chains/<id>/settled.jsonl): a restarted server still knows it
    expect(new SettledLog(join(dir, 'settled.jsonl'), () => {}, () => h.clock.now).get(key)).toMatchObject({ amount: 2 * K });
  });

  it('the settled log survives restarts, skips malformed lines and forgets records after 14 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-settled-'));
    const file = join(dir, 'settled.jsonl');
    let now = T0;
    const a = new SettledLog(file, () => {}, () => now);
    a.record({ kind: 'settle', key: 'old', arenaId: 1, amount: 1, tx: '0x0', at: now - 15 * 24 * 3_600_000 });
    a.record({ kind: 'settle', key: 'a', arenaId: 1, player: '0xA', amount: 5, tx: '0x1', at: now });
    a.record({ kind: 'cancel', key: 'b', arenaId: 1, player: '0xB', amount: 7, tx: '0x2', at: now });
    appendFileSync(file, 'not json\n{"key":1}\n');
    const logs: string[] = [];
    now += 1000;
    const b = new SettledLog(file, (m) => logs.push(m), () => now);
    expect([b.get('a')?.amount, b.get('b')?.kind, b.get('old'), b.size]).toEqual([5, 'cancel', undefined, 2]);
    expect(b.recent(10, '0xa').map((r) => r.key)).toEqual(['a']);
    expect(logs.join()).toMatch(/ignored 2 malformed line/);
  });
});
