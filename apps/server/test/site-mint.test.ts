import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMerkleProof } from '@coinnibal/sdk';
import { CUSTOM_DEFAULTS, PROTOCOL_VERSION, sitePinsMessage, type ChainStatus, type ServerMessage, type SitePinsFields } from '@coinnibal/shared';
import type { Address, Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app';
import type { ServerKeyInfo } from '../src/chain/types';
import { loadConfig } from '../src/config';
import { Limiter } from '../src/net/limiter';
import { ProfileStore } from '../src/profiles';
import { CONTRACTS_FILE } from '../src/site/contracts';
import { SITE_PINS_FILE, SitePinsStore } from '../src/site/pins';
import { generateCollection, revealOffset, sha256Hex } from '../src/site/nft/generate';
import { unrevealedSvg } from '../src/site/nft/unrevealed';
import { ALLOWLIST_FILE, HOLDER_MISS_TTL_MS, parseNftPath } from '../src/site/mint';
import { SITE_FILES, SiteStore } from '../src/site/store';
import { ADMIN, ARENA, FakeEvm, NFT, SERVER, TOKEN } from './fake-evm';
import { ArenaChain, arena } from './helpers';
import { testSigner } from './signers';

const wallet = () => testSigner().address;
const post = (h = 'alice', id = '1790000000000000001') => `https://x.com/${h}/status/${id}`;

/** A chain gateway with arenas plus EVM access (the fake contracts): what the site reads the NFT through. */
class EvmTestChain extends ArenaChain {
  constructor(readonly fake: FakeEvm) {
    super([arena(1, 1000)]);
  }
  override status(): ChainStatus {
    return { ...super.status(), chainId: this.fake.chainId, serverKey: SERVER };
  }
  override serverInfo(): ServerKeyInfo {
    return { address: SERVER, balanceWei: '123', low: true };
  }
  evm() {
    return this.fake;
  }
  refreshes = 0;
  async refresh() {
    this.refreshes++;
  }
}

interface Harness {
  app: App;
  port: number;
  dir: string;
  evm: FakeEvm;
  chain: EvmTestChain;
  call(method: string, path: string, opts?: { wallet?: string | null; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; text: string; headers: Headers }>;
}

async function harness(env: Record<string, string> = {}, setupDir?: (dir: string) => void): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'coinnibal-mint-'));
  setupDir?.(dir);
  const evm = new FakeEvm();
  const chain = new EvmTestChain(evm);
  const cfg = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    ADMIN_WALLETS: ADMIN,
    PUBLIC_URL: 'https://coinnibal.example',
    ROUND_JOIN_CLOSE_SECONDS: '0',
    ROUND_BREAK_SECONDS: '0',
    ...env,
  } as NodeJS.ProcessEnv);
  const app = await createApp(cfg, {
    chain,
    log: () => {},
    persist: true,
    siteLimits: { writeIp: new Limiter(10_000, 60_000), writeWallet: new Limiter(10_000, 60_000), login: new Limiter(10_000, 60_000) },
    apiLimiter: new Limiter(10_000, 60_000),
    fetchPrice: async () => ({ price: '40', value: 40 }),
  });
  // a fresh server starts closed; these tests apply to the WL (a seeded settings file keeps its own value)
  if (!setupDir) app.site.store.updateSettings({ wlOpen: true });
  const port = await app.listen();
  const call: Harness['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.wallet) headers.Authorization = `Bearer ${app.auth.issueToken(opts.wallet)}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  return { app, port, dir, evm, chain, call };
}

/** A practice join over the WebSocket as `w` (signed in) or a guest: `joined`, or the error's code. */
async function joinPractice(h: Harness, w: string | null, skin = 0): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
  const msgs: ServerMessage[] = [];
  ws.on('message', (d, bin) => {
    if (!bin) msgs.push(JSON.parse(d.toString()) as ServerMessage);
  });
  await new Promise((r) => ws.once('open', r));
  const until = async (pred: (m: ServerMessage) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const m = msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no reply: ${JSON.stringify(msgs.map((m) => m.t))}`);
  };
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
  await until((m) => m.t === 'welcome');
  if (w) {
    ws.send(JSON.stringify({ t: 'auth', token: h.app.auth.issueToken(w) }));
    await until((m) => m.t === 'authed');
  }
  ws.send(JSON.stringify({ t: 'join', room: 'practice', name: 'x', skin }));
  const r = await until((m) => m.t === 'joined' || m.t === 'error');
  ws.close();
  return r.t === 'error' ? r.code : r.t;
}

const wlBody = (handle: string) => ({ xHandle: handle, answers: { follow_x: true, post_x: post(handle) } });

describe('contracts registry', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.app.close();
  });

  it('is public, empty at first', async () => {
    expect((await h.call('GET', '/api/site/contracts')).body).toEqual({ arena: null, nft: null, token: null });
  });

  it('checks the code hash, the owner (the signed-in admin) and the arena server authority', async () => {
    const reg = (body: unknown, w: string = ADMIN) => h.call('POST', '/api/admin/contracts', { wallet: w, body });
    expect((await reg({ kind: 'arena', address: ARENA }, wallet())).status).toBe(403);
    expect((await reg({ kind: 'vault', address: ARENA })).body.field).toBe('kind');
    expect((await reg({ kind: 'arena', address: 'nope' })).body.field).toBe('address');
    expect((await reg({ kind: 'arena', address: ARENA, txHash: '0x12' })).body.field).toBe('txHash');
    h.evm.code.set(ARENA.toLowerCase(), 'mismatch');
    expect((await reg({ kind: 'arena', address: ARENA })).body.error).toBe('code_mismatch');
    h.evm.code.set(ARENA.toLowerCase(), 'missing');
    expect((await reg({ kind: 'arena', address: ARENA })).body.error).toBe('code_mismatch');
    h.evm.code.delete(ARENA.toLowerCase());
    h.evm.config.admin = '0x00000000000000000000000000000000000000Ee';
    expect((await reg({ kind: 'arena', address: ARENA })).body.error).toBe('not_owner');
    h.evm.config.admin = ADMIN;
    h.evm.config.serverAuthority = '0x0000000000000000000000000000000000000bAd';
    const wrong = await reg({ kind: 'arena', address: ARENA });
    expect([wrong.status, wrong.body.error]).toEqual([400, 'wrong_authority']);
    h.evm.config.serverAuthority = SERVER;
    const tx = `0x${'ab'.repeat(32)}`;
    const refreshes = h.chain.refreshes;
    const ok = await reg({ kind: 'arena', address: ARENA.toLowerCase(), txHash: tx });
    expect(ok.status).toBe(201);
    expect(ok.body.record).toMatchObject({ address: ARENA, txHash: tx, chainId: 31337, registeredBy: ADMIN });
    // the gateway re-reads at once (a new arena is picked up without a restart)
    expect(h.chain.refreshes).toBe(refreshes + 1);
    // the NFT: owner check through owner()
    h.evm.owners.set(NFT.toLowerCase(), '0x00000000000000000000000000000000000000Ee');
    expect((await reg({ kind: 'nft', address: NFT })).body.error).toBe('not_owner');
    h.evm.owners.set(NFT.toLowerCase(), ADMIN);
    expect((await reg({ kind: 'nft', address: NFT })).status).toBe(201);
    // a game token that is not the TestToken: only the arena's own token
    h.evm.code.set(TOKEN.toLowerCase(), 'mismatch');
    h.evm.code.set('0x0000000000000000000000000000000000001234', 'mismatch');
    expect((await reg({ kind: 'token', address: '0x0000000000000000000000000000000000001234' })).body.error).toBe('code_mismatch');
    expect((await reg({ kind: 'token', address: TOKEN })).status).toBe(201);
    const pub = (await h.call('GET', '/api/site/contracts')).body;
    expect(pub).toMatchObject({ arena: { address: ARENA }, nft: { address: NFT }, token: { address: TOKEN } });
    // persisted
    const file = JSON.parse(readFileSync(join(h.dir, 'chains', '31337', CONTRACTS_FILE), 'utf8'));
    expect(file.arena.address).toBe(ARENA);
    expect((await h.call('GET', '/api/config')).body.chain).toMatchObject({ chainId: 31337 });
  });

  it('DELETE clears a kind; the arena only while nothing is owed', async () => {
    h.app.journal.enqueue({ kind: 'sweep', key: 'sweep:arena-1-1:1', arenaId: 1, roomId: 'arena-1-1', round: 1, amount: 5, attempts: 0, nextAttemptAt: Date.now() + 60_000, createdAt: Date.now() });
    const busy = await h.call('DELETE', '/api/admin/contracts?kind=arena', { wallet: ADMIN });
    expect([busy.status, busy.body.error]).toEqual([409, 'wrong_state']);
    h.app.journal.remove('sweep:arena-1-1:1');
    expect((await h.call('DELETE', '/api/admin/contracts?kind=token', { wallet: ADMIN })).body).toMatchObject({ cleared: true, registry: { token: null } });
    expect((await h.call('DELETE', '/api/admin/contracts?kind=bogus', { wallet: ADMIN })).status).toBe(400);
  });

  it('switching the arena is refused while the registered one has open tickets (not in the journal); owed payouts do not block', async () => {
    const NEW = '0x00000000000000000000000000000000000000b2';
    h.evm.addArena(7, 1_000n);
    const s = h.evm.join(7, wallet());
    const busy = await h.call('POST', '/api/admin/contracts', { wallet: ADMIN, body: { kind: 'arena', address: NEW } });
    expect([busy.status, busy.body.error]).toEqual([409, 'wrong_state']);
    expect(busy.body.message).toMatch(/still has open tickets \(#7: 1\)/);
    expect(h.app.contracts.view().arena).toBe(ARENA);
    h.evm.close(7, s.player);
    const ok = await h.call('POST', '/api/admin/contracts', { wallet: ADMIN, body: { kind: 'arena', address: NEW } });
    expect(ok.status).toBe(201);
    // back to the first one for the next tests
    expect((await h.call('POST', '/api/admin/contracts', { wallet: ADMIN, body: { kind: 'arena', address: ARENA } })).status).toBe(201);
  });

  it('admins see the server key balance in /api/config; others do not', async () => {
    expect((await h.call('GET', '/api/config')).body.server).toBeUndefined();
    expect((await h.call('GET', '/api/config', { wallet: wallet() })).body.server).toBeUndefined();
    expect((await h.call('GET', '/api/config', { wallet: ADMIN })).body.server).toEqual({ address: SERVER, balanceWei: '123', low: true, priceKeeper: null });
  });

  it('ARENA_ADDRESS / NFT_ADDRESS override the registry', async () => {
    const env = await harness({ ARENA_ADDRESS: '0x00000000000000000000000000000000000000a1' });
    try {
      expect((await env.call('GET', '/api/site/contracts')).body.arena).toMatchObject({ address: '0x00000000000000000000000000000000000000A1', registeredBy: 'env' });
      expect(env.app.contracts.view().arena).toBe('0x00000000000000000000000000000000000000A1');
      expect((await env.call('POST', '/api/admin/contracts', { wallet: ADMIN, body: { kind: 'arena', address: ARENA } })).body.error).toBe('wrong_state');
    } finally {
      await env.app.close();
    }
  });
});

describe('site pins (the owner signs the contracts the site trusts)', () => {
  // hardhat account #0 (the fake arena's admin): a well-known test key
  const owner = testSigner('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    expect((await h.call('POST', '/api/admin/contracts', { wallet: ADMIN, body: { kind: 'arena', address: ARENA } })).status).toBe(201);
    expect((await h.call('POST', '/api/admin/contracts', { wallet: ADMIN, body: { kind: 'nft', address: NFT } })).status).toBe(201);
  });
  afterAll(async () => {
    await h.app.close();
  });
  const fields = (over: Partial<SitePinsFields> = {}): SitePinsFields => ({ chainId: 31337, arena: ARENA, nft: NFT, token: TOKEN, signedAt: new Date().toISOString(), ...over });
  const signed = async (f: SitePinsFields, by = owner) => ({ ...f, signature: await by.sign(sitePinsMessage(f)) });
  const save = (body: unknown, w: string = ADMIN) => h.call('POST', '/api/admin/pins', { wallet: w, body });

  it('is public and empty at first; only an admin may write', async () => {
    expect((await h.call('GET', '/api/site/pins')).body).toEqual({ record: null });
    expect((await save(await signed(fields()), wallet())).status).toBe(403);
    expect((await h.call('POST', '/api/admin/pins', { body: await signed(fields()) })).status).toBe(401);
  });

  it('refuses a bad shape, another chain, other contracts, a wrong token and a signer that is not the admin', async () => {
    expect((await save({ chainId: 31337, arena: 'nope' })).body.error).toBe('bad_request');
    const chain = await save(await signed(fields({ chainId: 46630 })));
    expect([chain.status, chain.body.field]).toEqual([400, 'chainId']);
    const other = await save(await signed(fields({ arena: '0x00000000000000000000000000000000000000b2' })));
    expect([other.status, other.body.error]).toEqual([409, 'wrong_state']);
    const token = await save(await signed(fields({ token: null })));
    expect([token.status, token.body.field]).toEqual([409, 'token']);
    const stranger = await save(await signed(fields(), testSigner()));
    expect([stranger.status, stranger.body.error]).toEqual([403, 'not_owner']);
    // the signature of other fields (a changed address after signing)
    const f = fields();
    const swapped = { ...(await signed(f)), nft: ARENA, arena: NFT };
    expect((await save(swapped)).status).toBe(409);
    const late = { ...(await signed(f)), signedAt: new Date(Date.parse(f.signedAt) + 1).toISOString() };
    expect((await save(late)).body.error).toBe('not_owner');
    const future = await save(await signed(fields({ signedAt: new Date(Date.now() + 86_400_000).toISOString() })));
    expect([future.status, future.body.field]).toEqual([400, 'signedAt']);
    expect((await h.call('GET', '/api/site/pins')).body.record).toBeNull();
  });

  it('stores the signed record per chain (file, public read), and refuses an older one after it', async () => {
    const rec = await signed(fields({ arena: ARENA.toLowerCase(), signedAt: '2026-01-19T10:00:00.000Z' }));
    // the panel signs checksummed addresses: a lower-case arena is another message
    expect((await save(rec)).body.error).toBe('not_owner');
    const good = await signed(fields({ signedAt: '2026-01-19T10:00:00.000Z' }));
    const ok = await save(good);
    expect(ok.status).toBe(201);
    expect(ok.body.record).toEqual(good);
    expect((await h.call('GET', '/api/site/pins')).body).toEqual({ record: good });
    expect((await h.call('GET', '/api/site/pins?chainId=31337')).body).toEqual({ record: good });
    expect((await h.call('GET', '/api/site/pins?chainId=46630')).body).toEqual({ record: null });
    expect((await h.call('GET', '/api/admin/pins', { wallet: ADMIN })).body).toEqual({ record: good });
    expect(JSON.parse(readFileSync(join(h.dir, SITE_PINS_FILE), 'utf8'))).toEqual({ '31337': good });
    const older = await save(await signed(fields({ signedAt: '2026-01-19T09:00:00.000Z' })));
    expect([older.status, older.body.field]).toEqual([409, 'signedAt']);
    // a token not set on the arena yet: the pins name none
    h.evm.config.token = null;
    const none = await save(await signed(fields({ token: null, signedAt: '2026-01-19T11:00:00.000Z' })));
    expect(none.status).toBe(201);
    h.evm.config.token = TOKEN;
    // a restart reads the file back
    expect(new SitePinsStore(h.dir).get(31337)).toMatchObject({ token: null, signedAt: '2026-01-19T11:00:00.000Z' });
  });
});

describe('mint: allowlist, proofs, state, price', () => {
  let h: Harness;
  const approved: string[] = [];
  beforeAll(async () => {
    h = await harness();
    h.app.contracts.set('nft', { address: NFT, txHash: null, chainId: 31337, registeredAt: 1, registeredBy: ADMIN });
  });
  afterAll(async () => {
    await h.app.close();
  });

  it('builds a snapshot of approved WL + submitted collab wallets; proofs verify against its root', async () => {
    expect((await h.call('POST', '/api/admin/mint/allowlist', { wallet: ADMIN })).body.error).toBe('bad_request'); // empty
    const s = h.app.site.store;
    for (const handle of ['amy', 'ben', 'cat']) {
      const w = wallet();
      s.submitWl(w, wlBody(handle));
      approved.push(w);
    }
    const pending = wallet();
    s.submitWl(pending, wlBody('dan'));
    const ids = s.listWl({ pageSize: 100 }).items.filter((e) => approved.includes(e.wallet)).map((e) => e.id);
    s.setWlStatus(ids, 'approved');
    // a submitted collab list (one wallet also on the WL: counted once)
    s.updateSettings({ collabOpen: true });
    const owner = wallet();
    const c = s.applyCollab(owner, { community: 'Coin Guild', type: 'guild', members: 10, communityX: 'coinguild', contactX: 'eve', role: 'founder', postUrl: post('coinguild'), about: 'x' });
    s.approveCollab(c.id, { spots: 2, deadline: Date.now() + 3_600_000 });
    const extra = wallet();
    s.submitCollab(owner, c.id, { raffleUrl: post('coinguild', '2'), wallets: [{ name: 'a', wallet: extra }, { name: 'b', wallet: approved[0].toLowerCase() }] });

    const built = await h.call('POST', '/api/admin/mint/allowlist', { wallet: ADMIN });
    expect(built.status).toBe(201);
    expect(built.body.count).toBe(4);
    expect(built.body.root).toMatch(/^0x[0-9a-f]{64}$/);
    const status = (await h.call('GET', '/api/admin/mint/allowlist', { wallet: ADMIN })).body;
    expect(status.snapshot).toMatchObject({ root: built.body.root, count: 4, builtBy: ADMIN, sources: { wl: 3, collab: 2 } });
    expect(status.snapshot.wallets).toEqual([...approved, extra].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
    expect(status).toMatchObject({ diff: { added: [], removed: [] }, onchainRoot: null, published: false });
    // on disk
    expect(JSON.parse(readFileSync(join(h.dir, 'chains', '31337', ALLOWLIST_FILE), 'utf8')).root).toBe(built.body.root);

    for (const w of [...approved, extra]) {
      const p = (await h.call('GET', `/api/site/mint/proof?wallet=${w.toLowerCase()}`)).body;
      expect(p.eligible).toBe(true);
      expect(p.root).toBe(built.body.root);
      expect(verifyMerkleProof(p.root as Hex, w as Address, p.proof as Hex[])).toBe(true);
    }
    expect((await h.call('GET', `/api/site/mint/proof?wallet=${pending}`)).body).toMatchObject({ eligible: false, proof: [], root: built.body.root });
    expect((await h.call('GET', '/api/site/mint/proof?wallet=nope')).status).toBe(400);

    // the root is published on chain; then approvals change: the diff shows it
    h.evm.mint.root = built.body.root;
    await h.app.mint.chainState(true);
    const later = wallet();
    s.submitWl(later, wlBody('fay'));
    s.setWlStatus([s.listWl({ q: 'fay' }).items[0].id], 'approved');
    s.setWlStatus([s.listWl({ q: 'amy' }).items[0].id], 'rejected');
    const diff = (await h.call('GET', '/api/admin/mint/allowlist', { wallet: ADMIN })).body;
    expect(diff).toMatchObject({ onchainRoot: built.body.root, published: true, diff: { added: [later], removed: [approved[0]].filter(() => false) } });
    // amy is still in the collab list: not removed
    expect(diff.diff.removed).toEqual([]);
  });

  it('GET /api/site/mint: contract state, gas-token/USD, price in USD, holders, game access', async () => {
    h.evm.mint.phase = 1;
    h.evm.mint.price = 25n * 10n ** 15n; // 0.025 of the gas token at $40 = $1.00
    h.evm.mintNft(wallet(), 2);
    h.evm.mintNft(wallet(), 1);
    await h.app.mint.chainState(true);
    // the mint page is open: the public answer carries the USD target
    h.app.site.store.updateSettings({ mintOpen: true });
    const m = (await h.call('GET', '/api/site/mint')).body;
    h.app.site.store.updateSettings({ mintOpen: false });
    expect(m).toMatchObject({
      nftAddress: NFT,
      chainId: 31337,
      contract: { phase: 'allowlist', priceWei: '25000000000000000', maxSupply: 1000, totalSupply: 3, keeper: '0x0000000000000000000000000000000000000000' },
      gasUsd: 40,
      priceUsd: 1,
      targetUsdCents: 100,
      holders: 2,
      soldOut: false,
      gameAccess: 'admins',
    });
    const q = (await h.call('GET', '/api/admin/mint/price', { wallet: ADMIN })).body;
    expect(q).toMatchObject({ gasUsd: 40, targetUsdCents: 100, priceWei: '25000000000000000' });
    expect(q.fetchedAt).toBeGreaterThan(0);
  });

  it('GET /api/site/mint leaves MINT_USD_CENTS out while the mint page is closed; admins still get it', async () => {
    await h.app.mint.chainState(true);
    expect(h.app.site.store.settings.mintOpen).toBe(false);
    // closed (a fresh server's default): nobody but an admin sees the target, signed in or not
    const anon = (await h.call('GET', '/api/site/mint')).body;
    expect(anon.contract).not.toBeNull();
    expect(anon).not.toHaveProperty('targetUsdCents');
    expect((await h.call('GET', '/api/site/mint', { wallet: wallet() })).body).not.toHaveProperty('targetUsdCents');
    expect((await h.call('GET', '/api/site/mint', { wallet: ADMIN })).body.targetUsdCents).toBe(100);
    expect((await h.call('GET', '/api/admin/mint/price', { wallet: ADMIN })).body.targetUsdCents).toBe(100);
    // the owner opens the mint page: the public answer has it again
    h.app.site.store.updateSettings({ mintOpen: true });
    try {
      expect((await h.call('GET', '/api/site/mint')).body.targetUsdCents).toBe(100);
    } finally {
      h.app.site.store.updateSettings({ mintOpen: false });
    }
  });

  it('POST /api/admin/mint/refresh re-reads the NFT at once (a phase switch shows on the mint page now)', async () => {
    await h.app.mint.chainState(true);
    const before = (await h.call('GET', '/api/site/mint')).body.contract.phase;
    h.evm.mint.phase = before === 'public' ? 1 : 2;
    // cached: the page still shows the old phase
    expect((await h.call('GET', '/api/site/mint')).body.contract.phase).toBe(before);
    expect((await h.call('POST', '/api/admin/mint/refresh', { wallet: wallet() })).status).toBe(403);
    const r = await h.call('POST', '/api/admin/mint/refresh', { wallet: ADMIN, body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ refreshed: true });
    expect((await h.call('GET', '/api/site/mint')).body.contract.phase).toBe(before === 'public' ? 'allowlist' : 'public');
  });

  it('NFT metadata and the emblem SVG exist for minted ids only (sealed before the reveal)', async () => {
    const meta = await h.call('GET', '/api/nft/2');
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ name: 'Coinnibal No. 2', image: 'https://coinnibal.example/api/nft/2.svg', external_url: 'https://coinnibal.example' });
    expect(meta.body.attributes).toEqual([{ trait_type: 'Status', value: 'Sealed' }]);
    expect(meta.headers.get('cache-control')).toBe('public, max-age=60');
    const svg = await h.call('GET', '/api/nft/2.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(svg.text).toBe(unrevealedSvg(2, 'vector'));
    expect((await h.call('GET', '/api/nft/2.svg?style=pixel')).text).toBe(unrevealedSvg(2, 'pixel'));
    for (const missing of ['/api/nft/4', '/api/nft/4.svg', '/api/nft/0', '/api/nft/abc', '/api/nft/01.svg']) expect((await h.call('GET', missing)).status, missing).toBe(404);
    // a fresh mint shows up without waiting for the cache: even right after a read that predates it
    // (the mint page asks for the emblem the moment the receipt lands), past the 500 ms miss throttle
    await new Promise((r) => setTimeout(r, 600));
    expect((await h.call('GET', '/api/site/mint')).status).toBe(200);
    h.evm.mintNft(wallet());
    expect((await h.call('GET', '/api/nft/4.svg')).status).toBe(200);
    expect((await h.call('GET', '/api/nft/4')).status).toBe(200);
    // ids beyond the max supply never trigger a chain read
    expect((await h.call('GET', '/api/nft/5000000')).status).toBe(404);
    const contract = (await h.call('GET', '/api/nft/contract')).body;
    expect(contract).toMatchObject({ name: 'Coinnibal', external_link: 'https://coinnibal.example', seller_fee_basis_points: 500, fee_recipient: ADMIN });
    expect(contract.provenance_hash).toBe(h.app.nft.provenance().provenance);
    // royaltyInfo is cached (5 min): an unauthenticated route never turns every hit into an RPC call
    const calls = h.evm.royaltyCalls;
    for (let i = 0; i < 5; i++) expect((await h.call('GET', '/api/nft/contract')).body).toMatchObject({ seller_fee_basis_points: 500 });
    expect(h.evm.royaltyCalls).toBe(calls);
    // metadata links come from PUBLIC_URL, never from a spoofed X-Forwarded-Host
    expect((await h.call('GET', '/api/nft/2', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } })).body).toMatchObject({
      image: 'https://coinnibal.example/api/nft/2.svg',
      external_url: 'https://coinnibal.example',
    });
  }, 10_000);
});

describe('emblem reveal (provenance, schedule, reveal) through the API', () => {
  let h: Harness;
  const SEED = '0x' + '5e'.repeat(32);
  beforeAll(async () => {
    h = await harness({ NFT_COLLECTION_SEED: SEED, NFT_COLLECTION_SIZE: '1000' });
    h.app.contracts.set('nft', { address: NFT, txHash: null, chainId: 31337, registeredAt: 1, registeredBy: ADMIN });
    for (let i = 0; i < 3; i++) h.evm.mintNft(wallet());
  });
  afterAll(async () => {
    await h.app.close();
  });

  it('publishes the commitment, refuses an early reveal, then reveals verifiably', async () => {
    const prov = (await h.call('GET', '/api/nft/provenance')).body;
    const genomes = generateCollection(SEED, 1000);
    expect(prov).toMatchObject({ size: 1000, seedHash: sha256Hex(SEED), revealed: false, seed: null, offset: null });
    expect(prov.provenance).toMatch(/^0x[0-9a-f]{64}$/);
    // the rarity table is public (aggregates only)
    const rarity = (await h.call('GET', '/api/nft/rarity')).body;
    expect(rarity.duplicates).toBe(0);
    expect(rarity.tiers).toEqual(rarity.quotas);
    // admin only; the mint must be closed first, and the block ahead
    expect((await h.call('GET', '/api/admin/nft', { wallet: wallet() })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/nft/reveal', { wallet: ADMIN, body: {} })).body.error).toBe('wrong_state');
    h.evm.mint.phase = 2;
    h.evm.mint.phaseName = 'public';
    const open = await h.call('POST', '/api/admin/nft/reveal/schedule', { wallet: ADMIN, body: {} });
    expect(open.status).toBe(409);
    expect(open.body.message).toMatch(/Close the mint/);
    h.evm.mint.phase = 0;
    h.evm.mint.phaseName = 'closed';
    const past = await h.call('POST', '/api/admin/nft/reveal/schedule', { wallet: ADMIN, body: { block: Number(h.evm.block) } });
    expect(past.status).toBe(400);
    expect((await h.call('POST', '/api/admin/nft/reveal/schedule', { wallet: ADMIN, body: { block: 'soon' } })).status).toBe(400);
    const sched = await h.call('POST', '/api/admin/nft/reveal/schedule', { wallet: ADMIN, body: {} });
    expect(sched.status).toBe(200);
    const target = BigInt(sched.body.revealBlock);
    expect(target).toBe(h.evm.block + 50n);
    // not mined yet
    expect((await h.call('POST', '/api/admin/nft/reveal', { wallet: ADMIN, body: {} })).body.message).toMatch(/not mined/);
    h.evm.block = target + 1n;
    const rev = await h.call('POST', '/api/admin/nft/reveal', { wallet: ADMIN, body: {} });
    expect(rev.status).toBe(200);
    const hash = await h.evm.blockHash(target);
    expect(rev.body).toMatchObject({ revealed: true, seed: SEED, blockHash: hash, offset: revealOffset(hash!, prov.provenance, 1000) });
    // a second reveal is refused; the admin view shows the state
    expect((await h.call('POST', '/api/admin/nft/reveal', { wallet: ADMIN, body: {} })).status).toBe(409);
    const view = (await h.call('GET', '/api/admin/nft', { wallet: ADMIN })).body;
    expect(view).toMatchObject({ style: 'vector', provenance: { revealed: true }, mint: { phase: 'closed', totalSupply: 3 } });
    // token 2 now shows art (offset + 1) of the published order, in the OpenSea format
    const g = genomes[(1 + rev.body.offset) % 1000];
    const meta = await h.call('GET', '/api/nft/2');
    expect(meta.headers.get('cache-control')).toBe('public, max-age=300');
    expect(meta.body.image).toBe(`https://coinnibal.example/api/nft/2.svg?v=${target}`);
    expect(meta.body.attributes[0]).toEqual({ trait_type: 'Tier', value: g.tier });
    expect(meta.body.attributes.find((a: { trait_type: string }) => a.trait_type === 'Material').value).toBe(g.material);
    const svg = await h.call('GET', '/api/nft/2.svg');
    expect(svg.text).toBe(h.app.nft.svg(2));
    expect(svg.text).not.toBe(unrevealedSvg(2, 'vector'));
    expect((await h.call('GET', '/api/nft/2.svg?style=pixel')).text).toContain('shape-rendering="crispEdges"');
  });
});

describe('nft paths', () => {
  it('parses <id> and <id>.svg', () => {
    expect(parseNftPath('12.svg')).toEqual({ id: 12, svg: true });
    expect(parseNftPath('12')).toEqual({ id: 12, svg: false });
    expect(parseNftPath('-1')).toBeNull();
  });
});

describe('game gate modes', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
    h.app.contracts.set('nft', { address: NFT, txHash: null, chainId: 31337, registeredAt: 1, registeredBy: ADMIN });
  });
  afterAll(async () => {
    await h.app.close();
  });

  const tryJoin = (w: string | null): Promise<string> => joinPractice(h, w);

  it('admins: only admin wallets; holders: NFT holders + admins (balanceOf, cached 60 s); public: everyone', async () => {
    const holder = wallet();
    const nobody = wallet();
    h.evm.mintNft(holder);
    expect(await tryJoin(ADMIN)).toBe('joined');
    expect(await tryJoin(holder)).toBe('game_closed');
    expect((await h.call('PUT', '/api/admin/settings', { wallet: ADMIN, body: { gameAccess: 'holders' } })).status).toBe(200);
    expect(await tryJoin(holder)).toBe('joined');
    expect(await tryJoin(holder.toLowerCase())).toBe('joined');
    expect(await tryJoin(nobody)).toBe('game_closed');
    expect(await tryJoin(null)).toBe('game_closed');
    expect(await tryJoin(ADMIN)).toBe('joined');
    expect((await h.call('GET', '/api/auth/me', { wallet: holder })).body).toEqual({ address: holder, admin: false, holder: true, canPlay: true });
    // a refused wallet that then mints gets in within seconds: a negative answer is cached only 2 s
    // (the mint page sends it straight to /play)
    expect((await h.call('GET', '/api/auth/me', { wallet: nobody })).body.canPlay).toBe(false);
    h.evm.mintNft(nobody);
    await new Promise((r) => setTimeout(r, 2_100));
    expect((await h.call('GET', '/api/auth/me', { wallet: nobody })).body.canPlay).toBe(true);
    // the balance is cached 15 s for the lobby; an arena seat re-checks it uncached (`fresh`)
    h.evm.balances.set(holder.toLowerCase(), 0n);
    expect(await h.app.site.gameOpenFor(holder)).toBe(true);
    expect(await h.app.site.gameOpenFor(holder, true)).toBe(false);
    expect(await h.app.site.gameOpenFor(holder)).toBe(false);
    await h.call('PUT', '/api/admin/settings', { wallet: ADMIN, body: { gameAccess: 'public' } });
    expect(await tryJoin(null)).toBe('joined');
    expect((await h.call('GET', '/api/site/mint')).body.gameAccess).toBe('public');
    await h.call('PUT', '/api/admin/settings', { wallet: ADMIN, body: { gameAccess: 'admins' } });
  });

  it('GAME_ACCESS overrides the setting', async () => {
    const x = await harness({ GAME_ACCESS: 'holders' });
    try {
      expect(x.app.site.gameAccess()).toBe('holders');
      expect((await x.call('GET', '/api/site/settings')).body.settings.gameAccess).toBe('holders');
      expect((await x.call('GET', '/api/admin/settings', { wallet: ADMIN })).body).toMatchObject({ settings: { gameAccess: 'admins' }, gameAccessEnv: 'holders' });
      // no NFT registered: nobody holds one
      expect(await x.app.site.gameOpenFor(wallet())).toBe(false);
    } finally {
      await x.app.close();
    }
  });
});

describe('holder checks behind one address at the default RPC budget (R3-NET-1, R4-NET-1)', () => {
  // every request comes from 127.0.0.1, at the default RPC budget (4 calls/s): one client may read a holder 3.75
  // times a minute, in bursts of 2, and only for a gate decision
  async function holderHarness(gameAccess: 'public' | 'holders' = 'public'): Promise<Harness & { reads: () => number }> {
    const h = await harness();
    h.app.contracts.set('nft', { address: NFT, txHash: null, chainId: 31337, registeredAt: 1, registeredBy: ADMIN });
    await h.call('PUT', '/api/admin/settings', { wallet: ADMIN, body: { gameAccess } });
    let reads = 0;
    const balance = h.evm.nftBalance.bind(h.evm);
    h.evm.nftBalance = async (...a: Parameters<typeof balance>) => (reads++, balance(...a));
    return Object.assign(h, { reads: () => reads });
  }
  const create = (h: Harness, w: string) => h.call('POST', '/api/rooms/custom', { wallet: w, body: { config: { ...CUSTOM_DEFAULTS, name: 'Friday Pond' } } });

  it('values shown never read the chain and never say busy; a gate decision past the bound is answered from the holder index read after it, busy only while the index cannot catch up', { timeout: 30_000 }, async () => {
    const h = await holderHarness();
    try {
      // pages of many wallets: all answered, none read on chain
      for (let i = 0; i < 12; i++) expect((await h.call('GET', '/api/profile', { wallet: wallet() })).status).toBe(200);
      const plain = wallet();
      for (const path of ['/api/profile', '/api/auth/me', '/api/shop', '/api/rooms/custom/quote']) {
        const r = await h.call('GET', path, { wallet: plain });
        expect(r.status, path).toBe(200);
      }
      expect((await h.call('GET', '/api/profile', { wallet: plain })).body.holder).toBe(false);
      expect((await h.call('GET', '/api/auth/me', { wallet: plain })).body).toEqual({ address: plain, admin: false, holder: false, canPlay: true });
      expect(await joinPractice(h, plain)).toBe('joined');
      expect(h.reads()).toBe(0);
      // a holder that minted a moment ago is shown as one within seconds: the index reads the new blocks in the
      // background (at most every HOLDERS_ON_DEMAND_MS), still without a read of its own
      const holder = wallet();
      h.evm.mintNft(holder);
      let me: any = null;
      for (let i = 0; i < 150 && !me?.holder; i++) {
        await new Promise((r) => setTimeout(r, 60));
        me = (await h.call('GET', '/api/auth/me', { wallet: holder })).body;
      }
      expect(me).toEqual({ address: holder, admin: false, holder: true, canPlay: true });
      expect((await h.call('GET', '/api/profile', { wallet: holder })).body.holder).toBe(true);
      expect(h.reads()).toBe(0);
      // holders mode: who may play is a gate decision. Throwaway wallets spend the address's holder reads; past them a
      // wallet with nothing on record is answered from the holder index read after its request: not a holder, never
      // busy; one that minted a moment ago plays; an admin never waits on it
      await h.call('PUT', '/api/admin/settings', { wallet: ADMIN, body: { gameAccess: 'holders' } });
      for (let i = 0; i < 3; i++) await h.call('GET', '/api/auth/me', { wallet: wallet() });
      const spent = h.reads();
      expect(spent).toBeGreaterThan(0);
      const other = wallet();
      expect((await h.call('GET', '/api/auth/me', { wallet: other })).body).toEqual({ address: other, admin: false, holder: false, canPlay: false });
      expect(await joinPractice(h, other)).toBe('game_closed');
      const minted = wallet();
      h.evm.mintNft(minted);
      expect((await h.call('GET', '/api/auth/me', { wallet: minted })).body).toEqual({ address: minted, admin: false, holder: true, canPlay: true });
      expect(await joinPractice(h, minted)).toBe('joined');
      expect((await h.call('GET', '/api/auth/me', { wallet: holder })).body).toMatchObject({ holder: true, canPlay: true });
      expect((await h.call('GET', '/api/auth/me', { wallet: ADMIN })).body).toMatchObject({ admin: true, canPlay: true });
      expect(h.reads()).toBe(spent);
      // the shop and a room quote are only shown: as not a holder (403 game_closed), never 429
      expect((await h.call('GET', '/api/shop', { wallet: other })).status).toBe(403);
      expect((await h.call('GET', '/api/rooms/custom/quote', { wallet: other })).status).toBe(403);
      expect((await h.call('GET', '/api/shop', { wallet: minted })).status).toBe(200);
      // the index cannot read the new blocks (the RPC refuses the logs; a failed scan backs off): a wallet with
      // nothing on record hears busy, never "not a holder"
      h.evm.block += 1n;
      h.evm.limited.set('transferLogs', 1);
      const later = wallet();
      expect((await h.call('GET', '/api/auth/me', { wallet: later })).body).toEqual({ address: later, admin: false, holder: false, canPlay: false, busy: true });
      expect((await h.call('GET', '/api/auth/me', { wallet: minted })).body).toMatchObject({ holder: true, canPlay: true });
    } finally {
      await h.app.close();
    }
  });

  it('one player alone: auth/me, the profile and a room quote, then the room\'s creation is answered, never busy (R4-NET-1)', { timeout: 30_000 }, async () => {
    const h = await holderHarness();
    try {
      // no NFT, the pages a little more than HOLDER_MISS_TTL_MS apart (each would be a holder check of its own): the
      // creation gets past the holder check, at the full price (no fee paid: this server has no payment target)
      const me = wallet();
      const pause = () => new Promise((r) => setTimeout(r, HOLDER_MISS_TTL_MS + 100));
      for (const path of ['/api/auth/me', '/api/profile', '/api/rooms/custom/quote']) {
        expect((await h.call('GET', path, { wallet: me })).status, path).toBe(200);
        await pause();
      }
      const first = await create(h, me);
      expect([first.status, first.body.error]).toEqual([503, 'rooms_closed']);
      await pause();
      const again = await create(h, me);
      expect([again.status, again.body.error]).toEqual([503, 'rooms_closed']);
      // a holder that minted a moment ago, the same pages: its free room of the day opens
      const holder = wallet();
      h.evm.mintNft(holder);
      for (const path of ['/api/auth/me', '/api/profile', '/api/rooms/custom/quote']) expect((await h.call('GET', path, { wallet: holder })).status, path).toBe(200);
      const free = await create(h, holder);
      expect(free.status).toBe(201);
      expect(free.body.room.paidWith).toBe('free');
    } finally {
      await h.app.close();
    }
  });

  it('two players behind one address, no NFT: one browses, plays and creates rooms, the other\'s room creations are never busy (R4-NET-1)', { timeout: 60_000 }, async () => {
    const h = await holderHarness();
    try {
      const a = wallet();
      const b = wallet();
      const until = Date.now() + 12_000;
      const answers: string[] = [];
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // B: its pages and a practice game every second, and a room's creation (a gate decision) every 2 s
      const browse = (async () => {
        for (let n = 0; Date.now() < until; n++) {
          for (const path of ['/api/auth/me', '/api/profile', '/api/shop', '/api/rooms/custom/quote']) expect((await h.call('GET', path, { wallet: b })).status, path).toBe(200);
          expect(await joinPractice(h, b)).toBe('joined');
          if (n % 2 === 0) expect((await create(h, b)).status).not.toBe(429);
          await pause(1_000);
        }
      })();
      // A: a room's creation every 2 s
      const creates = (async () => {
        while (Date.now() < until) {
          const r = await create(h, a);
          answers.push(`${r.status} ${r.body.error}`);
          await pause(2_000);
        }
      })();
      await Promise.all([browse, creates]);
      expect(answers.length).toBeGreaterThanOrEqual(4);
      expect(new Set(answers)).toEqual(new Set(['503 rooms_closed']));
    } finally {
      await h.app.close();
    }
  });
});

describe('profiles', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ GAME_ACCESS: 'public' });
  });
  afterAll(async () => {
    await h.app.close();
  });

  it('GET / PUT /api/profile (signed-in), validated, used by the websocket sign-in', async () => {
    const w = wallet();
    expect((await h.call('GET', '/api/profile')).status).toBe(401);
    expect((await h.call('GET', '/api/profile', { wallet: w })).body.profile).toEqual({ wallet: w, name: null, skin: 0, stats: { games: 0, kills: 0, best: 0 }, updatedAt: null, avatar: null });
    expect((await h.call('PUT', '/api/profile', { wallet: w, body: { name: '', skin: 1 } })).body.field).toBe('name');
    expect((await h.call('PUT', '/api/profile', { wallet: w, body: { name: 'n'.repeat(17), skin: 1 } })).body.field).toBe('name');
    expect((await h.call('PUT', '/api/profile', { wallet: w, body: { name: 'Coin Lord', skin: 9999 } })).body.field).toBe('skin');
    const put = await h.call('PUT', '/api/profile', { wallet: w, body: { name: '  Coin   Lord ', skin: 3 } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toMatchObject({ wallet: w, name: 'Coin Lord', skin: 3 });

    // the websocket sign-in reads the same store; the name is used (verified) in rooms
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    const msgs: ServerMessage[] = [];
    ws.on('message', (d, bin) => {
      if (!bin) msgs.push(JSON.parse(d.toString()) as ServerMessage);
    });
    await new Promise((r) => ws.once('open', r));
    const wait = async <T extends ServerMessage['t']>(t: T) => {
      for (let i = 0; i < 300; i++) {
        const m = msgs.find((x) => x.t === t);
        if (m) return m as Extract<ServerMessage, { t: T }>;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${t}`);
    };
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
    await wait('welcome');
    ws.send(JSON.stringify({ t: 'auth', token: h.app.auth.issueToken(w) }));
    expect((await wait('authed')).profile).toEqual({ name: 'Coin Lord', skin: 3, xp: 0, level: 1, premiumSkins: 0 });
    ws.send(JSON.stringify({ t: 'join', room: 'practice', name: 'ignored', skin: 0 }));
    expect((await wait('joined')).name).toBe('Coin Lord');
    // a finished game counts in the server's own records
    ws.send(JSON.stringify({ t: 'leave' }));
    const xp = await wait('xp');
    expect(xp.xp).toBeGreaterThanOrEqual(0);
    ws.close();
    const after = (await h.call('GET', '/api/profile', { wallet: w })).body.profile;
    expect(after.stats.games).toBe(1);
    h.app.profiles.flush();
    expect(JSON.parse(readFileSync(join(h.dir, 'profiles.json'), 'utf8')).profiles[0]).toMatchObject({ wallet: w, name: 'Coin Lord', games: 1 });
  });

  it('the store persists and reloads, and ignores malformed rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-profiles-'));
    const path = join(dir, 'profiles.json');
    const a = new ProfileStore(path);
    const w = wallet();
    a.update(w.toLowerCase(), { name: 'Bob', skin: 2 });
    a.recordGame(w, { score: 500, kills: 3, xp: 120 });
    a.recordGame(w, { score: 200, kills: 1, xp: 30 });
    a.flush();
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.profiles.push({ wallet: 'not-a-wallet', name: 'old' });
    writeFileSync(path, JSON.stringify(raw));
    const b = new ProfileStore(path);
    expect(b.size).toBe(1);
    expect(b.view(w)).toMatchObject({ wallet: w, name: 'Bob', skin: 2, stats: { games: 2, kills: 4, best: 500 } });
    expect(b.summary(w)).toMatchObject({ name: 'Bob', xp: 150 });
    expect(b.summary(wallet())).toBeNull();
  });
});

// The project was called Elymum until November 2026: a data dir from then may keep its earlier default handles
// (@elymum, @elymumio) and seeded task texts that name it. These cases are that kept data, so they stay as written.
describe('X handle migration (previous default @elymum → @elymumio → @coinnibalfun)', () => {
  const now = 1_700_000_000_000;
  const seededOld = [
    { id: 'follow_x', kind: 'follow_x', title: 'Follow @elymum', body: 'Follow @elymum on X.', target: 'https://x.com/elymum', required: true, enabled: false, order: 0 },
    { id: 'post_x', kind: 'post_x', title: 'Post about Elymum on X', body: 'Post about Elymum on X, tag @elymum, then paste the link to your post.', target: null, required: true, enabled: true, order: 1 },
    { id: 'engage_launch', kind: 'engage_x', title: 'Like, repost and reply to the launch post', body: 'Like, repost and reply to the pinned launch post, then paste the link to your reply.', target: null, required: true, enabled: true, order: 2 },
    { id: 'custom', kind: 'join_link', title: 'Say hi to @elymum', body: 'Admin text about @elymum stays as written.', target: 'https://x.com/elymum', required: false, enabled: true, order: 3 },
  ];
  const oldAnswer = { id: 'follow_x', kind: 'follow_x', title: 'Follow @elymum', target: 'https://x.com/elymum', required: true, answer: true };

  function seed(dir: string, settings: Record<string, unknown>): void {
    mkdirSync(join(dir, 'site'), { recursive: true });
    writeFileSync(join(dir, SITE_FILES.settings), JSON.stringify(settings));
    writeFileSync(join(dir, SITE_FILES.tasks), JSON.stringify(seededOld));
    writeFileSync(
      join(dir, SITE_FILES.wl),
      JSON.stringify([{ id: 'wl_1', wallet: wallet(), xHandle: 'early', status: 'approved', tasks: [oldAnswer], note: 'follows @elymum', createdAt: now, updatedAt: now }]),
    );
  }

  it('seeds new data with @coinnibalfun', () => {
    const s = new SiteStore(null);
    expect(s.settings.xHandle).toBe('coinnibalfun');
    expect(s.tasks[0]).toMatchObject({ id: 'follow_x', title: 'Follow @coinnibalfun', body: 'Follow @coinnibalfun on X.', target: 'https://x.com/coinnibalfun' });
    expect(s.tasks[1]).toMatchObject({ title: 'Post about Coinnibal on X', body: 'Post about Coinnibal on X, tag @coinnibalfun, then paste the link to your post.' });
  });

  it('switches a stored previous default handle and rewrites only the seeded tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-handle-'));
    seed(dir, { wlOpen: true, collabOpen: false, gameAccess: 'holders', xHandle: 'elymum', launchPostUrl: null, launch: 1 });
    const logs: string[] = [];
    const s = new SiteStore(dir, { log: (m) => logs.push(m) });
    expect(s.settings).toEqual({ wlOpen: true, collabOpen: false, appetizerOpen: true, mintOpen: false, gameAccess: 'holders', xHandle: 'coinnibalfun', launchPostUrl: null, appetizerPostUrl: 'https://x.com/Coinnibalfun/status/2126283168374251696' });
    expect(JSON.parse(readFileSync(join(dir, SITE_FILES.settings), 'utf8')).xHandle).toBe('coinnibalfun');
    const [follow, postX, engage, custom] = s.tasks;
    // the seeded tasks keep their admin edits (enabled: false) and get the new handle
    expect(follow).toMatchObject({ id: 'follow_x', title: 'Follow @coinnibalfun', body: 'Follow @coinnibalfun on X.', target: 'https://x.com/coinnibalfun', enabled: false });
    expect(postX).toMatchObject({ title: 'Post about Coinnibal on X', body: 'Post about Coinnibal on X, tag @coinnibalfun, then paste the link to your post.' });
    expect(engage).toEqual(seededOld[2]);
    // an admin-written task is never touched
    expect(custom).toEqual(seededOld[3]);
    expect(JSON.parse(readFileSync(join(dir, SITE_FILES.tasks), 'utf8'))[0].title).toBe('Follow @coinnibalfun');
    // answers stored in WL entries (and the admin's note) stay as they were
    expect(s.getWl('wl_1')).toMatchObject({ note: 'follows @elymum', tasks: [oldAnswer] });
    expect(logs.join('\n')).toMatch(/previous default/);
    expect(logs.join('\n')).toMatch(/2 seeded WL task\(s\) now name Coinnibal and @coinnibalfun/);
    // idempotent: a second load changes nothing
    const again: string[] = [];
    const s2 = new SiteStore(dir, { log: (m) => again.push(m) });
    expect(s2.tasks).toEqual(s.tasks);
    expect(again).toEqual([]);
  });

  it('keeps a handle the admin chose, and points the seeded tasks at it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-handle-'));
    seed(dir, { wlOpen: true, collabOpen: true, gameAccess: 'admins', xHandle: 'elymum_arena', launchPostUrl: null });
    const s = new SiteStore(dir);
    expect(s.settings.xHandle).toBe('elymum_arena');
    expect(s.tasks[0]).toMatchObject({ title: 'Follow @elymum_arena', target: 'https://x.com/elymum_arena' });
    expect(s.tasks[3]).toEqual(seededOld[3]);
  });

  it('never rewrites a longer handle that only starts with the previous one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-handle-'));
    mkdirSync(join(dir, 'site'), { recursive: true });
    const tasks = [{ ...seededOld[0], title: 'Follow @elymumio and @Elymum_fans', body: 'See https://x.com/elymumio and x.com/ELYMUM.', target: 'https://x.com/elymumio' }];
    writeFileSync(join(dir, SITE_FILES.tasks), JSON.stringify(tasks));
    const s = new SiteStore(dir);
    expect(s.tasks[0]).toMatchObject({ title: 'Follow @coinnibalfun and @Elymum_fans', body: 'See https://x.com/coinnibalfun and x.com/coinnibalfun.', target: 'https://x.com/coinnibalfun' });
  });

  it('moves to a new default handle (X_HANDLE): the stored old default and the seeded tasks follow it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-handle-'));
    seed(dir, { wlOpen: true, collabOpen: false, gameAccess: 'holders', xHandle: 'elymumio', launchPostUrl: null });
    const s = new SiteStore(dir, { defaults: { xHandle: 'coinnibal' } });
    expect(s.settings.xHandle).toBe('coinnibal');
    expect(s.tasks[0]).toMatchObject({ title: 'Follow @coinnibal', body: 'Follow @coinnibal on X.', target: 'https://x.com/coinnibal' });
    expect(s.tasks[1].body).toBe('Post about Coinnibal on X, tag @coinnibal, then paste the link to your post.');
    // an admin-written task is never touched
    expect(s.tasks[3]).toEqual(seededOld[3]);
    // fresh data seeds the new handle
    expect(new SiteStore(null, { defaults: { xHandle: 'coinnibal' } }).tasks[0]).toMatchObject({ title: 'Follow @coinnibal' });
  });

  it('serves the migrated tasks over the API', async () => {
    const h = await harness({}, (dir) => seed(dir, { wlOpen: true, collabOpen: false, gameAccess: 'admins', xHandle: 'elymum', launchPostUrl: null }));
    try {
      const r = await h.call('GET', '/api/site/tasks');
      expect(r.status).toBe(200);
      // follow_x is disabled in this data, so post_x leads
      expect(r.body.tasks[0]).toMatchObject({ id: 'post_x', body: 'Post about Coinnibal on X, tag @coinnibalfun, then paste the link to your post.' });
      expect((await h.call('GET', '/api/site/settings')).body.settings.xHandle).toBe('coinnibalfun');
    } finally {
      await h.app.close();
    }
  });
});
