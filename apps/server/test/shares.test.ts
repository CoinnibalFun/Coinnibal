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
import { ArenaChain, arena, fakeConn, freeCustom, roomDeps, testWallet } from './helpers';

const look = { name: 'Nakamoto', skin: 2, country: 'JP', flags: 8 };
const arenaRoom = { opts: { id: 'arena-1-1', mode: 'arena', name: 'Asphodel Meadow', maxPlayers: 50, stake: { arenaId: 1, buyIn: 1 } } } as never;
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
