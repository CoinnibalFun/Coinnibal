import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARENA_PRICING_DEFAULT } from '@coinnibal/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DexTwapPriceSource, ManualPriceSource, priceSource } from '../src/chain/token-price';
import { loadConfig } from '../src/config';
import { RoomManager } from '../src/rooms/manager';
import { ARENA_PRICES_FILE, ArenaPriceStore, ArenaPricingFail } from '../src/site/arena-prices';
import { ArenaChain, arena, roomDeps, testWallet } from './helpers';

describe('token price sources', () => {
  it('manual: the admin price, or not set', async () => {
    expect(await new ManualPriceSource(() => ({ usdPerToken: null, at: null })).read()).toMatchObject({ ok: false, source: 'manual', reason: 'not_set' });
    expect(await new ManualPriceSource(() => ({ usdPerToken: '0.00081', at: 5 })).read()).toEqual({ ok: true, source: 'manual', usdPerToken: '0.00081', price: 810_000_000_000_000n, at: 5 });
  });

  it('the Pons / DEX TWAP source is a stub: it reads nothing', async () => {
    expect(await new DexTwapPriceSource().read()).toMatchObject({ ok: false, source: 'dex_twap', reason: 'not_wired' });
    expect(priceSource('dex_twap', () => ({ usdPerToken: '1', at: 1 }))).toBeInstanceOf(DexTwapPriceSource);
    expect(priceSource('manual', () => ({ usdPerToken: '1', at: 1 }))).toBeInstanceOf(ManualPriceSource);
  });
});

describe('arena prices store', () => {
  it('defaults: $1 / $3 / $5 / $10 (the $10 one holders-only), manual source, no price', async () => {
    const s = new ArenaPriceStore(null);
    expect(s.settings).toEqual(ARENA_PRICING_DEFAULT);
    expect(await s.view()).toEqual({ source: 'manual', usdPerToken: null, at: null, tiers: ARENA_PRICING_DEFAULT.tiers, sigFigs: 2 });
    expect(await s.priceView()).toMatchObject({ ok: false, reason: 'not_set' });
  });

  it('persists the admin price per chain, survives a restart, refuses bad values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-prices-'));
    let t = 1_800_000_000_000;
    const a = new ArenaPriceStore(dir, () => {}, () => t);
    a.update({ manualUsdPerToken: '0.00081', tiers: [...ARENA_PRICING_DEFAULT.tiers.slice(0, 3), { arenaId: 4, usdCents: 1500, holdersOnly: true }] });
    expect(() => a.update({ source: 'dex_twap' })).toThrow(ArenaPricingFail);
    expect(() => a.update({ sigFigs: 9 })).toThrow(/sigFigs/);
    expect(() => a.update({ manualSetAt: 1 })).toThrow(/unknown setting/);
    t += 60_000;
    const b = new ArenaPriceStore(dir, () => {}, () => t);
    expect(b.settings).toMatchObject({ manualUsdPerToken: '0.00081', manualSetAt: 1_800_000_000_000, sigFigs: 2 });
    expect(b.settings.tiers[3]).toEqual({ arenaId: 4, usdCents: 1500, holdersOnly: true });
    expect(await b.view()).toMatchObject({ usdPerToken: '0.00081', at: 1_800_000_000_000 });
    expect(await b.priceView()).toEqual({ ok: true, source: 'manual', usdPerToken: '0.00081', at: 1_800_000_000_000 });
  });

  it('an unreadable file is moved aside (logged), the defaults apply: never a made-up price', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-prices-'));
    writeFileSync(join(dir, ARENA_PRICES_FILE), JSON.stringify({ manualUsdPerToken: '-3' }));
    const logs: string[] = [];
    const s = new ArenaPriceStore(dir, (m) => logs.push(m));
    expect(s.settings.manualUsdPerToken).toBeNull();
    expect(logs[0]).toMatch(/^!!! arena prices: .* unreadable/);
    expect(readdirSync(dir).some((f) => f.startsWith(`${ARENA_PRICES_FILE}.corrupt-`))).toBe(true);
  });
});

describe('arena prices API', () => {
  async function server() {
    const dir = mkdtempSync(join(tmpdir(), 'elymum-prices-api-'));
    const admin = testWallet(0xad01);
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: admin, TRUST_PROXY: '0' } as NodeJS.ProcessEnv);
    const app = await createApp(cfg, { chain: new ArenaChain([arena(1, 1_000_000_000)]), log: () => {}, persist: true });
    const port = await app.listen();
    const call = async (path: string, method = 'GET', body?: unknown, wallet: string | null = admin) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (wallet) headers.Authorization = `Bearer ${app.auth.issueToken(wallet)}`;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    return { app, call, dir };
  }

  it('public view for the lobby; admin GET / PUT (admins only); the file is chain-keyed', async () => {
    const { app, call, dir } = await server();
    try {
      expect((await call('/api/site/arena-prices', 'GET', undefined, null)).body).toMatchObject({ usdPerToken: null, tiers: ARENA_PRICING_DEFAULT.tiers });
      expect((await call('/api/admin/arena-prices', 'GET', undefined, null)).status).toBe(401);
      expect((await call('/api/admin/arena-prices', 'PUT', { manualUsdPerToken: '0.001' }, testWallet(0xbeef))).status).toBe(403);
      const bad = await call('/api/admin/arena-prices', 'PUT', { manualUsdPerToken: 'cheap' });
      expect(bad).toMatchObject({ status: 400, body: { error: 'bad_request', field: 'manualUsdPerToken' } });
      const twap = await call('/api/admin/arena-prices', 'PUT', { source: 'dex_twap' });
      expect(twap).toMatchObject({ status: 400, body: { field: 'source', message: expect.stringMatching(/not wired/) } });
      const ok = await call('/api/admin/arena-prices', 'PUT', { manualUsdPerToken: '0.00081', sigFigs: 3 });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ settings: { manualUsdPerToken: '0.00081', sigFigs: 3 }, defaults: { sigFigs: 2 }, price: { ok: true, usdPerToken: '0.00081' } });
      expect((await call('/api/site/arena-prices', 'GET', undefined, null)).body).toMatchObject({ usdPerToken: '0.00081', sigFigs: 3 });
      expect(existsSync(join(dir, 'chains', '31337', ARENA_PRICES_FILE))).toBe(true);
      // every admin write is in the audit log
      expect(readFileSync(join(dir, 'admin-audit.jsonl'), 'utf8')).toMatch(/arena-prices/);
    } finally {
      await app.close();
    }
  });
});

describe('a re-priced arena (owner updateArena while no ticket is open)', () => {
  it("its rooms take the new price for their own figures; the tickets' entries come from their sessions", async () => {
    const chain = new ArenaChain([arena(1, 1_000_000_000)]);
    const rooms = new RoomManager(loadConfig({} as NodeJS.ProcessEnv), roomDeps(chain), chain);
    const room = await rooms.arenaRoom(1);
    expect(room!.opts.stake!.buyIn).toBe(1_000_000_000);
    chain.arenas[0] = { ...chain.arenas[0], entryFee: 1_200_000_000 };
    // the arena list is cached for a minute; the next read after it sees the new price
    (rooms as unknown as { arenaCache: unknown }).arenaCache = null;
    expect(await rooms.arenaRoom(1)).toBe(room);
    expect(room!.opts.stake!.buyIn).toBe(1_200_000_000);
    expect(room!.info().entryFee).toBe(1_200_000_000);
  });
});

