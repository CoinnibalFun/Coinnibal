// Repros of the mainnet-readiness audit (2026-11). Every test PASSES on the current code: each one demonstrates a
// behaviour the audit report ranks as a finding, so a fix should make the matching assertion fail (then flip it).
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeName } from '@elymum/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { Auth } from '../src/auth';
import { looksLikeScam } from '../src/chat-filter';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

// dummy markers, not real secrets
const FAKE_KEY = `0x${'ab'.repeat(32)}`;
const FAKE_AUTH = 'audit-marker-auth-secret';

describe('audit: one admin bearer token reads the server key', () => {
  let app: App;
  let port: number;
  const admin = testSigner().address;
  const saved = { key: process.env.SERVER_PRIVATE_KEY, auth: process.env.AUTH_SECRET };

  beforeAll(async () => {
    process.env.SERVER_PRIVATE_KEY = FAKE_KEY;
    process.env.AUTH_SECRET = FAKE_AUTH;
    const dir = mkdtempSync(join(tmpdir(), 'elymum-audit-'));
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

  it('GET /api/admin/migration-env answers SERVER_PRIVATE_KEY and AUTH_SECRET to the 24 h login token, no fresh signature', async () => {
    const token = app.auth.issueToken(admin); // what the web keeps in localStorage after a sign-in
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/migration-env`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { env: Record<string, string> };
    expect(body.env.SERVER_PRIVATE_KEY).toBe(FAKE_KEY);
    expect(body.env.AUTH_SECRET).toBe(FAKE_AUTH);

    // and the admin audit log (writes only) has no line for it
    const audit = await fetch(`http://127.0.0.1:${port}/api/admin/audit`, { headers: { Authorization: `Bearer ${token}` } });
    const entries = ((await audit.json()) as { entries: { path: string }[] }).entries;
    expect(entries.some((e) => e.path.includes('migration-env'))).toBe(false);
  });
});

describe('audit: AUTH_SECRET strength', () => {
  it('accepts a one-character AUTH_SECRET, and a known secret forges an admin token offline', () => {
    const cfg = loadConfig({ AUTH_SECRET: 'x', DATA_DIR: mkdtempSync(join(tmpdir(), 'elymum-audit-')) } as NodeJS.ProcessEnv);
    expect(cfg.authSecret.length).toBe(1);
    const auth = new Auth(cfg.authSecret);
    const admin = testSigner().address;
    const payload = `${admin}.${Date.now() + 3600_000}`;
    const forged = `${payload}.${createHmac('sha256', 'x').update(payload).digest('base64url')}`;
    expect(auth.verifyToken(forged)).toBe(admin);
  });
});

describe('audit: chat and name abuse', () => {
  it('lets common scam lines through the chat filter', () => {
    expect(looksLikeScam('free airdrop at elymum-claim dot xyz')).toBe(false);
    expect(looksLikeScam('elymum．com/claim for your bonus')).toBe(false); // a full-width dot
    expect(looksLikeScam('send me elymum and I double it')).toBe(false);
    expect(looksLikeScam('admin here: DM me your recovery phrase')).toBe(false);
    expect(looksLikeScam('claim at elymum.fun')).toBe(false);
  });

  it('lets a guest call itself after the system speaker', () => {
    expect(sanitizeName('Elymum')).toBe('Elymum');
    expect(sanitizeName('Elymum Support')).toBe('Elymum Support');
  });
});
