import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X_CODE_RE, X_CODE_TTL_MS, isAvatarId, xPostTime } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { encodePng } from '../src/avatars';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { EatenTracker } from '../src/rooms/eaten';
import { ShareService } from '../src/site/shares';
import { shareEaten, shareHeadline } from '../src/site/share-card';
import { XLinkService, XLinkStore, carriesCode, cleanXName, oembedText, sniffImage, xAvatarUrl, type XFetch } from '../src/xlink';
import { TICK_MS, decodeSnapshot, encodeSnapshot, xLinkPostText } from '@coinnibal/shared';
import { Room } from '../src/rooms/room';
import { ArenaChain, arena, fakeConn, freeCustom, roomDeps, testWallet } from './helpers';

const T0 = 1_800_000_000_000;
/** A post id (snowflake) made at `ms`. */
const postId = (ms: number, seq = 7) => String((BigInt(ms - 1288834974657) << 22n) | BigInt(seq));
const postUrl = (ms: number, handle = 'someone') => `https://x.com/${handle}/status/${postId(ms)}`;

const W1 = testWallet(0x101);
const W2 = testWallet(0x202);
const IP = '203.0.113.9';

interface FakeX {
  fetch: XFetch;
  calls: string[];
  /** What the syndication endpoint answers: a post, a status, or a thrown error (down). */
  synd: { text: string; screen_name: string; id_str: string; name?: string; avatar?: string; created_at?: string } | number | 'throw';
  oembed: { html: string; author_url: string; author_name?: string } | number | 'throw';
  picture: { bytes: Buffer; type: string } | number;
}

function fakeX(): FakeX {
  const x: FakeX = {
    calls: [],
    synd: 503,
    oembed: 503,
    picture: 404,
    fetch: async (url) => {
      x.calls.push(url);
      const answer = (status: number, body: Buffer | string = '', type = 'application/json') => {
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
        return {
          ok: status < 400,
          status,
          headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? type : n.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
      };
      if (url.startsWith('https://pbs.twimg.com/')) return typeof x.picture === 'number' ? answer(x.picture) : answer(200, x.picture.bytes, x.picture.type);
      const which = url.startsWith('https://cdn.syndication.twimg.com/') ? x.synd : x.oembed;
      if (which === 'throw') throw new Error('fetch failed');
      if (typeof which === 'number') return answer(which);
      if (url.startsWith('https://cdn.syndication.twimg.com/')) {
        const s = which as Exclude<FakeX['synd'], number | 'throw'>;
        const id = /[?&]id=([0-9]+)/.exec(url)![1];
        return answer(
          200,
          JSON.stringify({
            __typename: 'Tweet',
            id_str: id,
            text: s.text,
            ...(s.created_at ? { created_at: s.created_at } : {}),
            user: { id_str: s.id_str, screen_name: s.screen_name, name: s.name ?? 'Penny Lane', profile_image_url_https: s.avatar ?? `https://pbs.twimg.com/profile_images/99/p_normal.jpg` },
          }),
        );
      }
      return answer(200, JSON.stringify(which));
    },
  };
  return x;
}

function service(x: FakeX, dir: string | null = null, clock = { t: T0 }) {
  return new XLinkService({ dataDir: dir, fetch: x.fetch, now: () => clock.t });
}

const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]);

describe('Link X: codes', () => {
  it('issues a short-lived code, one active per wallet, rate-limited', () => {
    const clock = { t: T0 };
    const s = service(fakeX(), null, clock);
    const a = s.issueCode(W1, IP);
    expect(a.code).toMatch(X_CODE_RE);
    expect(a.code.startsWith('COIN-')).toBe(true);
    expect(a.expiresAt).toBe(T0 + X_CODE_TTL_MS);
    expect(a.text).toBe(`Joining the coin party \u{1FA99} my code: ${a.code} coinnibal.fun`);
    expect(a.intentUrl).toBe(`https://x.com/intent/post?text=${encodeURIComponent(a.text)}`);
    expect(s.status(W1).code?.code).toBe(a.code);
    // a new code replaces the old one
    const b = s.issueCode(W1, IP);
    expect(s.status(W1).code?.code).toBe(b.code);
    // it expires
    clock.t += X_CODE_TTL_MS;
    expect(s.status(W1).code).toBeNull();
    // six codes an hour per wallet
    for (let i = 0; i < 4; i++) s.issueCode(W1, IP);
    expect(() => s.issueCode(W1, IP)).toThrow(expect.objectContaining({ code: 'rate_limited', status: 429 }));
    expect(s.issueCode(W2, IP).code).toMatch(X_CODE_RE);
  });
});

describe('Link X: the proof post', () => {
  it('links when the post carries the code and is newer than it; the account comes from X, not the link', async () => {
    const x = fakeX();
    const clock = { t: T0 };
    const s = service(x, null, clock);
    const { code } = s.issueCode(W1, IP);
    x.synd = { text: `Linking my X to Elymum: ${code} https://t.co/abc`, screen_name: 'penny_lane', id_str: '44196397' };
    x.picture = { bytes: jpeg(1000), type: 'image/jpeg' };
    clock.t += 60_000;
    // the handle in the typed link is ignored: X's answer names the account
    const r = await s.verify(W1, IP, postUrl(T0 + 30_000, 'elonmusk'));
    expect(r.link).toMatchObject({ handle: 'penny_lane', userId: '44196397', name: 'Penny Lane', avatar: true, linkedAt: T0 + 60_000 });
    expect(r.moved).toEqual([]);
    expect(s.links.handle(W1)).toBe('penny_lane');
    // the token X's embed script uses, and the picture's 400 x 400 variant
    const id = postId(T0 + 30_000);
    expect(x.calls[0]).toBe(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')}&lang=en`);
    expect(x.calls).toContain('https://pbs.twimg.com/profile_images/99/p_400x400.jpg');
    expect((await s.avatar('44196397'))?.type).toBe('image/jpeg');
    // the code is used up
    expect(s.status(W1).code).toBeNull();
    await expect(s.verify(W1, IP, postUrl(T0 + 30_000))).rejects.toMatchObject({ code: 'x_no_code' });
  });

  it('refuses a wrong code, an old post, a bad link, a missing post; X down is x_unreachable', async () => {
    const x = fakeX();
    const clock = { t: T0 };
    const s = service(x, null, clock);
    await expect(s.verify(W1, IP, postUrl(T0))).rejects.toMatchObject({ code: 'x_no_code' });
    const { code } = s.issueCode(W1, IP);
    clock.t += 120_000;
    // not a post link
    for (const bad of ['', 'hello', 'https://evil.com/a/status/123', 'https://x.com/penny', 'javascript:alert(1)', 42])
      await expect(s.verify(W1, IP, bad)).rejects.toMatchObject({ code: 'x_bad_url', status: 400 });
    expect(x.calls).toEqual([]);
    // the post was made before the code (its snowflake time): refused before X is even asked
    await expect(s.verify(W1, IP, postUrl(T0 - 10 * 60_000))).rejects.toMatchObject({ code: 'x_post_old' });
    expect(x.calls).toEqual([]);
    // X says the post is older than the code
    x.synd = { text: code, screen_name: 'penny', id_str: '1', created_at: new Date(T0 - 3_600_000).toUTCString() };
    await expect(s.verify(W1, IP, postUrl(T0 + 1000))).rejects.toMatchObject({ code: 'x_post_old' });
    // another code, or the code inside a longer word
    x.synd = { text: 'Linking my X to Elymum: ELYMUM-ZZZZZZ', screen_name: 'penny', id_str: '1' };
    await expect(s.verify(W1, IP, postUrl(T0 + 1000))).rejects.toMatchObject({ code: 'x_code_mismatch' });
    x.synd = { text: `x${code}Q`, screen_name: 'penny', id_str: '1' };
    await expect(s.verify(W1, IP, postUrl(T0 + 1000))).rejects.toMatchObject({ code: 'x_code_mismatch' });
    // no such post (both endpoints say so)
    x.synd = 404;
    x.oembed = 404;
    await expect(s.verify(W1, IP, postUrl(T0 + 1000))).rejects.toMatchObject({ code: 'x_not_found', status: 404 });
    // both endpoints down: a clear error, nothing linked
    x.synd = 'throw';
    x.oembed = 503;
    await expect(s.verify(W1, IP, postUrl(T0 + 1000))).rejects.toMatchObject({ code: 'x_unreachable', status: 503 });
    x.synd = 500;
    x.oembed = 'throw';
    await expect(s.verify(W1, IP, postUrl(T0 + 1000))).rejects.toMatchObject({ code: 'x_unreachable' });
    expect(s.links.get(W1)).toBeNull();
    // the code survives the failures
    expect(s.status(W1).code?.code).toBe(code);
  });

  it('falls back to oEmbed when the syndication endpoint is down (handle from author_url, no user id)', async () => {
    const x = fakeX();
    const clock = { t: T0 };
    const s = service(x, null, clock);
    const { code } = s.issueCode(W1, IP);
    const id = postId(T0 + 5000);
    x.synd = 'throw';
    x.oembed = {
      html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Linking my X to Elymum: ${code} <a href="https://t.co/x">elymum.io</a></p>&mdash; Penny (@Penny_L) <a href="https://twitter.com/Penny_L/status/${id}?ref_src=twsrc%5Etfw">November 8, 2026</a></blockquote>`,
      author_url: 'https://twitter.com/Penny_L',
      author_name: 'Penny',
    };
    const r = await s.verify(W1, IP, `https://twitter.com/whoever/status/${id}?s=20`);
    expect(r.link).toMatchObject({ handle: 'Penny_L', userId: null, avatar: false });
    expect(x.calls[1]).toBe(`https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${id}`)}&omit_script=1&dnt=true`);
    // a quote of another post is not this post
    s.issueCode(W2, IP);
    x.oembed = { html: `<p>${s.status(W2).code!.code}</p><a href="https://twitter.com/a/status/1">x</a>`, author_url: 'https://twitter.com/other' };
    await expect(s.verify(W2, IP, `https://x.com/a/status/${id}`)).rejects.toMatchObject({ code: 'x_not_found' });
  });

  it('one X account, one wallet: a newer proof moves it; unlink; kept on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-xlink-'));
    const x = fakeX();
    const clock = { t: T0 };
    const s = service(x, dir, clock);
    x.picture = { bytes: jpeg(500), type: 'image/jpeg' };
    const link = async (w: string, handle: string, userId: string) => {
      const { code } = s.issueCode(w, IP);
      x.synd = { text: code, screen_name: handle, id_str: userId };
      clock.t += 1000;
      return s.verify(w, IP, postUrl(clock.t));
    };
    await link(W1, 'penny', '11');
    expect((await link(W2, 'penny', '11')).moved).toEqual([W1]);
    expect(s.links.get(W1)).toBeNull();
    expect(s.links.handle(W2)).toBe('penny');
    // the same handle under another account id (a rename) also moves
    await link(W1, 'rocky', '22');
    expect((await link(W2, 'Rocky', '33')).moved).toEqual([W1]);
    expect(s.links.linkedHandle('rocky')).toBe(true);
    expect(s.links.linkedHandle('penny')).toBe(false);
    // kept on disk (atomic file), read back the same
    const again = new XLinkStore(join(dir, 'x-links.json'));
    expect(again.get(W2)).toMatchObject({ handle: 'Rocky', userId: '33' });
    expect(readdirSync(join(dir, 'x-avatars')).sort()).toEqual(['33.jpg']);
    // unlink: the link and the cached picture go
    expect(s.unlink(W2)).toBe(true);
    expect(s.unlink(W2)).toBe(false);
    expect(s.links.get(W2)).toBeNull();
    expect(readdirSync(join(dir, 'x-avatars'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'x-links.json'), 'utf8')).links).toEqual([]);
  });

  it('pictures: X host and https only, the 400 px variant, JPEG/PNG/WebP up to 200 KB that match their bytes', async () => {
    expect(xAvatarUrl('https://pbs.twimg.com/profile_images/1/a_normal.jpg')).toBe('https://pbs.twimg.com/profile_images/1/a_400x400.jpg');
    expect(xAvatarUrl('https://pbs.twimg.com/profile_images/1/a_bigger.png?x=1')).toBe('https://pbs.twimg.com/profile_images/1/a_400x400.png');
    for (const bad of ['http://pbs.twimg.com/profile_images/1/a.jpg', 'https://evil.com/profile_images/1/a.jpg', 'https://pbs.twimg.com.evil.com/profile_images/1/a.jpg', 'https://pbs.twimg.com/media/a.jpg', 'https://u:p@pbs.twimg.com/profile_images/1/a.jpg', 42])
      expect(xAvatarUrl(bad)).toBeNull();
    expect(sniffImage(jpeg(1))).toBe('image/jpeg');
    expect(sniffImage(encodePng(new Uint8Array(4), 1, 1, 4))).toBe('image/png');
    expect(sniffImage(Buffer.from('<svg/>'))).toBeNull();

    const x = fakeX();
    const clock = { t: T0 };
    const s = service(x, null, clock);
    const { code } = s.issueCode(W1, IP);
    x.synd = { text: code, screen_name: 'penny', id_str: '55' };
    // too large: refused (the link still works, without a picture)
    x.picture = { bytes: jpeg(200 * 1024), type: 'image/jpeg' };
    await s.verify(W1, IP, postUrl(T0 + 1000));
    expect(await s.avatar('55')).toBeNull();
    // a type X does not serve for pictures, or bytes that are not what the type says
    x.picture = { bytes: Buffer.from('<svg onload=alert(1)>'), type: 'image/svg+xml' };
    expect(await s.avatar('55')).toBeNull();
    x.picture = { bytes: Buffer.from('<html>'), type: 'image/png' };
    expect(await s.avatar('55')).toBeNull();
    // a good one is fetched once and cached
    x.picture = { bytes: jpeg(10_000), type: 'image/jpeg' };
    const n = x.calls.length;
    expect((await s.avatar('55'))?.bytes.length).toBe(10_004);
    expect((await s.avatar('55'))?.bytes.length).toBe(10_004);
    expect(x.calls.length).toBe(n + 1);
    // ids nobody linked are never fetched
    expect(await s.avatar('66')).toBeNull();
    expect(await s.avatar('../etc/passwd')).toBeNull();
    expect(x.calls.length).toBe(n + 1);
  });

  it('cleans what X answers: names, oEmbed text, the code as a word', () => {
    expect(cleanXName('  Penny‮\u0000 Lane  ')).toBe('Penny Lane');
    expect([...cleanXName('a'.repeat(80))].length).toBe(50);
    expect(oembedText('<p lang="en">Hi &amp; ELYMUM-ABCDEF<br>next <a href="x">elymum.io</a></p>&mdash; x')).toBe('Hi & ELYMUM-ABCDEF next elymum.io');
    expect(carriesCode('Linking: elymum-abcdef!', 'ELYMUM-ABCDEF')).toBe(true);
    expect(carriesCode(xLinkPostText('ELYMUM-ABCDEF'), 'ELYMUM-ABCDEF')).toBe(true);
    expect(carriesCode('ELYMUM-ABCDEFG', 'ELYMUM-ABCDEF')).toBe(false);
    // the rename: new codes are NIBAL-, and a code counts under either prefix (a page open across the deploy)
    expect(carriesCode(xLinkPostText('NIBAL-ABCDEF'), 'NIBAL-ABCDEF')).toBe(true);
    expect(carriesCode('my code: ELYMUM-ABCDEF', 'NIBAL-ABCDEF')).toBe(true);
    expect(carriesCode('my code: NIBAL-ABCDEF', 'COIN-ABCDEF')).toBe(true);
    expect(carriesCode('my code: COIN-ABCDEF', 'NIBAL-ABCDEF')).toBe(true);
    expect(carriesCode('my code: nibal-abcdef', 'ELYMUM-ABCDEF')).toBe(true);
    expect(carriesCode('my code: NIBAL-ABCDEG', 'NIBAL-ABCDEF')).toBe(false);
    expect(carriesCode('my code: OTHER-ABCDEF', 'NIBAL-ABCDEF')).toBe(false);
    expect(carriesCode('my code: XNIBAL-ABCDEF', 'NIBAL-ABCDEF')).toBe(false);
    expect(xPostTime(postId(T0))).toBe(T0);
  });
});

describe('Link X: tagging the eaten', () => {
  const look = { name: 'Nakamoto', skin: 2, country: null, flags: 0 };
  const customRoom = { opts: { id: 'priv-PONDS', mode: 'private', name: 'Friday Pond', maxPlayers: 10, custom: freeCustom() } } as never;
  const testRoom = { opts: { id: 'test-1', mode: 'arena', name: 'Test · Arena', maxPlayers: 50, stake: { arenaId: 1, buyIn: 1 }, test: { chainId: 46630 } } } as never;
  const linked = new Set(['penny_x', 'rocky']);
  const shares = () => new ShareService({ dataDir: null, baseUrl: () => 'https://elymum.io', token: () => null, xLinked: (h) => linked.has(h.toLowerCase()) });

  it('a kill card tags the victim by its linked handle (still linked, valid, never a bot)', () => {
    const s = shares();
    const k = s.kill({ room: customRoom, player: look, wallet: null }, 'c1', { mass: 900, kills: 1, victim: 'Penny', victimMass: 400, victimX: 'penny_x' })!;
    expect(k.victimX).toBe('penny_x');
    expect(shareHeadline(k)).toBe('Ate @penny_x!');
    // a handle that is not linked any more, or not a handle at all, is not tagged
    for (const [i, victimX] of ['ghost', 'pen ny', '@penny_x', 'a'.repeat(16), 'penny_x​'].entries()) {
      const c = s.kill({ room: customRoom, player: look, wallet: null }, `n${i}`, { mass: 9, kills: 1, victim: 'Penny', victimMass: 4, victimX })!;
      expect(c.victimX).toBeUndefined();
      expect(shareHeadline(c)).toBe('Ate Penny!');
    }
    // bots never have one
    const b = s.kill({ room: testRoom, player: look, wallet: null }, 'b1', { mass: 9, kills: 1, victim: 'Botty', victimMass: 4, victimIsBot: true, victimX: 'penny_x' })!;
    expect(b.victimX).toBeUndefined();
    // the per-player kill-card limit stays
    expect(s.kill({ room: customRoom, player: look, wallet: null }, 'c1', { mass: 9, kills: 2, victim: 'Rocky', victimMass: 4, victimX: 'rocky' })).toBeNull();
  });

  it('a result names linked coins by @handle in "Ate: …"', () => {
    const s = shares();
    const eaten = [{ name: 'Penny', xHandle: 'penny_x' }, { name: 'Rocky', n: 2, xHandle: 'Rocky' }, { name: 'Zed', bot: true, xHandle: 'penny_x' }, { name: 'Ed', xHandle: 'ghost' }];
    const c = s.result({ room: customRoom, player: look, wallet: null }, { rank: 1, of: 4, mass: 100, kills: 4, eaten });
    expect(c.eaten).toEqual([{ name: 'Penny', xHandle: 'penny_x' }, { name: 'Rocky', n: 2, xHandle: 'Rocky' }, { name: 'Zed', bot: true }, { name: 'Ed' }]);
    expect(shareEaten(c)).toBe('Ate: @penny_x, @Rocky ×2, Zed (BOT), Ed');
  });

  it('the room remembers the handle of each coin eaten (people only)', () => {
    const t = new EatenTracker(true);
    t.note(1, { pid: 2, name: 'Penny', bot: false, wallet: W1, xHandle: 'penny_x' });
    t.note(1, { pid: 3, name: 'Botty', bot: true, wallet: null, xHandle: 'penny_x' });
    t.note(1, { pid: 4, name: 'Ed', bot: false, wallet: null, xHandle: 'not a handle' });
    expect(t.take(1)?.eaten).toEqual([{ name: 'Penny', xHandle: 'penny_x' }, { name: 'Botty', bot: true }, { name: 'Ed' }]);
  });
});

describe('Link X: in a room', () => {
  it('the joined coin carries the handle in snapshots; a kill hands the victim handle to the share hook', () => {
    const seen: (string | null | undefined)[] = [];
    const deps = { ...roomDeps(new ArenaChain([])), onNotableKill: (e: { victimX?: string | null }) => void seen.push(e.victimX) };
    const room = new Room({ id: 'priv-XLINK', mode: 'private', code: 'XLINK', name: 'X Pond', maxPlayers: 10, bots: null, custom: freeCustom(), seed: 4 }, deps);
    const a = fakeConn(W1);
    const b = fakeConn(W2);
    const big = room.join(a, { name: 'Whale', skin: 1, flags: 0 });
    const small = room.join(b, { name: 'Penny', skin: 2, flags: 0, xHandle: 'penny_x' });
    expect(small.xHandle).toBe('penny_x');
    expect(big.xHandle).toBeNull();
    // what every viewer gets: the handle by the name (through the wire format)
    const snap = a.view.build(room.world, { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 }, { x: 0, y: 0, h: 100 });
    const players = decodeSnapshot(encodeSnapshot(snap!)).players;
    expect(players.find((p) => p.name === 'Penny')?.xHandle).toBe('penny_x');
    expect(players.find((p) => p.name === 'Whale')?.xHandle).toBeUndefined();
    for (const p of [big, small]) p.shieldUntil = 0;
    const c = small.center();
    for (const cell of big.cells) {
      cell.x = c.x;
      cell.y = c.y;
      cell.mass = 400;
    }
    for (let i = 0; i < 60 && small.alive; i++) room.tick(TICK_MS);
    expect(small.alive).toBe(false);
    expect(seen).toEqual(['penny_x']);
    // bots never carry one
    expect(room.world.addPlayer({ name: 'Bot', skin: 1, isBot: true, xHandle: 'penny_x' }).xHandle).toBeNull();
  });
});

describe('Link X: the routes', () => {
  async function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-xroutes-'));
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, TRUST_PROXY: '0', GAME_ACCESS: 'public' } as NodeJS.ProcessEnv);
    const big = () => new Limiter(10_000, 60_000);
    const x = fakeX();
    const app = await createApp(cfg, {
      chain: new ArenaChain([arena(1, 1000)]),
      log: () => {},
      persist: true,
      siteLimits: { writeIp: big(), writeWallet: big(), login: big(), avatarIp: big(), avatarWallet: big() },
      apiLimiter: big(),
      xFetch: x.fetch,
    });
    const port = await app.listen();
    const call = async (method: string, path: string, opts: { wallet?: string; body?: unknown } = {}) => {
      const headers: Record<string, string> = {};
      if (opts.wallet) headers.Authorization = `Bearer ${app.auth.issueToken(opts.wallet)}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      const bytes = Buffer.from(await res.arrayBuffer());
      let body: any = null;
      try {
        body = JSON.parse(bytes.toString('utf8'));
      } catch {
        body = null;
      }
      return { status: res.status, body, headers: res.headers, bytes };
    };
    return { app, x, call };
  }

  it('code → post → verify → picture on the coin → unlink, signed-in only', async () => {
    const h = await harness();
    try {
      expect((await h.call('GET', '/api/x')).status).toBe(401);
      expect((await h.call('POST', '/api/x/code')).status).toBe(401);
      expect((await h.call('GET', '/api/x', { wallet: W1 })).body).toEqual({ link: null, code: null });
      const issued = await h.call('POST', '/api/x/code', { wallet: W1 });
      expect(issued.status).toBe(201);
      const code = issued.body.code.code as string;
      expect(code).toMatch(X_CODE_RE);
      // a real 128 px PNG as the account's picture (the server squares and cleans it for the coin)
      const px = new Uint8Array(64 * 48 * 4).fill(200);
      h.x.picture = { bytes: encodePng(px, 64, 48, 4), type: 'image/png' };
      h.x.synd = { text: `Linking my X to Elymum: ${code} elymum.io`, screen_name: 'penny_x', id_str: '777' };
      const bad = await h.call('POST', '/api/x/verify', { wallet: W1, body: { url: 'https://example.com/nope' } });
      expect(bad).toMatchObject({ status: 400, body: { error: 'x_bad_url' } });
      const ok = await h.call('POST', '/api/x/verify', { wallet: W1, body: { url: postUrl(Date.now()) } });
      expect(ok.status).toBe(200);
      expect(ok.body.link).toMatchObject({ handle: 'penny_x', userId: '777', avatar: true });
      // the cached picture, served with safe headers (public)
      const pic = await h.call('GET', '/api/x/avatar/777');
      expect(pic.status).toBe(200);
      expect(pic.headers.get('content-type')).toBe('image/png');
      expect(pic.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await h.call('GET', '/api/x/avatar/778')).status).toBe(404);
      expect((await h.call('GET', '/api/x/avatar/..%2F..')).status).toBe(404);
      // "My X picture": it becomes the profile picture (a cleaned 128 px PNG)
      const worn = await h.call('POST', '/api/x/picture', { wallet: W1 });
      expect(worn.status).toBe(201);
      expect(isAvatarId(worn.body.profile.avatar)).toBe(true);
      expect(h.app.profiles.avatar(W1)).toBe(worn.body.profile.avatar);
      // the gateway reads the handle from the store at the join
      expect(h.app.xLinks.links.handle(W1)).toBe('penny_x');
      // unlink
      const gone = await h.call('DELETE', '/api/x', { wallet: W1 });
      expect(gone.body).toEqual({ link: null, code: null });
      expect((await h.call('GET', '/api/x/avatar/777')).status).toBe(404);
      expect((await h.call('POST', '/api/x/picture', { wallet: W1 })).body.error).toBe('x_picture_unavailable');
    } finally {
      await h.app.close();
    }
  });

  it('X being down answers x_unreachable and never touches joining', async () => {
    const h = await harness();
    try {
      await h.call('POST', '/api/x/code', { wallet: W2 });
      h.x.synd = 'throw';
      h.x.oembed = 'throw';
      const r = await h.call('POST', '/api/x/verify', { wallet: W2, body: { url: postUrl(Date.now()) } });
      expect(r).toMatchObject({ status: 503, body: { error: 'x_unreachable' } });
      expect(h.app.xLinks.links.handle(W2)).toBeNull();
    } finally {
      await h.app.close();
    }
  });
});
