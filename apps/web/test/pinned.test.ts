import { coinnibalArenaArtifact } from '@coinnibal/sdk';
import { LOCALNET_CHAIN_ID, OWNER_WALLET, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID, sitePinsMessage, type SitePinsFields } from '@coinnibal/shared';
import { getAddress, keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { OWNER_ENV, PIN_ENV, buildPins, checkAnnounced, checkNft, forgetSignedPins, mayRunUnpinned, pinsFor, signedPinsFor, verifyArena, verifySignedPins, withSigned } from '../src/wallet/pinned';

const OTHER = '0x000000000000000000000000000000000000bEEF';
const MAIN_ARENA = '0x00000000000000000000000000000000000a4e4a';
const MAIN_TOKEN = '0x0000000000000000000000000000000000007e57';
const TEST_ARENA = getAddress('0x00000000000000000000000000000000000a4e4b');
const TEST_NFT = getAddress('0x000000000000000000000000000000000000f7e5');
const TEST_TOKEN = getAddress('0x0000000000000000000000000000000000007e58');
/** A testnet build pinned to the owner's deployment (VITE_CHAIN_ID unset: the testnet). */
const testnetBuild = () => buildPins({ arena: TEST_ARENA, nft: TEST_NFT, token: TEST_TOKEN });

/** A read client whose `getCode` serves `code` (or throws). */
const coder = (code: Hex | 'throw') => ({
  getCode: async () => {
    if (code === 'throw') throw new Error('fetch failed');
    return code;
  },
});

describe('contract pins', () => {
  it('no chain has default pins: a build trusts only what it was built with', () => {
    const p = buildPins({});
    expect(p.invalid).toEqual([]);
    // VITE_CHAIN_ID unset: the testnet, with nothing pinned (no hard-coded deployment)
    expect(p.chainId).toBe(ROBINHOOD_TESTNET_CHAIN_ID);
    expect(p.chains[ROBINHOOD_TESTNET_CHAIN_ID]).toEqual({ arena: null, nft: null, token: null });
    expect(p.chains[ROBINHOOD_CHAIN_ID]).toBeUndefined();
    // so an unpinned testnet build signs nothing, whatever the server announces
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: OTHER }, p)).toEqual({ ok: false, reason: 'unpinned' });
    expect(checkNft(ROBINHOOD_TESTNET_CHAIN_ID, OTHER, p)).toEqual({ ok: false, reason: 'unpinned' });
  });

  it('VITE_*_ADDRESS pin the contracts of the build chain (checksummed), and only that chain', () => {
    const p = buildPins({ chainId: String(ROBINHOOD_CHAIN_ID), arena: MAIN_ARENA, token: MAIN_TOKEN.toUpperCase().replace('0X', '0x') });
    expect(p.chainId).toBe(ROBINHOOD_CHAIN_ID);
    expect(p.chains[ROBINHOOD_CHAIN_ID]).toEqual({ arena: getAddress(MAIN_ARENA), nft: null, token: getAddress(MAIN_TOKEN) });
    // a mainnet build trusts nothing on the testnet
    expect(p.chains[ROBINHOOD_TESTNET_CHAIN_ID]).toBeUndefined();
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: MAIN_ARENA }, p)).toEqual({ ok: false, reason: 'unpinned' });
    // a testnet build pinned to the owner's deployment
    expect(testnetBuild().chains[ROBINHOOD_TESTNET_CHAIN_ID]).toEqual({ arena: TEST_ARENA, nft: TEST_NFT, token: TEST_TOKEN });
    // an env value that is not an address refuses everything
    const bad = buildPins({ arena: 'arena.eth' });
    expect(bad.invalid).toEqual(['VITE_ARENA_ADDRESS']);
    expect(PIN_ENV.arena).toBe('VITE_ARENA_ADDRESS');
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA }, bad)).toEqual({ ok: false, reason: 'bad_pin' });
  });

  it('refuses an announced arena that is not the pinned one, and a token that is not the pinned token', () => {
    const pins = testnetBuild();
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA.toLowerCase() }, pins)).toEqual({ ok: true, arena: TEST_ARENA });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: OTHER }, pins)).toEqual({ ok: false, reason: 'arena_mismatch' });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA, token: OTHER }, pins)).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA, token: TEST_TOKEN }, pins).ok).toBe(true);
    // without a token pin the arena's token is not checked against one
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA, token: OTHER }, buildPins({ arena: TEST_ARENA })).ok).toBe(true);
    // no arena announced, or garbage
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: null }, pins)).toEqual({ ok: false, reason: 'unpinned' });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: 'nope' }, pins)).toEqual({ ok: false, reason: 'unpinned' });
  });

  it('a mainnet build without pins signs nothing; the local node may run unpinned', () => {
    const pins = buildPins({});
    expect(checkAnnounced(ROBINHOOD_CHAIN_ID, { arena: OTHER }, pins)).toEqual({ ok: false, reason: 'unpinned' });
    expect(checkAnnounced(ROBINHOOD_CHAIN_ID, { arena: OTHER }, buildPins({ chainId: String(ROBINHOOD_CHAIN_ID) }))).toEqual({ ok: false, reason: 'unpinned' });
    expect(checkAnnounced(LOCALNET_CHAIN_ID, { arena: OTHER }, pins)).toEqual({ ok: true, arena: OTHER });
    expect(mayRunUnpinned(LOCALNET_CHAIN_ID)).toBe(true);
    expect(mayRunUnpinned(ROBINHOOD_TESTNET_CHAIN_ID)).toBe(false);
    // a localnet build pinned to its deploy refuses another arena
    const local = buildPins({ chainId: String(LOCALNET_CHAIN_ID), arena: MAIN_ARENA });
    expect(checkAnnounced(LOCALNET_CHAIN_ID, { arena: OTHER }, local)).toEqual({ ok: false, reason: 'arena_mismatch' });
  });

  it('checks the NFT the mint would call', () => {
    const pins = testnetBuild();
    expect(checkNft(ROBINHOOD_TESTNET_CHAIN_ID, TEST_NFT, pins)).toEqual({ ok: true, nft: TEST_NFT });
    expect(checkNft(ROBINHOOD_TESTNET_CHAIN_ID, OTHER, pins)).toEqual({ ok: false, reason: 'nft_mismatch' });
    expect(checkNft(ROBINHOOD_CHAIN_ID, OTHER, pins)).toEqual({ ok: false, reason: 'unpinned' });
    expect(checkNft(LOCALNET_CHAIN_ID, OTHER, pins)).toEqual({ ok: true, nft: OTHER });
  });
});

describe('arena code hash', () => {
  const pins = testnetBuild();
  const arena = { arena: TEST_ARENA };

  /** Stand-in runtime code and its hash (the real arena's code is checked against the hardhat node in the UX tours). */
  const CODE: Hex = '0x6080604052348015600f57600080fd5b50';
  const HASH = keccak256(CODE);

  it('checks against the compiled artifact by default', async () => {
    expect(coinnibalArenaArtifact.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    // code that is not the bundled build
    expect(await verifyArena(coder(CODE), ROBINHOOD_TESTNET_CHAIN_ID, arena, pins)).toEqual({ ok: false, reason: 'code_mismatch' });
  });

  it('accepts the arena build this site was made with', async () => {
    expect(await verifyArena(coder(CODE), ROBINHOOD_TESTNET_CHAIN_ID, arena, pins, HASH)).toEqual({ ok: true, arena: TEST_ARENA });
  });

  it('refuses other code, no code, and an unreadable chain', async () => {
    expect(await verifyArena(coder('0x6080604052'), ROBINHOOD_TESTNET_CHAIN_ID, arena, pins, HASH)).toEqual({ ok: false, reason: 'code_mismatch' });
    expect(await verifyArena(coder('0x'), ROBINHOOD_TESTNET_CHAIN_ID, arena, pins, HASH)).toEqual({ ok: false, reason: 'code_mismatch' });
    expect(await verifyArena(coder('throw'), ROBINHOOD_TESTNET_CHAIN_ID, arena, pins, HASH)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('never reads the code of an arena that is not pinned', async () => {
    let read = false;
    const client = { getCode: async () => ((read = true), CODE) };
    expect(await verifyArena(client, ROBINHOOD_TESTNET_CHAIN_ID, { arena: OTHER }, pins, HASH)).toEqual({ ok: false, reason: 'arena_mismatch' });
    expect(read).toBe(false);
  });
});

describe('signed pins (the owner signs the contracts; the server only keeps the record)', () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const fields = (over: Partial<SitePinsFields> = {}): SitePinsFields => ({ chainId: ROBINHOOD_TESTNET_CHAIN_ID, arena: TEST_ARENA, nft: TEST_NFT, token: TEST_TOKEN, signedAt: '2026-11-19T10:00:00.000Z', ...over });
  const sign = async (f: SitePinsFields, by = owner) => ({ ...f, signature: await by.signMessage({ message: sitePinsMessage(f) }) });

  it('the build knows the owner wallet; VITE_OWNER_WALLET overrides it, and garbage there signs nothing', () => {
    expect(buildPins({}).owner).toBe(getAddress(OWNER_WALLET));
    expect(OWNER_WALLET).toBe('0x08b2b32E932D5f429073a441E6eFd8e3D42369b2');
    expect(buildPins({ owner: owner.address.toLowerCase() }).owner).toBe(owner.address);
    const bad = buildPins({ owner: 'me' });
    expect([bad.owner, bad.invalid]).toEqual([null, [OWNER_ENV]]);
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA }, withSigned(bad, ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA, nft: null, token: null }))).toEqual({ ok: false, reason: 'bad_pin' });
  });

  it("accepts the owner's signature of exactly this chain and these addresses", async () => {
    const rec = await sign(fields());
    expect(await verifySignedPins(rec, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toEqual({ chainId: ROBINHOOD_TESTNET_CHAIN_ID, arena: TEST_ARENA, nft: TEST_NFT, token: TEST_TOKEN, signedAt: rec.signedAt });
    // no token yet
    const none = await sign(fields({ token: null }));
    expect((await verifySignedPins(none, ROBINHOOD_TESTNET_CHAIN_ID, owner.address))?.token).toBeNull();
  });

  it('refuses a wrong signer, a wrong chain, a changed address and garbage', async () => {
    const rec = await sign(fields());
    expect(await verifySignedPins(await sign(fields(), privateKeyToAccount(generatePrivateKey())), ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins(rec, ROBINHOOD_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins({ ...rec, chainId: ROBINHOOD_CHAIN_ID }, ROBINHOOD_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins({ ...rec, arena: OTHER }, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins({ ...rec, nft: OTHER }, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins({ ...rec, token: OTHER }, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins({ ...rec, token: null }, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins({ ...rec, signedAt: '2026-11-19T10:00:00.001Z' }, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins({ ...rec, signature: '0x1234' }, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins(null, ROBINHOOD_TESTNET_CHAIN_ID, owner.address)).toBeNull();
    expect(await verifySignedPins(rec, ROBINHOOD_TESTNET_CHAIN_ID, null)).toBeNull();
  });

  it('the build pins win per contract; the signed record fills the rest', () => {
    const signed = { arena: TEST_ARENA, nft: TEST_NFT, token: TEST_TOKEN };
    const merged = withSigned(buildPins({ arena: OTHER }), ROBINHOOD_TESTNET_CHAIN_ID, signed);
    expect(merged.chains[ROBINHOOD_TESTNET_CHAIN_ID]).toEqual({ arena: getAddress(OTHER), nft: TEST_NFT, token: TEST_TOKEN });
    // another chain than the build's: the signed record alone
    expect(withSigned(buildPins({}), ROBINHOOD_CHAIN_ID, signed).chains[ROBINHOOD_CHAIN_ID]).toEqual(signed);
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA, token: TEST_TOKEN }, withSigned(buildPins({}), ROBINHOOD_TESTNET_CHAIN_ID, signed))).toEqual({ ok: true, arena: TEST_ARENA });
    expect(checkNft(ROBINHOOD_TESTNET_CHAIN_ID, OTHER, withSigned(buildPins({}), ROBINHOOD_TESTNET_CHAIN_ID, signed))).toEqual({ ok: false, reason: 'nft_mismatch' });
  });

  it('reads the record from the server, refuses one older than a record this browser accepted, and an unreadable server signs nothing', async () => {
    localStorage.clear();
    const newer = await sign(fields({ signedAt: '2026-11-19T12:00:00.000Z' }));
    const older = await sign(fields({ signedAt: '2026-11-19T11:00:00.000Z' }));
    expect((await signedPinsFor(ROBINHOOD_TESTNET_CHAIN_ID, { owner: owner.address, fetch: async () => newer }))?.signedAt).toBe(newer.signedAt);
    expect(await signedPinsFor(ROBINHOOD_TESTNET_CHAIN_ID, { owner: owner.address, fetch: async () => older })).toBeNull();
    // the same record again is fine
    expect(await signedPinsFor(ROBINHOOD_TESTNET_CHAIN_ID, { owner: owner.address, fetch: async () => newer })).not.toBeNull();
    await expect(signedPinsFor(ROBINHOOD_TESTNET_CHAIN_ID, { owner: owner.address, fetch: async () => Promise.reject(new Error('down')) })).rejects.toThrow('down');
    forgetSignedPins();
    localStorage.clear();
  });

  it("pinsFor asks GET /api/site/pins of the chain; verifyArena refuses while it cannot be read", async () => {
    const rec = await sign(fields({ signedAt: '2026-11-19T13:00:00.000Z' }));
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ record: rec }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const pins = await pinsFor(ROBINHOOD_TESTNET_CHAIN_ID, buildPins({ owner: owner.address }));
      expect(pins.chains[ROBINHOOD_TESTNET_CHAIN_ID]).toEqual({ arena: TEST_ARENA, nft: TEST_NFT, token: TEST_TOKEN });
      expect(asked[0]).toMatch(/\/api\/site\/pins\?chainId=46630$/);
      // a build that pins all three asks nothing
      await pinsFor(ROBINHOOD_TESTNET_CHAIN_ID, testnetBuild());
      expect(asked).toHaveLength(1);
      forgetSignedPins();
      vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('fetch failed')));
      expect(await verifyArena(coder('0x'), ROBINHOOD_TESTNET_CHAIN_ID, { arena: TEST_ARENA })).toEqual({ ok: false, reason: 'unreadable' });
    } finally {
      vi.unstubAllGlobals();
      forgetSignedPins();
      localStorage.clear();
    }
  });
});
