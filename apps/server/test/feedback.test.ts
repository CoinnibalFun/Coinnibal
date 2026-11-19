import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEEDBACK_LIMITS, type FeedbackList } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { FeedbackStore, parseFeedback } from '../src/site/feedback';
import type { SiteLimits } from '../src/site/routes';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

const roomy = () => new Limiter(10_000, 60_000);

interface Harness {
  app: App;
  dir: string;
  admin: string;
  call(method: string, path: string, opts?: { wallet?: string | null; token?: string; body?: unknown; raw?: string; type?: string }): Promise<{ status: number; body: any; headers: Headers }>;
}

async function harness(limits: Partial<SiteLimits> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-feedback-'));
  const admin = testSigner().address;
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0' } as NodeJS.ProcessEnv);
  const app = await createApp(cfg, {
    chain: new ArenaChain([arena(1, 1000)]),
    log: () => {},
    persist: true,
    siteLimits: { writeIp: roomy(), writeWallet: roomy(), login: roomy(), feedbackIp: roomy(), feedbackWallet: roomy(), feedbackAll: roomy(), ...limits },
    apiLimiter: roomy(),
  });
  const port = await app.listen();
  const call: Harness['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = {};
    if (opts.wallet) headers.Authorization = `Bearer ${app.auth.issueToken(opts.wallet)}`;
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.raw !== undefined || opts.body !== undefined) {
      headers['Content-Type'] = opts.type ?? 'application/json';
      body = opts.raw ?? JSON.stringify(opts.body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return { app, dir, admin, call };
}

const message = (extra: Record<string, unknown> = {}) => ({ text: 'The minimap hides my coin on a phone.', page: '/play', viewport: '390x844', build: '0.1.0', ...extra });

describe('player feedback: POST /api/feedback and the admin list', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.app.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('takes a guest message with its context and shows it to the admin only', async () => {
    const sent = await h.call('POST', '/api/feedback', { body: message({ contact: '@player on X', room: 'arena' }) });
    expect(sent.status).toBe(201);
    expect(sent.body).toEqual({ ok: true });

    expect((await h.call('GET', '/api/admin/feedback')).status).toBe(401);
    expect((await h.call('GET', '/api/admin/feedback', { wallet: testSigner().address })).status).toBe(403);
    const list = await h.call('GET', '/api/admin/feedback', { wallet: h.admin });
    expect(list.status).toBe(200);
    const body = list.body as FeedbackList;
    expect(body.total).toBe(1);
    expect(body.unread).toBe(1);
    expect(body.items[0]).toMatchObject({ text: 'The minimap hides my coin on a phone.', contact: '@player on X', wallet: null, page: '/play', room: 'arena', viewport: '390x844', build: '0.1.0', read: false });
    expect(body.items[0].id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('names the session wallet, never a wallet the body claims', async () => {
    const player = testSigner().address;
    const other = testSigner().address;
    expect((await h.call('POST', '/api/feedback', { wallet: player, body: message({ text: 'Signed in.', wallet: other }) })).status).toBe(201);
    const list = (await h.call('GET', '/api/admin/feedback', { wallet: h.admin })).body as FeedbackList;
    expect(list.items[0]).toMatchObject({ text: 'Signed in.', wallet: player });
    // a token that does not verify is a guest (the message is still taken)
    expect((await h.call('POST', '/api/feedback', { token: 'not-a-token', body: message({ text: 'Stale session.' }) })).status).toBe(201);
    expect(((await h.call('GET', '/api/admin/feedback', { wallet: h.admin })).body as FeedbackList).items[0]).toMatchObject({ text: 'Stale session.', wallet: null });
  });

  it('keeps the text as plain text (control characters removed, markup as typed) and answers JSON', async () => {
    const text = '<img src=x onerror=alert(1)>\nline two\u0007‮';
    expect((await h.call('POST', '/api/feedback', { body: { text } })).status).toBe(201);
    const list = await h.call('GET', '/api/admin/feedback', { wallet: h.admin });
    expect(list.headers.get('content-type')).toMatch(/^application\/json/);
    expect((list.body as FeedbackList).items[0]).toMatchObject({ text: '<img src=x onerror=alert(1)>\nline two', page: '', viewport: '', build: '', room: null, contact: '' });
  });

  it('refuses a message without text, too long, or with context that is not the sheet’s', async () => {
    const no = async (body: unknown, field: string) => {
      const r = await h.call('POST', '/api/feedback', { body });
      expect(r.status).toBe(400);
      expect(r.body.field).toBe(field);
    };
    await no({ text: '   ' }, 'text');
    await no({ contact: 'me' }, 'text');
    await no({ text: 'x'.repeat(FEEDBACK_LIMITS.text + 1) }, 'text');
    await no({ text: 'hi', contact: 'c'.repeat(FEEDBACK_LIMITS.contact + 1) }, 'contact');
    await no({ text: 'hi', room: 'casino' }, 'room');
    await no({ text: 'hi', viewport: 'big' }, 'viewport');
    await no({ text: 'hi', page: 'https://evil.example/' }, 'page');
    await no({ text: 'hi', build: '<b>' }, 'build');
    await no({ text: 42 }, 'text');
    expect((await h.call('POST', '/api/feedback', { body: { text: 'x'.repeat(FEEDBACK_LIMITS.text) } })).status).toBe(201);
    expect((await h.call('POST', '/api/feedback', { raw: 'text=hi', type: 'text/plain' })).status).toBe(415);
    expect((await h.call('POST', '/api/feedback', { raw: JSON.stringify({ text: 'x'.repeat(FEEDBACK_LIMITS.bodyBytes) }) })).status).toBe(413);
    expect((await h.call('GET', '/api/feedback')).status).toBe(405);
  });

  it('lets the admin mark messages read and unread, all read, and delete one', async () => {
    const first = ((await h.call('GET', '/api/admin/feedback', { wallet: h.admin })).body as FeedbackList).items[0];
    const marked = await h.call('PUT', `/api/admin/feedback/${first.id}`, { wallet: h.admin, body: { read: true } });
    expect(marked.status).toBe(200);
    expect(marked.body.entry).toMatchObject({ id: first.id, read: true });
    const unread = ((await h.call('GET', '/api/admin/feedback?unread=1', { wallet: h.admin })).body as FeedbackList).items;
    expect(unread.some((e) => e.id === first.id)).toBe(false);
    expect((await h.call('PUT', `/api/admin/feedback/${first.id}`, { wallet: h.admin, body: { read: false } })).body.entry.read).toBe(false);
    expect((await h.call('PUT', `/api/admin/feedback/${first.id}`, { wallet: h.admin, body: { read: 'yes' } })).status).toBe(400);
    expect((await h.call('PUT', `/api/admin/feedback/${first.id}`, { wallet: testSigner().address, body: { read: true } })).status).toBe(403);

    expect((await h.call('POST', '/api/admin/feedback/read-all', { wallet: h.admin })).body).toEqual({ unread: 0 });
    const del = await h.call('DELETE', `/api/admin/feedback/${first.id}`, { wallet: h.admin });
    expect(del.status).toBe(200);
    expect((await h.call('DELETE', `/api/admin/feedback/${first.id}`, { wallet: h.admin })).status).toBe(404);
    expect((await h.call('DELETE', '/api/admin/feedback/nope', { wallet: h.admin })).status).toBe(404);
    const after = (await h.call('GET', '/api/admin/feedback?limit=2', { wallet: h.admin })).body as FeedbackList;
    expect(after.items).toHaveLength(2);
    expect(after.items.some((e) => e.id === first.id)).toBe(false);
    // admin writes are in the audit log
    expect(h.app.site.audit.recent(10).some((e) => e.path === `/api/admin/feedback/${first.id}` && e.method === 'DELETE')).toBe(true);
  });

  it('stores the messages in DATA_DIR/site/feedback.jsonl (not per chain), one JSON line each', () => {
    const file = join(h.dir, 'site', 'feedback.jsonl');
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(h.app.site.feedback.list().total);
    for (const l of lines) expect(JSON.parse(l)).toHaveProperty('text');
    const chains = join(h.dir, 'chains');
    for (const id of existsSync(chains) ? readdirSync(chains) : []) expect(readdirSync(join(chains, id))).not.toContain('feedback.jsonl');
  });
});

describe('player feedback: rate limits', () => {
  it('limits a client, a wallet and the whole server', async () => {
    const h = await harness({ feedbackIp: new Limiter(3, 60_000), feedbackWallet: new Limiter(1, 60_000), feedbackAll: new Limiter(2, 60_000) });
    try {
      const player = testSigner().address;
      expect((await h.call('POST', '/api/feedback', { wallet: player, body: message() })).status).toBe(201);
      // the same wallet again: its own limit
      const again = await h.call('POST', '/api/feedback', { wallet: player, body: message() });
      expect(again.status).toBe(429);
      expect(again.body.error).toBe('rate_limited');
      // a guest: the server-wide cap is at 2 stored messages
      expect((await h.call('POST', '/api/feedback', { body: message() })).status).toBe(201);
      // the client's 4th request: its own limit (3), before the body is read
      expect((await h.call('POST', '/api/feedback', { body: message() })).status).toBe(429);
      expect(h.app.site.feedback.list().total).toBe(2);
    } finally {
      await h.app.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
    const all = await harness({ feedbackAll: new Limiter(1, 60_000) });
    try {
      expect((await all.call('POST', '/api/feedback', { body: message() })).status).toBe(201);
      const full = await all.call('POST', '/api/feedback', { body: message() });
      expect(full.status).toBe(429);
      expect(full.body.message).toMatch(/Many messages/);
    } finally {
      await all.app.close();
      rmSync(all.dir, { recursive: true, force: true });
    }
  });
});

describe('FeedbackStore', () => {
  const input = (text: string) => parseFeedback({ text });

  it('keeps the newest messages, compacts the file past the cap and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-feedback-store-'));
    try {
      const file = join(dir, 'site', 'feedback.jsonl');
      let t = 1_000;
      const s = new FeedbackStore(file, { kept: 30, now: () => t++ });
      for (let i = 0; i < 75; i++) s.add(input(`m${i}`), null);
      expect(s.list({ limit: 500 }).items.map((e) => e.text)).toEqual(Array.from({ length: 30 }, (_, i) => `m${74 - i}`));
      // the file holds at most the cap plus a twentieth (at least 20) before a rewrite
      expect(readFileSync(file, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(50);
      // a torn last line and a duplicate are dropped on load; the file is rewritten to what is kept
      appendFileSync(file, '{"id":"torn');
      const again = new FeedbackStore(file, { kept: 30 });
      expect(again.list({ limit: 500 }).items.map((e) => e.text)).toEqual(s.list({ limit: 500 }).items.map((e) => e.text));
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(30);
      expect(readdirSync(join(dir, 'site'))).toEqual(['feedback.jsonl']);
      // offset pages through, newest first
      expect(again.list({ limit: 2, offset: 2 }).items.map((e) => e.text)).toEqual(['m72', 'm71']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the default cap at 5,000 messages', () => {
    const s = new FeedbackStore(null);
    for (let i = 0; i < FEEDBACK_LIMITS.kept + 3; i++) s.add(input(`m${i}`), null);
    const list = s.list({ limit: 1 });
    expect(list.total).toBe(5000);
    expect(list.items[0].text).toBe(`m${FEEDBACK_LIMITS.kept + 2}`);
  });
});
