// Regression tests of the mainnet-readiness audit's findings (2026-11): each one was a repro of a finding and now
// asserts the fixed behaviour.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROBINHOOD_CHAIN_ID, isReservedName, sanitizeName } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { Auth } from '../src/auth';
import { looksLikeScam } from '../src/chat-filter';
import { checkAuthSecret, loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

// dummy markers, not real secrets
const FAKE_KEY = `0x${'ab'.repeat(32)}`;
const FAKE_AUTH = 'audit-marker-auth-secret';

describe('audit: one admin bearer token reads the server key (fixed)', () => {
  let app: App;
  let port: number;
  const signer = testSigner();
  const admin = signer.address;
  const saved = { key: process.env.SERVER_PRIVATE_KEY, auth: process.env.AUTH_SECRET };

  beforeAll(async () => {
    process.env.SERVER_PRIVATE_KEY = FAKE_KEY;
    process.env.AUTH_SECRET = FAKE_AUTH;
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-audit-'));
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0' } as NodeJS.ProcessEnv);
    app = await createApp(cfg, {
      chain: new ArenaChain([arena(1, 1000)]),
      log: () => {},
      persist: true,
      siteLimits: { writeIp: new Limiter(10_000, 60_000), writeWallet: new Limiter(10_000, 60_000), login: new Limiter(10_000, 60_000) },
      apiLimiter: new Limiter(10_000, 60_000),
    });
    port = await app.listen();
  });
  afterAll(async () => {
    await app.close();
    if (saved.key === undefined) delete process.env.SERVER_PRIVATE_KEY;
    else process.env.SERVER_PRIVATE_KEY = saved.key;
    if (saved.auth === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = saved.auth;
  });

  it('GET /api/admin/migration-env needs a fresh purpose-bound signature, and every read is audited', async () => {
    const token = app.auth.issueToken(admin); // what the web keeps in localStorage after a sign-in
    const url = `http://127.0.0.1:${port}/api/admin/migration-env`;
    const bare = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(bare.status).toBe(401);
    expect(JSON.stringify(await bare.json())).not.toContain(FAKE_KEY);
    // a proof for the backup alone does not open the settings
    const ask = async (purpose: string) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/admin/secret-proof`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose }) });
      const { message } = (await r.json()) as { message: string };
      return Buffer.from(JSON.stringify({ message, signature: await signer.sign(message) })).toString('base64url');
    };
    expect((await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Coinnibal-Proof': await ask('backup') } })).status).toBe(401);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Coinnibal-Proof': await ask('migration') } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { env: Record<string, string> };
    expect(body.env.SERVER_PRIVATE_KEY).toBe(FAKE_KEY);

    const audit = await fetch(`http://127.0.0.1:${port}/api/admin/audit`, { headers: { Authorization: `Bearer ${token}` } });
    const entries = ((await audit.json()) as { entries: { path: string; method: string; status: number }[] }).entries.filter((e) => e.path.includes('migration-env'));
    expect(entries.map((e) => `${e.method} ${e.status}`).sort()).toEqual(['GET 200', 'GET 401', 'GET 401']);
  });
});

describe('audit: AUTH_SECRET strength (fixed)', () => {
  it('refuses a short AUTH_SECRET on the mainnet and warns on a testnet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-audit-'));
    expect(() => checkAuthSecret(loadConfig({ AUTH_SECRET: 'x', CHAIN_ID: '4663', DATA_DIR: dir } as NodeJS.ProcessEnv))).toThrow(/refusing to start on the mainnet/);
    expect(checkAuthSecret(loadConfig({ AUTH_SECRET: 'x', CHAIN_ID: '46630', DATA_DIR: dir } as NodeJS.ProcessEnv))).toMatch(/^!!! AUTH_SECRET is 1 byte/);
    expect(checkAuthSecret(loadConfig({ AUTH_SECRET: 'a'.repeat(32), CHAIN_ID: '4663', DATA_DIR: dir } as NodeJS.ProcessEnv))).toBeNull();
    // the generated secret (no AUTH_SECRET) always passes
    expect(checkAuthSecret(loadConfig({ CHAIN_ID: '4663', DATA_DIR: dir } as NodeJS.ProcessEnv))).toBeNull();
    // a known weak secret forges tokens offline, which is why it is refused
    const auth = new Auth(Buffer.from('x'));
    const admin = testSigner().address;
    const payload = `${admin}.${Date.now() + 3600_000}`;
    expect(auth.verifyToken(`${payload}.${createHmac('sha256', 'x').update(payload).digest('base64url')}`)).toBe(admin);
  });

  it('createApp refuses to boot on the mainnet with a weak AUTH_SECRET', async () => {
    const cfg = loadConfig({ AUTH_SECRET: 'short', CHAIN_ID: '4663', PORT: '0', DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-audit-')) } as NodeJS.ProcessEnv);
    await expect(createApp(cfg, { chain: new ArenaChain([arena(1, 1000)]), log: () => {}, persist: false })).rejects.toThrow(/AUTH_SECRET/);
  });

  it('the refusal looks at the chain the RPC serves too: CHAIN_ID unset never lets a weak secret onto the mainnet (S6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-audit-'));
    const unset = loadConfig({ AUTH_SECRET: 'x', DATA_DIR: dir } as NodeJS.ProcessEnv);
    expect(() => checkAuthSecret(unset, [ROBINHOOD_CHAIN_ID])).toThrow(/serves the mainnet/);
    expect(() => checkAuthSecret(unset, [null, ROBINHOOD_CHAIN_ID])).toThrow(/serves the mainnet/);
    expect(() => checkAuthSecret(unset, [], true)).toThrow(/may be the mainnet/);
    expect(checkAuthSecret(unset, [46630, null])).toMatch(/^!!! AUTH_SECRET/);
    // a strong secret passes whatever the chain
    expect(checkAuthSecret(loadConfig({ AUTH_SECRET: 'a'.repeat(32), DATA_DIR: dir } as NodeJS.ProcessEnv), [ROBINHOOD_CHAIN_ID], true)).toBeNull();

    // the whole boot: EVM_RPC_URL answers eth_chainId 4663, CHAIN_ID is not set
    const rpc = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const calls = [JSON.parse(body)].flat() as { id: number; method: string }[];
        const out = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, ...(c.method === 'eth_chainId' ? { result: `0x${ROBINHOOD_CHAIN_ID.toString(16)}` } : { error: { code: -32601, message: 'no' } }) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
      });
    });
    await new Promise<void>((r) => rpc.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}/`;
      const boot = (env: Record<string, string>) =>
        createApp(loadConfig({ AUTH_SECRET: 'short', SERVER_PRIVATE_KEY: FAKE_KEY, PORT: '0', DATA_DIR: mkdtempSync(join(tmpdir(), 'coinnibal-audit-')), ...env } as NodeJS.ProcessEnv), { log: () => {}, persist: false });
      await expect(boot({ EVM_RPC_URL: url })).rejects.toThrow(/serves the mainnet/);
      // the RPC does not answer at a first boot and CHAIN_ID is not set: it may be the mainnet
      await expect(boot({ EVM_RPC_URL: 'http://127.0.0.1:1/' })).rejects.toThrow(/may be the mainnet/);
    } finally {
      rpc.close();
    }
  });
});

describe('audit: chat and name abuse (fixed)', () => {
  it('blocks the common scam lines in chat', () => {
    expect(looksLikeScam('free airdrop at coinnibal-claim dot xyz')).toBe(true);
    expect(looksLikeScam('coinnibal．com/claim for your bonus')).toBe(true); // a full-width dot
    expect(looksLikeScam('send me coinnibal and I double it')).toBe(true);
    expect(looksLikeScam('admin here: DM me your recovery phrase')).toBe(true);
    expect(looksLikeScam('claim at coinnibal.fun')).toBe(true);
    expect(looksLikeScam('type your seed words here')).toBe(true);
    expect(looksLikeScam('go to coinnibal [.] app')).toBe(true);
    // ordinary game talk passes
    for (const ok of ['gg wp', 'nice split!', 'lol.so close', 'who wants to team? jk', 'send help', 'see you next round', 'polka dot coin']) expect(looksLikeScam(ok)).toBe(false);
  });

  it('refuses names that impersonate the system speaker or staff', () => {
    for (const n of ['Coinnibal', 'Coinnibal Support', 'COINNIBAL', 'E1ymum', 'e.l.y.m.u.m', 'Ｅｌｙｍｕｍ', 'Admin', 'admin', 'Support', 'Official Mod']) {
      expect(isReservedName(n)).toBe(true);
      expect(sanitizeName(n)).toBe('Coinie');
    }
    for (const n of ['Coinie', 'Badminton Ace', 'Modesty', 'Sam', 'Dev']) {
      expect(isReservedName(n)).toBe(false);
      expect(sanitizeName(n)).toBe(n);
    }
  });
});
