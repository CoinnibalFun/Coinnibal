import { coinnibalArenaArtifact } from '@coinnibal/sdk';
import { LOCALNET_CHAIN_ID, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from '@coinnibal/shared';
import { getAddress, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { PIN_ENV, buildPins, checkAnnounced, checkNft, mayRunUnpinned, verifyArena } from '../src/wallet/pinned';

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
