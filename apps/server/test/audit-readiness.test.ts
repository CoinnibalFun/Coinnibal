/**
 * Mainnet-readiness audit (2026-11): repros of the gaps found. Each `it.fails` describes the behaviour the server
 * SHOULD have and fails today; it flips to a normal failure (and must become a plain `it`) once the fix lands.
 * No production code is changed by this file.
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

describe('audit: the journal cannot be written (disk full)', () => {
  let app: App | null = null;
  const dir = mkdtempSync(join(tmpdir(), 'elymum-audit-disk-'));
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.fails('reports it in /api/health (ok: false), so the Docker health check and an uptime monitor see it', async () => {
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
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean };
    // today: { ok: true } — nothing outside the log line tells anyone that money records are only in memory
    expect(health.ok).toBe(false);
  });
});

describe('audit: server clock skew against the chain', () => {
  it.fails('a ticket bought 60 s ago (chain time) is not cancelled as "unplayed" when the server clock runs 16 min fast', async () => {
    const T0 = 1_760_000_000_000;
    const evm = new FakeEvm();
    evm.addArena(1, 1_000n);
    const journal = new Journal(null);
    const skewMs = 16 * 60_000;
    const chain = new EvmChain(
      loadConfig({ EVM_RPC_URL: 'http://127.0.0.1:1', SERVER_PRIVATE_KEY: generatePrivateKey() } as unknown as NodeJS.ProcessEnv),
      journal,
      () => {},
      { client: evm, contracts: () => ({ arena: ARENA, nft: null }), loops: false, now: () => T0 + skewMs, receiptTimeoutMs: 10 },
    );
    await chain.start();
    // bought one minute ago by the chain's clock; the player is still between the wallet and the seat
    evm.join(1, testSigner().address, { openedAt: Math.floor(T0 / 1000) - 60 });
    evm.block += 10n;
    // today: 1 (queued as stale → `cancel`, the player is refunded and must buy again). The sweeper compares the
    // server's Date.now() with the chain's block timestamp; it should use the chain's latest block time.
    expect(await chain.sweepStale()).toBe(0);
  });
});
