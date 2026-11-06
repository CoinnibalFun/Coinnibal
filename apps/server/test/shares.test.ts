import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTABLE_KILL_MASS, PROTOCOL_VERSION, SHARE_ID_RE, TICK_MS, shareIntentUrl, type ServerMessage } from '@elymum/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { Room } from '../src/rooms/room';
import { KILL_SHARE_EVERY_MS, SHARES_KEPT, ShareService, sharePage } from '../src/site/shares';
import { renderShareCard, shareEaten, shareFacts, shareHeadline } from '../src/site/share-card';
import { ArenaChain, arena, fakeConn, freeCustom, roomDeps, testWallet } from './helpers';

const look = { name: 'Nakamoto', skin: 2, country: 'JP', flags: 8 };
const arenaRoom = { opts: { id: 'arena-1-1', mode: 'arena', name: 'Asphodel Meadow', maxPlayers: 50, stake: { arenaId: 1, buyIn: 1 } } } as never;
const testRoom = { opts: { id: 'test-1', mode: 'arena', name: 'Test · Arena', maxPlayers: 50, stake: { arenaId: 1, buyIn: 1 }, test: { chainId: 46630 } } } as never;
const customRoom = { opts: { id: 'priv-PONDS', mode: 'private', name: 'Friday Pond', maxPlayers: 10, custom: freeCustom() } } as never;

function service(dir: string | null = null, clock = { t: 1_800_000_000_000 }) {
  return new ShareService({ dataDir: dir, baseUrl: () => 'https://elymum.io', token: () => ({ decimals: 18, symbol: '$ELYMUM' }), now: () => clock.t });
}

describe('share cards (made from the server records only)', () => {
  it('a bell result: place, players, mass, kills, the net paid formatted, the wallet short, flag and emblem', () => {
    const s = service();
    const c = s.result({ room: arenaRoom, player: look, wallet: testWallet(0xabc) }, { rank: 2, of: 41, mass: 1234.7, kills: 5, payout: 2_600_000_000 });
    expect(c).toMatchObject({ kind: 'round', name: 'Nakamoto', room: 'Asphodel Meadow', rank: 2, players: 41, mass: 1234, kills: 5, paid: '2,600 $ELYMUM', country: 'JP', holder: true, skin: 2 });
    expect(c.wallet).toBe('0x0000…0aBc');
    expect(SHARE_ID_RE.test(c.id)).toBe(true);
    expect(s.get(c.id)).toEqual(c);
    // a custom room's end: no money line; a guest has no wallet
    const r = s.result({ room: customRoom, player: { ...look, flags: 0, country: null }, wallet: null }, { rank: 1, of: 3, mass: 900, kills: 2 });
    expect(r).toMatchObject({ kind: 'room', room: 'Friday Pond', wallet: null, holder: false, country: null });
    expect(r.paid).toBeUndefined();
    expect(s.get('nope')).toBeNull();
    expect(s.get('../../etc')).toBeNull();
  });

  it('a notable kill: at most one card per player every few seconds', () => {
    const clock = { t: 1_800_000_000_000 };
    const s = service(null, clock);
    const k = s.kill({ room: customRoom, player: look, wallet: null }, 'conn:7', { mass: 2500, kills: 3, victim: 'Penny', victimMass: 1800 });
    expect(k).toMatchObject({ kind: 'kill', victim: 'Penny', victimMass: 1800, mass: 2500, kills: 3 });
    expect(s.kill({ room: customRoom, player: look, wallet: null }, 'conn:7', { mass: 2600, kills: 4, victim: 'Rocky', victimMass: 1500 })).toBeNull();
    clock.t += KILL_SHARE_EVERY_MS;
    expect(s.kill({ room: customRoom, player: look, wallet: null }, 'conn:7', { mass: 2600, kills: 4, victim: 'Rocky', victimMass: 1500 })).not.toBeNull();
  });

  it('keeps the newest cards on disk across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-shares-'));
    const a = service(dir);
    const c = a.result({ room: customRoom, player: look, wallet: null }, { rank: 1, of: 2, mass: 10, kills: 0 });
    a.flush();
    expect(existsSync(join(dir, 'site', 'shares.json'))).toBe(true);
    expect(service(dir).get(c.id)).toEqual(c);
    expect(SHARES_KEPT).toBeGreaterThanOrEqual(1000);
    expect(JSON.parse(readFileSync(join(dir, 'site', 'shares.json'), 'utf8')).cards).toHaveLength(1);
  });

  it('the page carries the Open Graph and Twitter card tags with the absolute image, names escaped', () => {
    const s = service();
    const c = s.kill({ room: customRoom, player: { ...look, name: '<b>"x"</b>' }, wallet: null }, 'k', { mass: 2000, kills: 1, victim: 'Penny & Co', victimMass: 1500 })!;
    const html = sharePage(c, 'https://elymum.io');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<meta property="og:image" content="https://elymum.io/share/${c.id}.png">`);
    expect(html).toContain(`<meta name="twitter:image" content="https://elymum.io/share/${c.id}.png">`);
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('Ate Penny &#38; Co!');
    expect(html).not.toContain('<b>"x"</b>');
    expect(shareIntentUrl('I just ate Penny on Elymum! 🪙', `https://elymum.io/share/${c.id}`)).toBe(
      `https://x.com/intent/post?text=I%20just%20ate%20Penny%20on%20Elymum!%20%F0%9F%AA%99&url=https%3A%2F%2Felymum.io%2Fshare%2F${c.id}`,
    );
  });

  it('without a working canvas the image falls back to the site picture; the page itself runs no script', () => {
    const s = service();
    const c = s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 1, of: 2, mass: 10, kills: 0 });
    const out: { status?: number; headers?: Record<string, string | number> } = {};
    const res = {
      writeHead(status: number, headers: Record<string, string | number>) {
        out.status = status;
        out.headers = headers;
      },
      end() {},
    } as never;
    const req = (path: string) => ({ method: 'GET', url: path, headers: {} }) as never;
    s.setRenderBroken('Cannot find module @napi-rs/canvas-linux-x64-gnu');
    expect(s.handle(req(`/share/${c.id}.png`), res, `/share/${c.id}.png`, '1.2.3.4')).toBe(true);
    expect(out).toMatchObject({ status: 302, headers: { Location: 'https://elymum.io/og-elymum.png' } });
    s.handle(req(`/share/${c.id}`), res, `/share/${c.id}`, '1.2.3.4');
    expect(out.status).toBe(200);
    expect(String(out.headers!['Content-Security-Policy'])).toMatch(/default-src 'none'/);
  });

  it('a result names the coins I ate (cleaned again, five and "+N"); a test arena card says TEST and shows no payout', () => {
    const s = service();
    const eaten = [{ name: '@Penny' }, { name: 'Rocky', n: 2 }, { name: 'a.b.c' }, { name: 'Zed', bot: true }, { name: 'Ed' }, { name: 'Flo' }];
    const c = s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 1, of: 9, mass: 2000, kills: 7, payout: 5_000_000_000, eaten, eatenMore: 2 });
    expect(c.eaten).toEqual([{ name: 'Penny' }, { name: 'Rocky', n: 2 }, { name: 'a\u00B7b\u00B7c' }, { name: 'Zed', bot: true }, { name: 'Ed' }]);
    expect(c.eatenMore).toBe(3);
    expect(c.test).toBeUndefined();
    expect(shareEaten(c)).toBe('Ate: Penny, Rocky \u00D72, a\u00B7b\u00B7c, Zed (BOT), Ed +3');
    expect(shareFacts(c)).toContain('took home 5,000 $ELYMUM');
    const t = s.result({ room: testRoom, player: look, wallet: testWallet(1) }, { rank: 2, of: 4, mass: 900, kills: 1, payout: 5_000_000_000, eaten: [{ name: 'Botty', bot: true }] });
    expect(t).toMatchObject({ kind: 'round', test: true, eaten: [{ name: 'Botty', bot: true }] });
    expect(t.paid).toBeUndefined();
    expect(shareFacts(t).join(' ')).not.toMatch(/took home/);
    const html = sharePage(t, 'https://elymum.io');
    expect(html).toContain('<title>TEST · Nakamoto · 2nd of 4 · Elymum</title>');
    expect(html).toContain('A testnet test arena: practice tokens, no real money.');
    // nobody eaten: no line
    expect(shareEaten(s.result({ room: customRoom, player: look, wallet: null }, { rank: 1, of: 2, mass: 10, kills: 0 }))).toBeNull();
  });

  it('a bot kill card only in a test arena (tagged BOT and TEST); never in another room', () => {
    const s = service();
    const k = { mass: 2500, kills: 3, victim: 'Botty', victimMass: 1800, victimIsBot: true };
    expect(s.kill({ room: customRoom, player: look, wallet: null }, 'c1', k)).toBeNull();
    expect(s.kill({ room: arenaRoom, player: look, wallet: null }, 'c2', k)).toBeNull();
    const card = s.kill({ room: testRoom, player: look, wallet: null }, 'c3', k)!;
    expect(card).toMatchObject({ kind: 'kill', victim: 'Botty', victimBot: true, test: true });
    expect(shareHeadline(card)).toBe('Ate Botty (BOT)!');
  });

  it('renders the names and the TEST stamp on the 1200 x 630 card', async () => {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const s = service();
    const eaten = [{ name: 'Penny' }, { name: 'Rocky', n: 2 }, { name: 'Zed', bot: true }];
    const real = renderShareCard(s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 1, of: 9, mass: 2000, kills: 4, eaten, eatenMore: 1 }));
    const test = renderShareCard(s.result({ room: testRoom, player: look, wallet: null }, { rank: 1, of: 9, mass: 2000, kills: 4, eaten, eatenMore: 1 }));
    const pixel = async (png: Buffer, x: number, y: number) => {
      const img = await loadImage(png);
      const cv = createCanvas(img.width, img.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      expect([img.width, img.height]).toEqual([1200, 630]);
      return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    };
    // the coral TEST stamp sits at the sticker's top right; the real card is plain cream there
    expect(await pixel(test, 1000, 100)).toEqual([0xe4, 0x57, 0x2e]);
    expect(await pixel(real, 1000, 100)).toEqual([0xf6, 0xee, 0xda]);
    // a very long list still fits (names drop into "+N"; never drawn past the sticker)
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `LongCoinName${i}xx` }));
    expect(renderShareCard(s.result({ room: arenaRoom, player: look, wallet: null }, { rank: 3, of: 50, mass: 10, kills: 9, eaten: many, eatenMore: 40 })).length).toBeGreaterThan(1000);
  });

  it('the startup self-check draws with the real addon here', async () => {
    const { shareCardSelfCheck } = await import('../src/site/share-card');
    expect(shareCardSelfCheck()).toEqual({ ok: true });
  });
});

describe('the notable-kill hook of a room', () => {
  it('fires for the killer when a person eats a person who reached NOTABLE_KILL_MASS; never for bots or small coins', () => {
    const seen: { victim: string; victimMass: number; killer: string }[] = [];
    const deps = { ...roomDeps(new ArenaChain([])), onNotableKill: (e: { victim: string; victimMass: number; killer: { name: string } }) => seen.push({ victim: e.victim, victimMass: e.victimMass, killer: e.killer.name }) };
    const room = new Room({ id: 'priv-KILLS', mode: 'private', code: 'KILLS', name: 'Kills', maxPlayers: 10, bots: null, custom: freeCustom(), seed: 4 }, deps);
    const eat = (victimMass: number, victimName: string) => {
      const a = fakeConn(null);
      const b = fakeConn(null);
      const big = room.join(a, { name: 'Whale', skin: 1, flags: 0 });
      const small = room.join(b, { name: victimName, skin: 2, flags: 0 });
      for (const p of [big, small]) p.shieldUntil = 0;
      small.stats.maxMass = victimMass;
      const c = small.center();
      for (const cell of big.cells) {
        cell.x = c.x;
        cell.y = c.y;
        cell.mass = Math.max(victimMass, 50) * 4;
      }
      for (let i = 0; i < 60 && small.alive; i++) room.tick(TICK_MS);
      expect(small.alive).toBe(false);
      room.leave(a, 'left');
    };
    eat(NOTABLE_KILL_MASS + 200, 'Penny');
    eat(NOTABLE_KILL_MASS - 1, 'Tiny');
    expect(seen).toEqual([{ victim: 'Penny', victimMass: NOTABLE_KILL_MASS + 200, killer: 'Whale' }]);
  });
});

describe('share cards over HTTP and WebSocket', () => {
  let app: App | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('a custom room end sends my card; /share/<id> serves the page and a 1200 x 630 PNG; unknown ids are 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-share-http-'));
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, TRUST_PROXY: '0', GAME_ACCESS: 'public', NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    app = await createApp(cfg, { chain: new ArenaChain([arena(1, 1000)]), log: () => {}, persist: true, apiLimiter: new Limiter(10_000, 60_000) });
    const port = await app.listen();
    app.rooms.createCustomRoom('SHARE', { name: 'Share Pond', maxPlayers: 4, bots: null, custom: freeCustom() });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, bin) => !bin && msgs.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    const waitFor = async (pred: (m: ServerMessage) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const m = msgs.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error('message never came');
    };
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    await waitFor((m) => m.t === 'welcome');
    ws.send(JSON.stringify({ t: 'join', room: 'private:SHARE', name: 'Pip', skin: 3 }));
    await waitFor((m) => m.t === 'joined');
    app.rooms.closeCustomRoom('SHARE', 'Time is up.');
    const share = (await waitFor((m) => m.t === 'share')) as Extract<ServerMessage, { t: 'share' }>;
    expect(share.kind).toBe('room');
    expect(app.shares.get(share.id)).toMatchObject({ name: 'Pip', rank: 1, players: 1, room: 'Share Pond' });
    ws.close();

    const page = await fetch(`http://127.0.0.1:${port}/share/${share.id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain(`content="http://127.0.0.1:${port}/share/${share.id}.png"`);
    const png = await fetch(`http://127.0.0.1:${port}/share/${share.id}.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
    expect((await fetch(`http://127.0.0.1:${port}/share/AAAAAAAAAA`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/share/${share.id}`, { method: 'POST' })).status).toBe(405);
  });
});
