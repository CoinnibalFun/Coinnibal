import { coinnibalArenaArtifact } from '@coinnibal/sdk';
import { LOCALNET_CHAIN_ID, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from '@coinnibal/shared';
import { getAddress, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { TESTNET_PINS, buildPins, checkAnnounced, checkNft, verifyArena } from '../src/wallet/pinned';

const OTHER = '0x000000000000000000000000000000000000bEEF';
const MAIN_ARENA = '0x00000000000000000000000000000000000a4e4a';
const MAIN_TOKEN = '0x0000000000000000000000000000000000007e57';

/** A read client whose `getCode` serves `code` (or throws). */
const coder = (code: Hex | 'throw') => ({
  getCode: async () => {
    if (code === 'throw') throw new Error('fetch failed');
    return code;
  },
});

describe('contract pins', () => {
  it('pins the known testnet deployment by default', () => {
    const p = buildPins({});
    expect(p.invalid).toEqual([]);
    expect(p.chains[ROBINHOOD_TESTNET_CHAIN_ID]).toEqual(TESTNET_PINS);
    expect(TESTNET_PINS.arena).toBe('0x1F50Fe469f86eFCacDEeC25885BB519aFbAd1B9b');
    expect(TESTNET_PINS.nft).toBe('0xE8d601B7D415f1f23647115Ae1E38360BC1414Ff');
    expect(TESTNET_PINS.token).toBe('0xfD31b13e6684465a3B3161375E7F82F6A3DeEa11');
    // nothing on mainnet without the build's env
    expect(p.chains[ROBINHOOD_CHAIN_ID]).toBeUndefined();
  });

  it('VITE_*_ADDRESS pin the contracts of the build chain (checksummed)', () => {
    const p = buildPins({ chainId: String(ROBINHOOD_CHAIN_ID), arena: MAIN_ARENA, token: MAIN_TOKEN.toUpperCase().replace('0X', '0x') });
    expect(p.chains[ROBINHOOD_CHAIN_ID]).toEqual({ arena: getAddress(MAIN_ARENA), nft: null, token: getAddress(MAIN_TOKEN) });
    // the testnet keeps its own pins
    expect(p.chains[ROBINHOOD_TESTNET_CHAIN_ID]).toEqual(TESTNET_PINS);
    // an env value that is not an address refuses everything
    const bad = buildPins({ arena: 'arena.eth' });
    expect(bad.invalid).toEqual(['VITE_ARENA_ADDRESS']);
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TESTNET_PINS.arena }, bad)).toEqual({ ok: false, reason: 'bad_pin' });
  });

  it('refuses an announced arena that is not the pinned one, and a token that is not the pinned token', () => {
    const pins = buildPins({});
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TESTNET_PINS.arena!.toLowerCase() }, pins)).toEqual({ ok: true, arena: TESTNET_PINS.arena });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: OTHER }, pins)).toEqual({ ok: false, reason: 'arena_mismatch' });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TESTNET_PINS.arena, token: OTHER }, pins)).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: TESTNET_PINS.arena, token: TESTNET_PINS.token }, pins).ok).toBe(true);
    // no arena announced, or garbage
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: null }, pins)).toEqual({ ok: false, reason: 'unpinned' });
    expect(checkAnnounced(ROBINHOOD_TESTNET_CHAIN_ID, { arena: 'nope' }, pins)).toEqual({ ok: false, reason: 'unpinned' });
  });

  it('a mainnet build without pins signs nothing; the local node may run unpinned', () => {
    const pins = buildPins({});
    expect(checkAnnounced(ROBINHOOD_CHAIN_ID, { arena: OTHER }, pins)).toEqual({ ok: false, reason: 'unpinned' });
    expect(checkAnnounced(LOCALNET_CHAIN_ID, { arena: OTHER }, pins)).toEqual({ ok: true, arena: OTHER });
    // a localnet build pinned to its deploy refuses another arena
    const local = buildPins({ chainId: String(LOCALNET_CHAIN_ID), arena: MAIN_ARENA });
    expect(checkAnnounced(LOCALNET_CHAIN_ID, { arena: OTHER }, local)).toEqual({ ok: false, reason: 'arena_mismatch' });
  });

  it('checks the NFT the mint would call', () => {
    const pins = buildPins({});
    expect(checkNft(ROBINHOOD_TESTNET_CHAIN_ID, TESTNET_PINS.nft, pins)).toEqual({ ok: true, nft: TESTNET_PINS.nft });
    expect(checkNft(ROBINHOOD_TESTNET_CHAIN_ID, OTHER, pins)).toEqual({ ok: false, reason: 'nft_mismatch' });
    expect(checkNft(ROBINHOOD_CHAIN_ID, OTHER, pins)).toEqual({ ok: false, reason: 'unpinned' });
  });
});

describe('arena code hash', () => {
  const pins = buildPins({});
  const arena = { arena: TESTNET_PINS.arena };

  /** Stand-in runtime code and its hash (the real arena's code is checked against the hardhat node in the UX tours). */
  const CODE: Hex = '0x6080604052348015600f57600080fd5b50';
  const HASH = keccak256(CODE);

  it('checks against the compiled artifact by default', async () => {
    expect(coinnibalArenaArtifact.runtimeCodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    // code that is not the bundled build
    expect(await verifyArena(coder(CODE), ROBINHOOD_TESTNET_CHAIN_ID, arena, pins)).toEqual({ ok: false, reason: 'code_mismatch' });
  });

  it('accepts the arena build this site was made with', async () => {
    expect(await verifyArena(coder(CODE), ROBINHOOD_TESTNET_CHAIN_ID, arena, pins, HASH)).toEqual({ ok: true, arena: TESTNET_PINS.arena });
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
