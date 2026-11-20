import { describe, expect, it } from 'vitest';
import { setupSteps } from '../src/admin/QuickSetup';
import { faucetTokenToRegister } from '../src/admin/setup';

const ARENA = '0x9bdc7dcbb3ea173e3111093a64cbe547e2f82a68';
const NFT = '0x0000000000000000000000000000000000000f7e';
const TOKEN = '0xfeeb469fe3c892ebb82e44cef5f3bf1c74c11167';
const KEY = '0xabec7B8ed9b87989106f6d0510ec9Dd9DEE0a1FC';

function ctx(over: Record<string, unknown> = {}) {
  const status = {
    arena: { address: ARENA, config: { admin: '0x08b2b32E932D5f429073a441E6eFd8e3D42369b2', serverAuthority: KEY, token: null, burnBps: 1500, vaultBps: 500, holderNft: null }, token: null, arenas: [] },
    nft: { address: NFT, state: { phaseName: 'closed' } },
    testToken: { address: TOKEN, faucet: { holderNft: null } },
    ...over,
  };
  return { status } as never;
}

describe('finish setup', () => {
  it('lists every missing owner step in order on a fresh testnet deploy', () => {
    const ids = setupSteps(ctx(), { openMint: true }).map((s) => s.id);
    // nothing grants the server key a mint: it never mints
    expect(ids).toEqual(['token', 'arena-1', 'arena-2', 'arena-3', 'arena-4', 'faucet-nft', 'perks', 'holders-4', 'mint']);
  });

  it('sets the owner\'s holder pair 8 % + 2 % of profit (10 % in all), against the arena\'s normal pair', () => {
    const perks = setupSteps(ctx(), { openMint: true }).find((s) => s.id === 'perks')!;
    expect(perks.label).toBe('NFT holders pay 10 % of profit instead of 20 %');
    expect(perks.call).toMatchObject({ functionName: 'setHolderPerks', args: [expect.stringMatching(/^0x/i), 800, 200] });
  });

  it('leaves out what is already done on chain', () => {
    const arenas = [1, 2, 3, 4].map((id) => ({ id, exists: true, holdersOnly: id === 4 }));
    const c = ctx({
      arena: { address: ARENA, config: { admin: '0x08b2b32E932D5f429073a441E6eFd8e3D42369b2', serverAuthority: KEY, token: TOKEN, burnBps: 1500, vaultBps: 500, holderNft: NFT, holderBurnBps: 800, holderVaultBps: 200 }, token: { decimals: 18 }, arenas },
      nft: { address: NFT, state: { phaseName: 'public' } },
      testToken: { address: TOKEN, faucet: { holderNft: NFT } },
    });
    expect(setupSteps(c, { openMint: true })).toEqual([]);
  });

  it('offers the holder pair again when the live one drifted from 8 % + 2 % (the NFT already set), and only that', () => {
    const arenas = [1, 2, 3, 4].map((id) => ({ id, exists: true, holdersOnly: id === 4 }));
    const done = (holderBurnBps: number, holderVaultBps: number, nft: unknown = { address: NFT, state: { phaseName: 'public' } }) =>
      ctx({
        arena: { address: ARENA, config: { admin: '0x08b2b32E932D5f429073a441E6eFd8e3D42369b2', serverAuthority: KEY, token: TOKEN, burnBps: 1500, vaultBps: 500, holderNft: NFT, holderBurnBps, holderVaultBps }, token: { decimals: 18 }, arenas },
        nft,
        testToken: { address: TOKEN, faucet: { holderNft: NFT } },
      });
    // the live testnet pair: 15 % burned, nothing to the fee wallet
    const steps = setupSteps(done(1500, 0), { openMint: true });
    expect(steps.map((s) => s.id)).toEqual(['perks']);
    expect(steps[0].label).toBe('NFT holders pay 10 % of profit instead of 20 %');
    expect(steps[0].call).toMatchObject({ functionName: 'setHolderPerks', args: [expect.stringMatching(new RegExp(`^${NFT}$`, 'i')), 800, 200] });
    // the NFT address unknown to the status: the arena's own holder NFT is kept
    expect(setupSteps(done(800, 0, null), { openMint: true }).find((s) => s.id === 'perks')!.call).toMatchObject({ args: [expect.stringMatching(new RegExp(`^${NFT}$`, 'i')), 800, 200] });
    // the owner's pair: nothing to do
    expect(setupSteps(done(800, 200), { openMint: true })).toEqual([]);
  });

  it('never opens the mint on mainnet', () => {
    expect(setupSteps(ctx(), { openMint: false }).map((s) => s.id)).not.toContain('mint');
  });
});

describe('the faucet token', () => {
  const status = (token: string | null) => ({ arena: { address: ARENA, config: { token } } }) as never;
  const registry = (token: string | null) => ({ arena: { address: ARENA }, nft: { address: NFT }, token: token ? { address: token } : null }) as never;

  it('on a testnet, the arena\'s game token must be the one registered with the server: /faucet hands out that one', () => {
    // the token set on chain, the registry without it (a chain deployed outside the panel): register it
    expect(faucetTokenToRegister({ testnet: true, status: status(TOKEN), registry: registry(null) })).toBe('0xFEeB469fE3c892ebb82e44cef5f3bf1C74C11167');
    // another token registered: the faucet would hand out that one
    expect(faucetTokenToRegister({ testnet: true, status: status(TOKEN), registry: registry(NFT) })?.toLowerCase()).toBe(TOKEN);
    // registered (any letter case): nothing to do
    expect(faucetTokenToRegister({ testnet: true, status: status(TOKEN), registry: registry(TOKEN.toUpperCase().replace('0X', '0x')) })).toBeNull();
  });

  it('nothing before the token is set, on mainnet, or while the registry is not read', () => {
    expect(faucetTokenToRegister({ testnet: true, status: status(null), registry: registry(null) })).toBeNull();
    expect(faucetTokenToRegister({ testnet: false, status: status(TOKEN), registry: registry(null) })).toBeNull();
    expect(faucetTokenToRegister({ testnet: true, status: status(TOKEN), registry: null })).toBeNull();
    expect(faucetTokenToRegister({ testnet: true, status: status(TOKEN), registry: undefined })).toBeNull();
    expect(faucetTokenToRegister({ testnet: true, status: null, registry: registry(null) })).toBeNull();
  });
});
