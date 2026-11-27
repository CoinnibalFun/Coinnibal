import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPETIZER_CODE_RE, APPETIZER_LIMITS, type AppetizerList, type AppetizerResponse } from '@coinnibal/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { AppetizerService, appetizerPage, claimHandle, claimWallet, parsePostUrl, postCarriesCard } from '../src/site/appetizer';
import type { XFetch } from '../src/xlink';
import type { SiteLimits } from '../src/site/routes';
import { SITE_FILES, SiteStore } from '../src/site/store';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

const roomy = () => new Limiter(10_000, 60_000);

/**
 * A fake X: what the syndication endpoint (`synd`) and the oEmbed endpoint (`oembed`) answer for a post id: a JSON
 * body, an HTTP status, or 'throw' (unreachable). An id neither knows answers 404 (no such post).
 */
const fakeX = { synd: new Map<string, unknown>(), oembed: new Map<string, unknown>(), calls: 0 };
const xFetch: XFetch = async (url) => {
  fakeX.calls++;
  const synd = url.startsWith('https://cdn.syndication.twimg.com/');
  const id = synd ? /[?&]id=(\d+)/.exec(url)![1] : /status%2F(\d+)/.exec(url)![1];
  const v = (synd ? fakeX.synd : fakeX.oembed).get(id);
  if (v === 'throw') throw new TypeError('fetch failed');
  const status = typeof v === 'number' ? v : v === undefined ? 404 : 200;
  const bytes = Buffer.from(status === 200 ? JSON.stringify(v) : '');
  return {
    ok: status < 400,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
};
/** A syndication answer: a post by `handle` with `text` and the links X expanded. */
const tweet = (id: string, handle: string, text: string, expanded: string[] = []) => ({
  __typename: 'Tweet',
  id_str: id,
  text,
  created_at: new Date().toISOString(),
  entities: { urls: expanded.map((u, i) => ({ url: `https://t.co/x${i}`, expanded_url: u, display_url: u.replace(/^https:\/\//, '') })) },
  user: { id_str: '1700000000000000001', screen_name: handle, name: 'Fan' },
});

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
    xFetch,
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

const claim = (h: Harness, wallet: string, handle: string, extra: Record<string, unknown> = {}) => h.call('POST', '/api/appetizer', { body: { wallet, handle, followed: true, ...extra } });

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
    const b = await claim(h, bob, 'https://x.com/CoinFan', { liked: true });
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
      const r = await h.call('POST', '/api/appetizer', { body: { wallet, handle: 'fine_one', followed: true } });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'bad_wallet', field: 'wallet' });
    }
    for (const handle of ['', 'a-b', 'x'.repeat(16), '@', 7]) {
      const r = await h.call('POST', '/api/appetizer', { body: { wallet: testSigner().address, handle, followed: true } });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'bad_handle', field: 'handle' });
    }
    expect((await h.call('POST', '/api/appetizer', { raw: 'wallet=1', type: 'text/plain' })).status).toBe(415);
    expect((await h.call('POST', '/api/appetizer', { raw: JSON.stringify({ wallet: alice, handle: 'x'.repeat(APPETIZER_LIMITS.bodyBytes) }) })).status).toBe(413);
    expect((await h.call('GET', '/api/appetizer')).status).toBe(405);
  });

  it('needs the follow: 400 follow_required without followed: true, and no card handed out', async () => {
    const wallet = testSigner().address;
    for (const body of [{ wallet, handle: 'no_follow' }, { wallet, handle: 'no_follow', followed: false }, { wallet, handle: 'no_follow', followed: 'true' }, { wallet, handle: 'no_follow', followed: 1 }]) {
      const r = await h.call('POST', '/api/appetizer', { body });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'follow_required', field: 'followed' });
    }
    const list = (await h.call('GET', '/api/admin/appetizers?q=no_follow', { wallet: h.admin })).body as AppetizerList;
    expect(list.items).toEqual([]);
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

  it('records the X post that shared a card: by the card handle only, normalised, checked on X', async () => {
    const code = first.card.code;
    const link = `https://coinnibal.fun/appetizer/${code}`;
    // the post as the X intent writes it: the link shortened in the text, expanded in the entities
    fakeX.synd.set('1888888888888888888', tweet('1888888888888888888', 'Nibbler_01', 'Got my Coinnibal early card https://t.co/x0', [link]));
    fakeX.synd.set('42', tweet('42', 'Nibbler_01', `Early card, look: coinnibal.fun/appetizer/${code}`));
    const post = (url: unknown) => h.call('POST', `/api/appetizer/${code}/post`, { body: { url } });
    const calls = fakeX.calls;
    for (const bad of ['https://x.com/CoinFan/status/123', 'https://x.com/Nibbler_01', 'http://x.com/Nibbler_01/status/1', 'https://evil.com/Nibbler_01/status/1', 'nope', 7, `https://x.com/Nibbler_01/status/1?${'a'.repeat(300)}`]) {
      const r = await post(bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('bad_post');
    }
    // a malformed link or a link by another handle never reaches X
    expect(fakeX.calls).toBe(calls);
    expect((await post('https://mobile.twitter.com/nibbler_01/status/1888888888888888888?s=20&t=abc')).body).toEqual({ ok: true, verified: true });
    let list = (await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList;
    const mine = list.items.find((e) => e.code === code)!;
    expect(mine.post).toBe('https://x.com/nibbler_01/status/1888888888888888888');
    expect(typeof mine.postedAt).toBe('number');
    expect(mine.postVerified).toBe(true);
    expect(list.posted).toBe(1);
    expect(list.verified).toBe(1);
    expect((await post('https://www.x.com/Nibbler_01/status/42')).body).toEqual({ ok: true, verified: true });
    list = (await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList;
    expect(list.items.find((e) => e.code === code)!.post).toBe('https://x.com/Nibbler_01/status/42');
    // the complete filter
    const complete = (await h.call('GET', '/api/admin/appetizers?complete=1', { wallet: h.admin })).body as AppetizerList;
    expect(complete.items.map((e) => e.code)).toEqual([code]);
    const open = (await h.call('GET', '/api/admin/appetizers?complete=0', { wallet: h.admin })).body as AppetizerList;
    expect(open.items.map((e) => e.code)).not.toContain(code);
    expect(open.items.length).toBe(list.items.length - 1);
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
    expect(html).toContain(`<meta property="og:image" content="https://coinnibal.fun/appetizer/${code}.png?v=${first.card.at}">`);
    expect(html).toContain(`<meta name="twitter:image" content="https://coinnibal.fun/appetizer/${code}.png?v=${first.card.at}">`);
    expect(html).toContain('<meta property="og:image:height" content="675">');
    expect(html).toContain('<title>The Appetizer is out · Early card No. 0001 · @Nibbler_01</title>');
    expect(html).toContain('Grabbed my seat before the coinnibals showed up. A Coinnibal early card for early fans.');
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
    // the follow (and the like, when sent) is stamped with the claim
    expect(list.items[2]).toMatchObject({ followedAt: list.items[2].at, likedAt: null });
    expect(list.items[1]).toMatchObject({ handle: 'CoinFan', likedAt: list.items[1].at, post: null, postVerified: false });
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
    expect(lines[0]).toBe('no,handle,wallet,claimed,followed,liked,post,post_verified,complete,views');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(new RegExp(`^1,Nibbler_01,${alice},(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z),\\1,,https://x.com/Nibbler_01/status/42,yes,yes,\\d+$`));
    expect(lines[2]).toMatch(/^2,CoinFan,0x[0-9a-fA-F]{40},([^,]+),\1,\1,,,no,0$/);
  });

  it('redates a card: today on the card and its image URL, the same number, link and post', async () => {
    const code = first.card.code;
    expect((await h.call('POST', `/api/admin/appetizers/${code}/refresh`, { wallet: alice })).status).toBe(403);
    expect((await h.call('POST', `/api/admin/appetizers/AAAAAAAAAA/refresh`, { wallet: h.admin })).status).toBe(404);
    const before = ((await h.call('GET', '/api/admin/appetizers', { wallet: h.admin })).body as AppetizerList).items.find((e) => e.code === code)!;
    await new Promise((r) => setTimeout(r, 5));
    const r = await h.call('POST', `/api/admin/appetizers/${code}/refresh`, { wallet: h.admin });
    expect(r.status).toBe(200);
    const entry = (r.body as { entry: AppetizerList['items'][number] }).entry;
    expect(entry.at).toBeGreaterThan(before.at);
    expect(entry).toMatchObject({ code, no: before.no, handle: before.handle, wallet: before.wallet, post: before.post, postVerified: before.postVerified });
    expect((await h.call('GET', `/appetizer/${code}`)).text).toContain(`/appetizer/${code}.png?v=${entry.at}"`);
    // the owner's claim again brings the redated card back
    const again = await claim(h, alice, 'Nibbler_01');
    expect((again.body as AppetizerResponse).card).toMatchObject({ code, no: before.no, at: entry.at });
  });

  it('deletes a card: gone from the list, the page and the image; its number is not handed out again', async () => {
    const code = first.card.code;
    expect((await h.call('DELETE', `/api/admin/appetizers/${code}`, { wallet: h.admin })).body).toEqual({ ok: true, total: 2, posted: 0, verified: 0 });
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
  it('refuses a post X does not show, by someone else, or without the card; keeps it unchecked when X is down', async () => {
    const h = await harness();
    const { card } = (await claim(h, testSigner().address, 'Poster_9')).body as AppetizerResponse;
    const post = (id: string) => h.call('POST', `/api/appetizer/${card.code}/post`, { body: { url: `https://x.com/poster_9/status/${id}` } });
    const entry = async () => ((await h.call('GET', '/api/admin/appetizers?q=poster_9', { wallet: h.admin })).body as AppetizerList).items[0];
    // no such post (both endpoints say 404)
    let r = await post('900');
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'post_unverified', field: 'url' });
    // X says another account wrote it (a renamed handle in the link)
    fakeX.synd.set('901', tweet('901', 'someone_else', `coinnibal.fun/appetizer/${card.code}`));
    r = await post('901');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_post');
    // the post does not carry this card (another card's code does not count either)
    fakeX.synd.set('902', tweet('902', 'Poster_9', 'gm https://t.co/x0', ['https://coinnibal.fun/appetizer/ZZZZZZZZZZ']));
    r = await post('902');
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('post_unverified');
    expect((await entry()).post).toBeNull();
    // X unreachable: kept, unchecked
    fakeX.synd.set('903', 'throw');
    fakeX.oembed.set('903', 503);
    r = await post('903');
    expect(r.body).toEqual({ ok: true, verified: false });
    expect(await entry()).toMatchObject({ post: 'https://x.com/poster_9/status/903', postVerified: false });
    // only oEmbed answers, its link a t.co one: kept, unchecked
    fakeX.synd.set('904', 500);
    fakeX.oembed.set('904', { html: '<blockquote><p>my card <a href="https://t.co/abc">https://t.co/abc</a></p>&mdash; Fan <a href="https://twitter.com/Poster_9/status/904">Nov</a></blockquote>', author_url: 'https://twitter.com/Poster_9', author_name: 'Fan' });
    expect((await post('904')).body).toEqual({ ok: true, verified: false });
    // the same link again once X answers: checked now
    fakeX.synd.set('903', tweet('903', 'Poster_9', 'here https://t.co/x0', [`https://coinnibal.fun/appetizer/${card.code}?s=1`]));
    expect((await post('903')).body).toEqual({ ok: true, verified: true });
    expect(await entry()).toMatchObject({ post: 'https://x.com/poster_9/status/903', postVerified: true });
    await h.app.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

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

  it('limits image renders per IP; a cached card is served without one', async () => {
    const s = new AppetizerService({ path: null, baseUrl: () => 'https://coinnibal.fun' });
    const codes = Array.from({ length: 31 }, (_, i) => s.claim(testSigner().address, `render_${i}`).card.code);
    const req = { method: 'HEAD', headers: {} } as never;
    // the answer comes when the card is drawn (a card worker in the app; this thread here)
    const get = (code: string, ip: string) =>
      new Promise<number>((resolve) => {
        let status = 0;
        const res = { writeHead: (st: number) => (status = st), end: () => resolve(status) } as never;
        s.handle(req, res, `/appetizer/${code}.png`, ip);
      });
    for (const code of codes.slice(0, 30)) expect(await get(code, '9.9.9.9')).toBe(200);
    expect(await get(codes[30], '9.9.9.9')).toBe(429);
    expect(await get(codes[0], '9.9.9.9')).toBe(200);
    expect(await get(codes[30], '8.8.8.8')).toBe(200);
  });

  it('loads cards stored before the follow was asked with followedAt null (the CSV leaves it empty)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-appetizer-old-'));
    const file = join(dir, 'appetizers.json');
    const wallet = testSigner().address;
    writeFileSync(file, JSON.stringify({ v: 1, next: 2, cards: [{ code: 'OldCard001', no: 1, handle: 'old_fan', at: 1000, wallet, post: null, postedAt: null, views: 3 }] }));
    const s = new AppetizerService({ path: file, baseUrl: () => '' });
    expect(s.list().items).toEqual([{ code: 'OldCard001', no: 1, handle: 'old_fan', at: 1000, wallet, post: null, postedAt: null, postVerified: false, followedAt: null, likedAt: null, views: 3 }]);
    expect(s.csv().trim().split('\r\n')[1]).toBe(`1,old_fan,${wallet},1970-01-01T00:00:01.000Z,,,,,no,3`);
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a one-off redate once: card No. 3 claimed on 22 Nov 2026 takes the startup time, others stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-appetizer-fix-'));
    const file = join(dir, 'appetizers.json');
    const nov22 = Date.UTC(2026, 10, 22, 15);
    const card = (no: number, at: number) => ({ code: `FixCard00${no}`, no, handle: `fan_${no}`, at, wallet: testSigner().address, post: null, postedAt: null, views: 0 });
    writeFileSync(file, JSON.stringify({ v: 1, next: 4, cards: [card(1, nov22), card(2, nov22), card(3, nov22)] }));
    const t1 = Date.UTC(2026, 10, 26, 12);
    const s = new AppetizerService({ path: file, baseUrl: () => '', now: () => t1 });
    expect(s.list().items.map((e) => [e.no, e.at])).toEqual([[3, t1], [2, nov22], [1, nov22]]);
    s.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).fixes).toEqual(['redate-0003-2026-11']);
    // once only: a later start leaves the date alone
    const again = new AppetizerService({ path: file, baseUrl: () => '', now: () => t1 + 86_400_000 });
    expect(again.list().items[0].at).toBe(t1);
    rmSync(dir, { recursive: true, force: true });
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

  it('moves a stored earlier default post to the current one, once; a post the admin chose stays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-appetizer-post-old-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, SITE_FILES.settings), JSON.stringify({ wlOpen: false, launch: 1, xHandle: 'coinnibalfun', appetizerPostUrl: 'https://x.com/Coinnibalfun/status/2123416055406354866' }));
    expect(new SiteStore(dir).settings.appetizerPostUrl).toBe('https://x.com/Coinnibalfun/status/2126283168374251696');
    expect(JSON.parse(readFileSync(join(dir, SITE_FILES.settings), 'utf8')).appetizerPostUrl).toBe('https://x.com/Coinnibalfun/status/2126283168374251696');
    writeFileSync(join(dir, SITE_FILES.settings), JSON.stringify({ wlOpen: false, launch: 1, xHandle: 'coinnibalfun', appetizerPostUrl: 'https://x.com/coinnibalfun/status/7' }));
    expect(new SiteStore(dir).settings.appetizerPostUrl).toBe('https://x.com/coinnibalfun/status/7');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the post to like and comment on: the Appetizer post by default, a status link, null hides it (kept across a restart)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-appetizer-post-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    // a settings file from before the setting existed: the default
    writeFileSync(join(dir, SITE_FILES.settings), JSON.stringify({ wlOpen: false, launch: 1, xHandle: 'coinnibalfun' }));
    const s = new SiteStore(dir);
    expect(s.settings.appetizerPostUrl).toBe('https://x.com/Coinnibalfun/status/2126283168374251696');
    expect(() => s.updateSettings({ appetizerPostUrl: 'https://example.com/x' })).toThrow();
    expect(s.updateSettings({ appetizerPostUrl: 'https://x.com/coinnibalfun/status/7' }).appetizerPostUrl).toBe('https://x.com/coinnibalfun/status/7');
    expect(new SiteStore(dir).settings.appetizerPostUrl).toBe('https://x.com/coinnibalfun/status/7');
    expect(s.updateSettings({ appetizerPostUrl: '' }).appetizerPostUrl).toBeNull();
    expect(new SiteStore(dir).settings.appetizerPostUrl).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows our post (appetizerPostUrl, only that one) for the sheet box: read from X once, cached, null when unset or unreadable', async () => {
    const h = await harness();
    const id = '2126283168374251696';
    fakeX.synd.set(id, {
      ...tweet(id, 'Coinnibalfun', 'The kitchen is open &amp; hungry https://t.co/x0 https://t.co/pic', ['https://coinnibal.fun']),
      user: { id_str: '1', screen_name: 'Coinnibalfun', name: 'Coinnibal', profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/me_normal.png' },
      photos: [{ url: 'https://pbs.twimg.com/media/Gabc123.jpg', width: 1200, height: 675 }],
    });
    const calls = fakeX.calls;
    const r = await h.call('GET', '/api/appetizer/post');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.body.post).toMatchObject({
      url: `https://x.com/Coinnibalfun/status/${id}`,
      handle: 'Coinnibalfun',
      name: 'Coinnibal',
      avatar: 'https://pbs.twimg.com/profile_images/1/me_400x400.png',
      text: 'The kitchen is open & hungry coinnibal.fun',
      photo: { url: 'https://pbs.twimg.com/media/Gabc123.jpg', width: 1200, height: 675 },
    });
    // visitors share one read: no second call to X
    expect(fakeX.calls).toBe(calls + 1);
    expect((await h.call('GET', '/api/appetizer/post?url=https://x.com/a/status/1')).body.post.handle).toBe('Coinnibalfun');
    expect(fakeX.calls).toBe(calls + 1);
    expect((await h.call('POST', '/api/appetizer/post')).status).toBe(405);
    // no post set: nothing, and X is not asked
    h.app.site.store.updateSettings({ appetizerPostUrl: null });
    expect((await h.call('GET', '/api/appetizer/post')).body).toEqual({ post: null });
    // a post X does not show: null (the box links to X only)
    h.app.site.store.updateSettings({ appetizerPostUrl: 'https://x.com/Coinnibalfun/status/77' });
    expect((await h.call('GET', '/api/appetizer/post')).body).toEqual({ post: null });
    h.app.site.store.updateSettings({ appetizerPostUrl: `https://x.com/Coinnibalfun/status/${id}` });
    expect((await h.call('GET', '/api/appetizer/post')).body.post.handle).toBe('Coinnibalfun');
    await h.app.close();
    rmSync(h.dir, { recursive: true, force: true });
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

  it('postCarriesCard: the code as a word of its own, in the text or an expanded link', () => {
    expect(postCarriesCard({ text: 'look coinnibal.fun/appetizer/AbCdEfGhIj', urls: null }, 'AbCdEfGhIj')).toBe(true);
    expect(postCarriesCard({ text: 'https://t.co/1', urls: ['https://coinnibal.fun/appetizer/AbCdEfGhIj'] }, 'AbCdEfGhIj')).toBe(true);
    expect(postCarriesCard({ text: 'abcdefghij', urls: [] }, 'AbCdEfGhIj')).toBe(false);
    expect(postCarriesCard({ text: 'xAbCdEfGhIjx', urls: [] }, 'AbCdEfGhIj')).toBe(false);
  });

  it('the page escapes what it prints', () => {
    const html = appetizerPage({ code: 'AbCdEfGhIj', no: 42, handle: 'a_b', at: 0 }, 'https://coinnibal.fun');
    expect(html).toContain('The Appetizer is out · Early card No. 0042 · @a_b');
    expect(html).not.toMatch(/<script/i);
  });
});
