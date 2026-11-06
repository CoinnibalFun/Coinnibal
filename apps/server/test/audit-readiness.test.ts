/**
 * Mainnet-readiness audit (2026-11): regression tests of the gaps found (each was an `it.fails` repro; the fixes
 * made them plain tests).
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { EvmChain } from '../src/chain/evm';
import { loadConfig } from '../src/config';
import { Journal } from '../src/stake/journal';
import { ARENA, FakeEvm } from './fake-evm';
import { testSigner } from './signers';

describe('audit: the journal cannot be written (disk full) (fixed)', () => {
  let app: App | null = null;
  const dir = mkdtempSync(join(tmpdir(), 'elymum-audit-disk-'));
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports it in /api/health (503, ok: false, the reason), so the alert job and an uptime monitor see it; liveness stays up', async () => {
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, NODE_ENV: 'development', DEV_FAKE_CHAIN: '1', DEV_FAKE_TOKEN: '1', GAME_ACCESS: 'public' } as unknown as NodeJS.ProcessEnv);
    app = await createApp(cfg, { log: () => {} });
    const port = await app.listen();
    // the journal's folder becomes unwritable (here: a file where the folder was; on the VPS: ENOSPC)
    const path = (app.journal as unknown as { path: string }).path;
    expect(path).toBeTruthy();
    const folder = join(path, '..');
    renameSync(folder, `${folder}.moved`);
    writeFileSync(folder, 'not a folder');
    app.journal.enqueue({ kind: 'sweep', key: 'sweep:arena-1-1:1', arenaId: 1, roomId: 'arena-1-1', round: 1, amount: 1, attempts: 0, nextAttemptAt: Date.now(), createdAt: Date.now() });
    expect(app.journal.writeFailing).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(503);
    const health = (await res.json()) as { ok: boolean; reasons: string[]; journal: { writeFailing: boolean } };
    expect(health.ok).toBe(false);
    expect(health.journal.writeFailing).toBe(true);
    expect(health.reasons.join()).toMatch(/journal cannot be written/);
    // the container's liveness check does not restart it for this (a restart does not free the disk)
    expect((await fetch(`http://127.0.0.1:${port}/api/health?live=1`)).status).toBe(200);
    // and the lobby stops offering tickets
    expect(app.chain.status().arenasEnabled).toBe(false);
  });
});

describe('audit: server clock skew against the chain (fixed)', () => {
  it('a ticket bought 60 s ago (chain time) is not cancelled as "unplayed" when the server clock runs 16 min fast; the skew is reported', async () => {
    const T0 = 1_760_000_000_000;
    const evm = new FakeEvm();
    evm.addArena(1, 1_000n);
    // the chain's clock (block timestamps) is right; the server's runs 16 minutes fast
    evm.nowS = () => Math.floor(T0 / 1000);
    const journal = new Journal(null);
    const skewMs = 16 * 60_000;
    const logs: string[] = [];
    const chain = new EvmChain(
      loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey() } as unknown as NodeJS.ProcessEnv),
      journal,
      (m) => logs.push(m),
      { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => T0 + skewMs, receiptTimeoutMs: 10 },
    );
    chain.setLiveSessionProvider(() => new Set());
    await chain.start();
    // bought one minute ago by the chain's clock; the player is still between the wallet and the seat
    evm.join(1, testSigner().address, { openedAt: Math.floor(T0 / 1000) - 60 });
    evm.block += 10n;
    expect(await chain.sweepStale()).toBe(0);
    expect(chain.clockSkewMs()).toBeGreaterThan(15 * 60_000);
    expect(logs.some((l) => l.startsWith('!!! clock: the server clock is 960 s ahead of the chain'))).toBe(true);
    // 15 minutes later on the chain it is stale
    evm.nowS = () => Math.floor(T0 / 1000) + 15 * 60;
    expect(await chain.sweepStale()).toBe(1);
  });
});
