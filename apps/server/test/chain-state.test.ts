import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BinaryWriter, EMBLEM_SKIN_ID, PlayerFlag, decodeSnapshot, writeSnapshot, type ChainStatus } from '@coinnibal/shared';
import { getAddress } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { chainDir, migrateLegacyState, rememberedChainId, resolveStateChainId, storedChains } from '../src/chain/state-dir';
import type { ServerKeyInfo } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { ADMIN, ARENA, FakeEvm, NFT, SERVER, TOKEN } from './fake-evm';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

const record = (address: string, chainId: number) => ({ address, txHash: null, chainId, registeredAt: 1, registeredBy: ADMIN });

class EvmTestChain extends ArenaChain {
  constructor(readonly fake: FakeEvm) {
    super([arena(1, 1000)]);
  }
  override status(): ChainStatus {
    return { ...super.status(), chainId: this.fake.chainId, serverKey: SERVER };
  }
  override serverInfo(): ServerKeyInfo {
    return { address: SERVER, balanceWei: '5000000000000000000', low: false };
  }
  evm() {
    return this.fake;
  }
  async refresh() {}
}

const apps: App[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});

async function start(dir: string, chainId: number, extra: Parameters<typeof createApp>[1] = {}) {
  const evm = new FakeEvm();
  evm.chainId = chainId;
  const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_WALLETS: ADMIN, PUBLIC_URL: 'https://coinnibal.example' } as NodeJS.ProcessEnv);
  const app = await createApp(cfg, {
    chain: new EvmTestChain(evm),
    log: () => {},
    persist: true,
    siteLimits: { writeIp: new Limiter(10_000, 60_000), writeWallet: new Limiter(10_000, 60_000), login: new Limiter(10_000, 60_000) },
    apiLimiter: new Limiter(10_000, 60_000),
    fetchPrice: async () => ({ price: '40', value: 40 }),
    ...extra,
  });
  apps.push(app);
  const port = await app.listen();
  const call = async (method: string, path: string, opts: { wallet?: string; body?: unknown; origin?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.wallet) headers.Authorization = `Bearer ${app.auth.issueToken(opts.wallet)}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, evm, call };
}

function legacy(dir: string, opts: { contractsChain?: number | null } = {}) {
  if (opts.contractsChain !== null) writeFileSync(join(dir, 'contracts.json'), JSON.stringify({ arena: record(ARENA, opts.contractsChain ?? 46630), nft: record(NFT, opts.contractsChain ?? 46630), token: null }));
  writeFileSync(join(dir, 'journal.json'), JSON.stringify({ version: 1, pending: [], live: [], loot: [] }));
  writeFileSync(join(dir, 'journal.json.corrupt-1700000000000'), '{');
  mkdirSync(join(dir, 'site'), { recursive: true });
  writeFileSync(join(dir, 'site', 'allowlist.json'), '{}');
}

describe('chain-keyed state: migration', () => {
  it('moves the legacy registry, journal (with quarantined copies) and allowlist into chains/<chain of the records>/, idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-state-'));
    legacy(dir);
    const logs: string[] = [];
    // even when this boot is on another chain: the records say where they belong
    expect(migrateLegacyState(dir, 4663, (m) => logs.push(m)).sort()).toEqual(['contracts.json', 'journal.json', 'journal.json.corrupt-1700000000000', 'site/allowlist.json'].sort());
    const c = chainDir(dir, 46630);
    for (const f of ['contracts.json', 'journal.json', 'journal.json.corrupt-1700000000000', 'allowlist.json']) expect(existsSync(join(c, f))).toBe(true);
    for (const f of ['contracts.json', 'journal.json', join('site', 'allowlist.json')]) expect(existsSync(join(dir, f))).toBe(false);
    expect(logs.join('\n')).toMatch(/moved .* into chains\/46630/);
    expect(migrateLegacyState(dir, 4663)).toEqual([]);
    expect(storedChains(dir)).toEqual([46630]);
  });

  it('never overwrites: a legacy file whose target exists stays (logged)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-state-'));
    legacy(dir);
    mkdirSync(chainDir(dir, 46630), { recursive: true });
    writeFileSync(join(chainDir(dir, 46630), 'journal.json'), '"newer"');
    const logs: string[] = [];
    expect(migrateLegacyState(dir, 46630, (m) => logs.push(m))).not.toContain('journal.json');
    expect(readFileSync(join(chainDir(dir, 46630), 'journal.json'), 'utf8')).toBe('"newer"');
    expect(existsSync(join(dir, 'journal.json'))).toBe(true);
    expect(logs.join('\n')).toMatch(/journal\.json was not moved/);
  });

  it('without a registry the files stay with a local node, else go under the retired pre-Robinhood testnet (never into Robinhood Chain state)', () => {
    const local = mkdtempSync(join(tmpdir(), 'coinnibal-state-'));
    legacy(local, { contractsChain: null });
    migrateLegacyState(local, 31337);
    expect(storedChains(local)).toEqual([31337]);
    const main = mkdtempSync(join(tmpdir(), 'coinnibal-state-'));
    legacy(main, { contractsChain: null });
    migrateLegacyState(main, 4663);
    expect(storedChains(main)).toEqual([99801]);
    const test = mkdtempSync(join(tmpdir(), 'coinnibal-state-'));
    legacy(test, { contractsChain: null });
    migrateLegacyState(test, 46630);
    expect(storedChains(test)).toEqual([99801]);
  });

  it('keys the state on eth_chainId of the RPC, remembered for a boot with the RPC down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-state-'));
    const cfg = loadConfig({ DATA_DIR: dir, EVM_RPC_URL: 'https://rpc.example/key123', SERVER_PRIVATE_KEY: 'auto' } as NodeJS.ProcessEnv);
    const logs: string[] = [];
    expect(await resolveStateChainId(cfg, { persist: true, log: (m) => logs.push(m), readId: async () => 46630 })).toBe(46630);
    expect(rememberedChainId(dir, 'https://rpc.example/key123')).toBe(46630);
    expect(readFileSync(join(dir, 'chains', 'rpc-ids.json'), 'utf8')).not.toContain('key123');
    const down = async () => {
      throw new Error('fetch failed');
    };
    expect(await resolveStateChainId(cfg, { persist: true, log: (m) => logs.push(m), readId: down })).toBe(46630);
    const other = loadConfig({ DATA_DIR: dir, EVM_RPC_URL: 'https://other.example', SERVER_PRIVATE_KEY: 'auto' } as NodeJS.ProcessEnv);
    expect(await resolveStateChainId(other, { persist: true, log: (m) => logs.push(m), readId: down })).toBeNull();
    expect(logs.join('\n')).toMatch(/chain id is unknown/);
    expect(await resolveStateChainId(loadConfig({ DATA_DIR: dir } as NodeJS.ProcessEnv), { persist: true, log: () => {} })).toBeNull();
  });

  it('a wrong chain is an alert line that names the keys the VPS reads (COINNIBAL_*), not only the shadowed ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-state-'));
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const cfg = loadConfig({ DATA_DIR: dir, EVM_RPC_URLS: 'https://rpc.example', SERVER_PRIVATE_KEY: 'auto' } as NodeJS.ProcessEnv);
    expect(await resolveStateChainId(cfg, { persist: false, log, readId: async () => 99801 })).toBeNull();
    expect(logs.pop()).toMatch(/^!!! chain: the RPC \(COINNIBAL_RPC_URLS on the VPS, EVM_RPC_URL\(S\) outside Docker\) serves chain 99801: chain 99801 is not Robinhood Chain/);
    const pinned = loadConfig({ DATA_DIR: dir, CHAIN_ID: '4663', EVM_RPC_URLS: 'https://rpc.example', SERVER_PRIVATE_KEY: 'auto' } as NodeJS.ProcessEnv);
    expect(await resolveStateChainId(pinned, { persist: false, log, readId: async () => 46630 })).toBeNull();
    expect(logs.pop()).toMatch(/^!!! chain: CHAIN_ID is 4663 but the RPC \(COINNIBAL_RPC_URLS on the VPS, EVM_RPC_URL\(S\) outside Docker\) serves chain 46630: .*COINNIBAL_CHAIN_ID \/ COINNIBAL_RPC_URLS on the VPS, then restart\)$/);
  });
});

describe('chain-keyed state: the app', () => {
  it('testnet: migrates on first start, opens chains/46630, a fresh server is closed (admins only); mainnet then starts clean and keeps the testnet records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-app-'));
    legacy(dir);
    const t = await start(dir, 46630);
    expect(t.app.stateChainId).toBe(46630);
    expect(t.app.contracts.stored().arena?.address).toBe(ARENA);
    expect((await t.call('GET', '/api/site/settings')).body.settings).toMatchObject({ gameAccess: 'admins', wlOpen: false, collabOpen: false, mintOpen: false });
    // the open-play copy of the site (OPEN_PLAY_ORIGINS) sees the game open on the testnet; the main site does not
    expect((await t.call('GET', '/api/site/settings', { origin: 'https://coinnibal.vercel.app' })).body.settings.gameAccess).toBe('public');
    expect((await t.call('GET', '/api/site/settings', { origin: 'https://coinnibal.fun' })).body.settings.gameAccess).toBe('admins');
    const player = testSigner().address;
    expect((await t.call('GET', '/api/auth/me', { wallet: player, origin: 'https://coinnibal.vercel.app' })).body.canPlay).toBe(true);
    expect((await t.call('GET', '/api/auth/me', { wallet: player })).body.canPlay).toBe(false);
    t.app.journal.enqueue({ kind: 'sweep', key: 'sweep:x:1', arenaId: 1, roomId: 'x', round: 1, amount: 5, attempts: 0, nextAttemptAt: Date.now() + 60_000, createdAt: Date.now() });
    expect(existsSync(join(dir, 'chains', '46630', 'journal.json'))).toBe(true);
    const net = (await t.call('GET', '/api/admin/network', { wallet: ADMIN })).body;
    expect(net).toMatchObject({ chainId: 46630, testnet: true, rpcOk: true, block: '1000', serverKey: SERVER, serverBalanceWei: '5000000000000000000', low: false, otherChains: [] });
    expect(typeof net.rpcLatencyMs).toBe('number');
    expect(net.contracts).toEqual([
      { kind: 'arena', address: ARENA, code: 'ok', registeredBy: ADMIN },
      { kind: 'nft', address: NFT, code: 'ok', registeredBy: ADMIN },
    ]);
    expect((await t.call('GET', '/api/admin/network', { wallet: testSigner().address })).status).toBe(403);
    await t.app.close();

    // EVM_RPC_URL now points at mainnet
    const m = await start(dir, 4663);
    expect(m.app.contracts.stored()).toEqual({ arena: null, nft: null, token: null });
    expect(m.app.journal.pending).toHaveLength(0);
    expect((await m.call('GET', '/api/site/settings')).body.settings.gameAccess).toBe('admins');
    // never on mainnet
    expect((await m.call('GET', '/api/site/settings', { origin: 'https://coinnibal.vercel.app' })).body.settings.gameAccess).toBe('admins');
    const mnet = (await m.call('GET', '/api/admin/network', { wallet: ADMIN })).body;
    expect(mnet).toMatchObject({ chainId: 4663, testnet: false, contracts: [], otherChains: [46630] });
    // the testnet records are still there
    expect(JSON.parse(readFileSync(join(dir, 'chains', '46630', 'journal.json'), 'utf8')).pending).toHaveLength(1);
  });

  it('a stored gameAccess is kept on the testnet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-app-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, 'site', 'settings.json'), JSON.stringify({ wlOpen: true, collabOpen: false, gameAccess: 'holders', xHandle: 'coinnibalfun', launchPostUrl: null, launch: 1 }));
    const t = await start(dir, 46630);
    expect((await t.call('GET', '/api/site/settings')).body.settings.gameAccess).toBe('holders');
  });
});

describe('faucet config (GET /api/site/faucet)', () => {
  it('enabled on a test chain with a registered TestToken: amounts from the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-app-'));
    mkdirSync(chainDir(dir, 46630), { recursive: true });
    writeFileSync(join(chainDir(dir, 46630), 'contracts.json'), JSON.stringify({ arena: null, nft: record(NFT, 46630), token: record(TOKEN, 46630) }));
    const t = await start(dir, 46630);
    t.evm.faucet.holderNft = NFT;
    // while only admins play (the launch default) the faucet answers the admin only, like the site's /faucet page
    expect((await t.call('GET', '/api/site/faucet')).body).toMatchObject({ error: 'game_closed' });
    const f = (await t.call('GET', '/api/site/faucet', { wallet: ADMIN })).body;
    expect(f).toEqual({
      enabled: true,
      chainId: 46630,
      token: TOKEN,
      decimals: 18,
      amount: (1_000_000n * 10n ** 18n).toString(),
      holderAmount: (2_000_000n * 10n ** 18n).toString(),
      cooldownSecs: 3600,
      holderNft: NFT,
      // the chain's own faucet (`ChainStatus.faucetUrl`): this stub chain has none
      gasFaucetUrl: null,
    });
  });

  it('off without a token, and on mainnet', async () => {
    const t = await start(mkdtempSync(join(tmpdir(), 'coinnibal-app-')), 46630);
    expect((await t.call('GET', '/api/site/faucet', { wallet: ADMIN })).body).toMatchObject({ enabled: false, token: null, amount: null });
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-app-'));
    mkdirSync(chainDir(dir, 4663), { recursive: true });
    writeFileSync(join(chainDir(dir, 4663), 'contracts.json'), JSON.stringify({ arena: null, nft: null, token: record(TOKEN, 4663) }));
    const m = await start(dir, 4663);
    expect((await m.call('GET', '/api/site/faucet', { wallet: ADMIN })).body).toMatchObject({ enabled: false, chainId: 4663, token: TOKEN });
  });
});

describe('testnet emblem holders → mainnet WL', () => {
  it('imports the current owners of the testnet NFT (from its chain registry, over the testnet reader) and adds them to the allowlist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-app-'));
    mkdirSync(chainDir(dir, 46630), { recursive: true });
    writeFileSync(join(chainDir(dir, 46630), 'contracts.json'), JSON.stringify({ arena: null, nft: record(NFT, 46630), token: null }));
    const testnet = new FakeEvm();
    testnet.chainId = 46630;
    const [a, b, c] = [testSigner().address, testSigner().address, testSigner().address];
    testnet.mintNft(a, 2);
    testnet.mintNft(b, 1);
    // b sells its emblem to c
    testnet.block += 1n;
    testnet.transfers.push({ from: getAddress(b), to: getAddress(c), tokenId: 3n, blockNumber: testnet.block });
    testnet.balances.set(b.toLowerCase(), 0n);
    testnet.balances.set(c.toLowerCase(), 1n);
    const t = await start(dir, 4663, { holderReaderFor: (id) => (id === 46630 ? testnet : null) });
    // a is also on the approved WL
    t.app.site.store.updateSettings({ wlOpen: true });
    t.app.site.store.submitWl(a, { xHandle: 'alice', answers: { follow_x: true, post_x: 'https://x.com/alice/status/1790000000000000001' } });
    const id = t.app.site.store.listWl({ status: null, q: null, page: 1, pageSize: 10 }).items[0].id;
    t.app.site.store.setWlStatus([id], 'approved');

    expect((await t.call('GET', '/api/admin/mint/import-holders', { wallet: ADMIN })).body).toMatchObject({ entries: [], counts: { wallets: 0 }, importedAt: null });
    expect((await t.call('POST', '/api/admin/mint/import-holders', { wallet: ADMIN, body: { fromChainId: 1234 } })).status).toBe(409);
    const r = await t.call('POST', '/api/admin/mint/import-holders', { wallet: ADMIN, body: {} });
    expect(r.status).toBe(201);
    expect(r.body.counts).toEqual({ wallets: 2, tokens: 3, alsoWl: 1 });
    expect(r.body.importedFrom).toBe(46630);
    const byWallet = Object.fromEntries(r.body.entries.map((e: { wallet: string; tokenIds: string[] }) => [e.wallet, e]));
    expect(byWallet[a]).toEqual({ wallet: a, source: 'testnet-emblem', chainId: 46630, tokenIds: ['1', '2'] });
    expect(byWallet[c]).toMatchObject({ tokenIds: ['3'] });
    expect(byWallet[b]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'site', 'holder-wl.json'), 'utf8')).entries).toHaveLength(2);
    // the allowlist builder includes them, de-duplicated with the WL
    const built = await t.call('POST', '/api/admin/mint/allowlist', { wallet: ADMIN });
    expect(built.body.count).toBe(2);
    const status = (await t.call('GET', '/api/admin/mint/allowlist', { wallet: ADMIN })).body;
    expect(status.snapshot.sources).toEqual({ wl: 1, collab: 0, holders: 2 });
    expect(existsSync(join(dir, 'chains', '4663', 'allowlist.json'))).toBe(true);
    // a reader on the wrong chain is refused
    testnet.chainId = 1;
    expect((await t.call('POST', '/api/admin/mint/import-holders', { wallet: ADMIN, body: { fromChainId: 46630 } })).status).toBe(502);
  });
});

describe('NFT utilities: emblem skin and laurel flag', () => {
  it('the emblem skin is offered and accepted for holders only (checked server side)', async () => {
    const t = await start(mkdtempSync(join(tmpdir(), 'coinnibal-app-')), 46630);
    t.app.contracts.set('nft', record(NFT, 46630));
    const holder = testSigner().address;
    const other = testSigner().address;
    // minted (a Transfer log): the profile's skins are only shown, from the holder index, never a chain read of their own
    t.evm.mintNft(holder);
    const g = (await t.call('GET', '/api/profile', { wallet: holder })).body;
    expect(g).toMatchObject({ holder: true, skinOptions: [0, 1, 2, 3, 4, 5, 6, 7, EMBLEM_SKIN_ID] });
    expect((await t.call('GET', '/api/profile', { wallet: other })).body).toMatchObject({ holder: false, skinOptions: [0, 1, 2, 3, 4, 5, 6, 7] });
    const bad = await t.call('PUT', '/api/profile', { wallet: other, body: { name: 'bob', skin: EMBLEM_SKIN_ID } });
    expect(bad).toMatchObject({ status: 400, body: { field: 'skin' } });
    const ok = await t.call('PUT', '/api/profile', { wallet: holder, body: { name: 'ann', skin: EMBLEM_SKIN_ID } });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.skin).toBe(EMBLEM_SKIN_ID);
  });

  it('holders carry PlayerFlag.Holder on the wire (decoded as `holder: true`, absent otherwise)', () => {
    const w = new BinaryWriter(1024);
    writeSnapshot(w, {
      tick: 1,
      view: { x: 0, y: 0, h: 100 },
      players: [
        { id: 1, skin: EMBLEM_SKIN_ID, flags: PlayerFlag.Verified | PlayerFlag.Holder, name: 'ann' },
        { id: 2, skin: 1, flags: 0, name: 'bob', holder: true },
        { id: 3, skin: 1, flags: PlayerFlag.Bot, name: 'kenjiplays', isBot: true },
      ],
      upserts: [],
      removals: [],
    });
    const snap = decodeSnapshot(w.finish());
    expect(snap.players.map((p) => [p.id, p.skin, p.holder ?? false, p.isBot])).toEqual([
      [1, EMBLEM_SKIN_ID, true, false],
      [2, 1, true, false],
      [3, 1, false, true],
    ]);
  });
});

describe('no house bots', () => {
  it('the app has no staked-bot source and no bots admin; the maps admin replaces it', async () => {
    const t = await start(mkdtempSync(join(tmpdir(), 'coinnibal-app-')), 31337);
    expect((t.app as unknown as Record<string, unknown>).stakedBots).toBeUndefined();
    expect((await t.call('GET', '/api/admin/bots', { wallet: ADMIN })).status).toBe(404);
    const maps = (await t.call('GET', '/api/admin/maps', { wallet: ADMIN })).body as { settings: Record<string, unknown>; rooms: unknown[] };
    expect(Object.keys(maps.settings).sort()).toEqual(['arena', 'practicePro', 'practiceRookie', 'private']);
    expect(maps.rooms.length).toBeGreaterThan(0);
  });
});
