import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPETIZER_CODE_RE, APPETIZER_LIMITS, type AppetizerList, type AppetizerResponse } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { AppetizerService, appetizerPage, claimHandle, claimWallet, parsePostUrl } from '../src/site/appetizer';
import type { SiteLimits } from '../src/site/routes';
import { SITE_FILES, SiteStore } from '../src/site/store';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

const roomy = () => new Limiter(10_000, 60_000);

interface Harness {
  app: App;
  dir: string;
  admin: string;
  port: number;
  call(method: string, path: string, opts?: { wallet?: string | null; body?: unknown; raw?: string; type?: string }): Promise<{ status: number; body: any; text: string; headers: Headers }>;
}

async function harness(limits: Partial<SiteLimits> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-appetizer-'));
  const admin = testSigner().address;
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0', PUBLIC_URL: 'https://coinnibal.fun' } as NodeJS.ProcessEnv);
  const app = await createApp(cfg, {
    chain: new ArenaChain([arena(1, 1000)]),
    log: () => {},
    persist: true,
    siteLimits: { writeIp: roomy(), writeWallet: roomy(), login: roomy(), appetizerIp: roomy(), appetizerPostIp: roomy(), ...limits },
    apiLimiter: roomy(),
  });
  const port = await app.listen();
  const call: Harness['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = {};
    if (opts.wallet) headers.Authorization = `Bearer ${app.auth.issueToken(opts.wallet)}`;
    let body: string | undefined;
    if (opts.raw !== undefined || opts.body !== undefined) {
      headers['Content-Type'] = opts.type ?? 'application/json';
      body = opts.raw ?? JSON.stringify(opts.body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  return { app, dir, admin, port, call };
}

const claim = (h: Harness, wallet: string, handle: string) => h.call('POST', '/api/appetizer', { body: { wallet, handle } });

describe('the Appetizer: claims, post links, the share page and the admin list', () => {
  let h: Harness;
  const alice = testSigner().address;
  const bob = testSigner().address;
  let first: AppetizerResponse;

  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.app.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('is open by default, also while the rest of the site is closed', async () => {
    const s = (await h.call('GET', '/api/site/settings')).body.settings;
    expect(s.appetizerOpen).toBe(true);
    expect(s).toMatchObject({ wlOpen: false, collabOpen: false, mintOpen: false, gameAccess: 'admins' });
  });

  it('hands out a numbered card with the handle as typed, never the wallet', async () => {
    const r = await claim(h, alice.toLowerCase(), '@Nibbler_01');
    expect(r.status).toBe(201);
    first = r.body as AppetizerResponse;
    expect(first.existing).toBe(false);
    expect(first.card).toMatchObject({ no: 1, handle: 'Nibbler_01' });
    expect(APPETIZER_CODE_RE.test(first.card.code)).toBe(true);
    expect(typeof first.card.at).toBe('number');
    expect(r.text.toLowerCase()).not.toContain(alice.toLowerCase().slice(2));
    // the next wallet gets the next number; a profile link counts as its handle
    const b = await claim(h, bob, 'https://x.com/CoinFan');
    expect(b.status).toBe(201);
    expect(b.body.card).toMatchObject({ no: 2, handle: 'CoinFan' });
  });

  it('gives a wallet its own card again only with its own handle (a wallet alone never reveals its handle)', async () => {
    const again = await claim(h, alice, first.card.handle.toUpperCase());
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ card: first.card, existing: true });
    const r = await claim(h, alice, 'someone_else');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('wallet_taken');
    expect(r.text).not.toContain(first.card.handle);
    expect(r.text).not.toContain(first.card.code);
  });

  it('refuses a handle another wallet holds (any case, @ or link)', async () => {
    for (const handle of ['nibbler_01', '@NIBBLER_01', 'https://twitter.com/Nibbler_01']) {
      const r = await claim(h, testSigner().address, handle);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('handle_taken');
    }
  });

  it('refuses a bad wallet or handle', async () => {
    const wallets = ['nope', '0x' + '0'.repeat(40), '0x' + 'a'.repeat(39), 42, null];
    for (const wallet of wallets) {
      const r = await h.call('POST', '/api/appetizer', { body: { wallet, handle: 'fine_one' } });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'bad_wallet', field: 'wallet' });
    }
    for (const handle of ['', 'a-b', 'x'.repeat(16), '@', 7]) {
      const r = await h.call('POST', '/api/appetizer', { body: { wallet: testSigner().address, handle } });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'bad_handle', field: 'handle' });
    }
    expect((await h.call('POST', '/api/appetizer', { raw: 'wallet=1', type: 'text/plain' })).status).toBe(415);
    expect((await h.call('POST', '/api/appetizer', { raw: JSON.stringify({ wallet: alice, handle: 'x'.repeat(APPETIZER_LIMITS.bodyBytes) }) })).status).toBe(413);
    expect((await h.call('GET', '/api/appetizer')).status).toBe(405);
  });

  it('answers 403 closed while the admin has it off', async () => {
    expect((await h.call('PUT', '/api/admin/settings', { wallet: h.admin, body: { appetizerOpen: false } })).body.settings.appetizerOpen).toBe(false);
    expect((await h.call('GET', '/api/site/settings')).body.settings.appetizerOpen).toBe(false);
    const r = await claim(h, testSigner().address, 'late_one');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('closed');
    expect((await h.call('PUT', '/api/admin/settings', { wallet: h.admin, body: { appetizerOpen: true } })).body.settings.appetizerOpen).toBe(true);
    expect((await claim(h, testSigner().address, 'late_one')).status).toBe(201);
  });

  it('records the X post that shared a card: by the card handle only, normalised', async () => {
    const code = first.card.code;
    const post = (url: unknown) => h.call('POST', `/api/appetizer/${code}/post`, { body: { url } });
    for (const bad of ['https://x.com/CoinFan/status/123', 'https://x.com/Nibbler_01', 'http://x.com/Nibbler_01/status/1', 'https://evil.com/Nibbler_01/status/1', 'nope', 7, `https://x.com/Nibbler_01/status/1?${'a'.repeat(300)}`]) {
      const r = await post(bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('bad_post');
    }
    expect((await post('https://mobile.twitter.com/nibbler_01/status/1888888888888888888?s=20&t=abc')).body).toEqual({ ok: true });
    let list = (await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList;
    const mine = list.items.find((e) => e.code === code)!;
    expect(mine.post).toBe('https://x.com/nibbler_01/status/1888888888888888888');
    expect(typeof mine.postedAt).toBe('number');
    expect(list.posted).toBe(1);
    expect((await post('https://www.x.com/Nibbler_01/status/42')).status).toBe(200);
    list = (await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList;
    expect(list.items.find((e) => e.code === code)!.post).toBe('https://x.com/Nibbler_01/status/42');
    const unknown = await h.call('POST', '/api/appetizer/AAAAAAAAAA/post', { body: { url: 'https://x.com/a/status/1' } });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('not_found');
    expect((await h.call('POST', '/api/appetizer/short/post', { body: { url: 'https://x.com/a/status/1' } })).status).toBe(404);
  });

  it('serves the share page with the card tags and absolute URLs, never the wallet', async () => {
    const code = first.card.code;
    const r = await h.call('GET', `/appetizer/${code}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = r.text;
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<meta property="og:image" content="https://coinnibal.fun/appetizer/${code}.png">`);
    expect(html).toContain(`<meta name="twitter:image" content="https://coinnibal.fun/appetizer/${code}.png">`);
    expect(html).toContain('<meta property="og:image:height" content="675">');
    expect(html).toContain('<title>Appetizer No. 0001 · @Nibbler_01</title>');
    expect(html).toContain('Coinnibal: coins eating coins.');
    expect(html).toContain('url=https://coinnibal.fun/#appetizer');
    expect(html.toLowerCase()).not.toContain(alice.toLowerCase().slice(2));
    expect((await h.call('GET', '/appetizer/AAAAAAAAAA')).status).toBe(404);
    expect((await h.call('GET', '/appetizer/../etc')).status).toBe(404);
    expect((await h.call('POST', `/appetizer/${code}`)).status).toBe(405);
  });

  it('serves the card image (1200 x 675 PNG) and counts each fetch as a view', async () => {
    const code = first.card.code;
    const before = ((await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList).items.find((e) => e.code === code)!.views;
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${h.port}/appetizer/${code}.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 675]);
    }
    const after = ((await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList).items.find((e) => e.code === code)!.views;
    expect(after).toBe(before + 2);
  });

  it('keeps the admin list behind an admin session: newest first, totals, search, pages', async () => {
    expect((await h.call('GET', '/api/admin/appetizers')).status).toBe(401);
    expect((await h.call('GET', '/api/admin/appetizers', { wallet: alice })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/appetizers.csv')).status).toBe(401);
    expect((await h.call('DELETE', `/api/admin/appetizers/${first.card.code}`, { wallet: alice })).status).toBe(403);
    const list = (await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList;
    expect(list.total).toBe(3);
    expect(list.items.map((e) => e.no)).toEqual([3, 2, 1]);
    expect(list.items[2]).toMatchObject({ handle: 'Nibbler_01', wallet: alice });
    const page = (await h.call('GET', '/api/admin/appetizers?offset=1&limit=1', { wallet: h.admin })).body as AppetizerList;
    expect(page.items.map((e) => e.no)).toEqual([2]);
    expect(page.total).toBe(3);
    const byHandle = (await h.call('GET', '/api/admin/appetizers?q=%40coinfan', { wallet: h.admin })).body as AppetizerList;
    expect(byHandle.items.map((e) => e.handle)).toEqual(['CoinFan']);
    const byWallet = (await h.call('GET', `/api/admin/appetizers?q=${alice.slice(10, 20).toUpperCase()}`, { wallet: h.admin })).body as AppetizerList;
    expect(byWallet.items.map((e) => e.no)).toEqual([1]);
    expect(((await h.call('GET', '/api/admin/appetizers?limit=999999', { wallet: h.admin })).body as AppetizerList).items).toHaveLength(3);
  });

  it('exports every card as CSV', async () => {
    const r = await h.call('GET', '/api/admin/appetizers.csv', { wallet: h.admin });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="coinnibal-appetizers-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toBe('no,handle,wallet,claimed,post,views');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(new RegExp(`^1,Nibbler_01,${alice},\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z,https://x.com/Nibbler_01/status/42,\\d+$`));
    expect(lines[2]).toMatch(/^2,CoinFan,0x[0-9a-fA-F]{40},[^,]+,,0$/);
  });

  it('deletes a card: gone from the list, the page and the image; its number is not handed out again', async () => {
    const code = first.card.code;
    expect((await h.call('DELETE', `/api/admin/appetizers/${code}`, { wallet: h.admin })).body).toEqual({ ok: true, total: 2, posted: 0 });
    expect((await h.call('DELETE', `/api/admin/appetizers/${code}`, { wallet: h.admin })).status).toBe(404);
    expect((await h.call('GET', `/appetizer/${code}`)).status).toBe(404);
    expect((await h.call('GET', `/appetizer/${code}.png`)).status).toBe(404);
    // the wallet may claim again: a new card, the next number
    const again = await claim(h, alice, 'Nibbler_01');
    expect(again.status).toBe(201);
    expect(again.body.card.no).toBe(4);
  });

  it('keeps the cards across a restart (DATA_DIR/site/appetizers.json)', () => {
    h.app.site.appetizers.flush();
    const file = join(h.dir, 'site', 'appetizers.json');
    expect(existsSync(file)).toBe(true);
    const back = new AppetizerService({ path: file, baseUrl: () => 'https://coinnibal.fun' });
    expect(back.list().items.map((e) => e.no)).toEqual([4, 3, 2]);
    // numbers keep counting from where they were
    expect(back.claim(testSigner().address, 'after_restart').card.no).toBe(5);
  });
});

describe('the Appetizer: limits and fallbacks', () => {
  it('limits claims per IP', async () => {
    const h = await harness({ appetizerIp: new Limiter(2, 60 * 60_000) });
    try {
      expect((await claim(h, testSigner().address, 'one_1')).status).toBe(201);
      expect((await claim(h, testSigner().address, 'two_2')).status).toBe(201);
      const r = await claim(h, testSigner().address, 'three_3');
      expect(r.status).toBe(429);
      expect(r.body.error).toBe('rate_limited');
    } finally {
      await h.app.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('without a working canvas the image falls back to the site picture (and still counts a view)', async () => {
    const h = await harness();
    try {
      const { card } = (await claim(h, testSigner().address, 'no_canvas')).body as AppetizerResponse;
      h.app.site.appetizers.setRenderBroken('Cannot find module @napi-rs/canvas-linux-x64-gnu');
      const r = await h.call('GET', `/appetizer/${card.code}.png`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('https://coinnibal.fun/og-coinnibal.png');
      expect(h.app.site.appetizers.list().items[0].views).toBe(1);
      // the page itself is unchanged
      expect((await h.call('GET', `/appetizer/${card.code}`)).status).toBe(200);
    } finally {
      await h.app.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('limits image renders per IP; a cached card is served without one', () => {
    const s = new AppetizerService({ path: null, baseUrl: () => 'https://coinnibal.fun' });
    const codes = Array.from({ length: 31 }, (_, i) => s.claim(testSigner().address, `render_${i}`).card.code);
    const out: { status?: number } = {};
    const res = { writeHead: (status: number) => (out.status = status), end() {} } as never;
    const req = { method: 'HEAD', headers: {} } as never;
    for (const code of codes.slice(0, 30)) {
      s.handle(req, res, `/appetizer/${code}.png`, '9.9.9.9');
      expect(out.status).toBe(200);
    }
    s.handle(req, res, `/appetizer/${codes[30]}.png`, '9.9.9.9');
    expect(out.status).toBe(429);
    s.handle(req, res, `/appetizer/${codes[0]}.png`, '9.9.9.9');
    expect(out.status).toBe(200);
    s.handle(req, res, `/appetizer/${codes[30]}.png`, '8.8.8.8');
    expect(out.status).toBe(200);
  });

  it('a corrupt file is set aside, not fatal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-appetizer-bad-'));
    const file = join(dir, 'appetizers.json');
    writeFileSync(file, '{"cards": [');
    const logs: string[] = [];
    const s = new AppetizerService({ path: file, baseUrl: () => '', log: (m) => logs.push(m) });
    expect(s.total).toBe(0);
    expect(logs.join('\n')).toMatch(/unreadable/);
    expect(existsSync(file)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the public launch switch leaves the appetizer open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-appetizer-launch-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, SITE_FILES.settings), JSON.stringify({ wlOpen: true, collabOpen: true, gameAccess: 'public', xHandle: 'coinnibalfun' }));
    const s = new SiteStore(dir);
    expect(s.settings).toMatchObject({ wlOpen: false, collabOpen: false, gameAccess: 'admins', appetizerOpen: true });
    s.updateSettings({ appetizerOpen: false });
    expect(new SiteStore(dir).settings.appetizerOpen).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, SITE_FILES.settings), 'utf8')).appetizerOpen).toBe(false);
    expect(() => s.updateSettings({ appetizerOpen: 'yes' })).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the Appetizer: input helpers', () => {
  it('claimWallet: any case to EIP-55; claimHandle keeps the case as typed', () => {
    const w = testSigner().address;
    expect(claimWallet(w.toLowerCase())).toBe(w);
    expect(claimWallet(` ${w.toUpperCase().replace('0X', '0x')} `)).toBe(w);
    expect(claimHandle('@CoinFan')).toBe('CoinFan');
    expect(claimHandle('https://www.x.com/CoinFan/')).toBe('CoinFan');
    expect(() => claimHandle('coin fan')).toThrow();
  });

  it('parsePostUrl: x.com and twitter.com, www and mobile, the query dropped', () => {
    expect(parsePostUrl('https://twitter.com/a_b/status/123?s=20')).toEqual({ url: 'https://x.com/a_b/status/123', author: 'a_b' });
    expect(parsePostUrl('https://WWW.X.COM/a_b/status/9/')).toEqual({ url: 'https://x.com/a_b/status/9', author: 'a_b' });
    expect(parsePostUrl('https://x.com/a_b/status/9/photo/1')).toBeNull();
    expect(parsePostUrl('https://x.com/a_b/status/abc')).toBeNull();
    expect(parsePostUrl('https://x.com.evil/a_b/status/1')).toBeNull();
  });

  it('the page escapes what it prints', () => {
    const html = appetizerPage({ code: 'AbCdEfGhIj', no: 42, handle: 'a_b', at: 0 }, 'https://coinnibal.fun');
    expect(html).toContain('Appetizer No. 0042 · @a_b');
    expect(html).not.toMatch(/<script/i);
  });
});
