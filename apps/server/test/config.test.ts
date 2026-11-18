import { describe, expect, it } from 'vitest';
import { invalidAdminWallets, loadConfig, parseAdminWallets, parseRoundConfig } from '../src/config';

describe('Coinnibal config', () => {
  it('has no Pass power, marketplace links or fake Pass collection any more', () => {
    const cfg = loadConfig({ PASS_START_MASS_MUL: '1.3', MARKET_URL_OPENSEA: 'https://opensea.io/x', DEV_FAKE_PASS: 'revealed' });
    expect('pass' in cfg).toBe(false);
    expect('markets' in cfg).toBe(false);
    expect('devFakePass' in cfg).toBe(false);
  });

  it('DEV_FAKE_TOKEN=1 starts the fake chain with its token set (default: unset)', () => {
    expect(loadConfig({}).devFakeToken).toBe(false);
    expect(loadConfig({ DEV_FAKE_TOKEN: '1' }).devFakeToken).toBe(true);
  });
});

describe('chain env (EVM)', () => {
  it('reads every chain variable and ignores the retired ones (CHAIN_NAME, GAS_SYMBOL, HYPE_*)', () => {
    const cfg = loadConfig({
      EVM_RPC_URL: 'https://rpc.example/key123/',
      PUBLIC_RPC_URL: 'https://public.example/',
      CHAIN_NAME: 'Retired',
      GAS_SYMBOL: 'NOPE',
      HYPE_FAUCET_URL: 'https://old-faucet.example',
      EXPLORER_URL: 'https://explorer.example/',
      ARENA_ADDRESS: '0x00000000000000000000000000000000000000a1',
      NFT_ADDRESS: '0x00000000000000000000000000000000000000b2',
      SERVER_PRIVATE_KEY: 'auto',
      MINT_USD_CENTS: '250',
      GAS_PRICE_URL: 'https://price.example/info',
      HYPE_PRICE_URL: 'https://old.example/info',
      TOKEN_SYMBOL: '$TEST',
      GAME_ACCESS: 'holders',
    } as NodeJS.ProcessEnv);
    expect(cfg.chain).toMatchObject({
      rpcUrl: 'https://rpc.example/key123',
      publicRpcUrl: 'https://public.example',
      chainId: 46630,
      gasFaucetUrl: null,
      explorerUrl: 'https://explorer.example',
      arenaAddress: '0x00000000000000000000000000000000000000a1',
      nftAddress: '0x00000000000000000000000000000000000000b2',
      serverKey: 'auto',
      tokenSymbol: '$TEST',
    });
    expect(cfg.mint).toEqual({ usdCents: 250, gasPriceUrl: 'https://price.example/info' });
    expect(cfg.gameAccess).toBe('holders');
    expect('chainName' in cfg.chain || 'gasSymbol' in cfg.chain).toBe(false);
  });

  it('CHAIN_ID picks a Robinhood Chain network (testnet by default); any other chain refuses to start', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).chain).toMatchObject({ chainId: 46630, chainIdExplicit: false });
    expect(loadConfig({ CHAIN_ID: '4663' } as NodeJS.ProcessEnv).chain).toMatchObject({ chainId: 4663, chainIdExplicit: true });
    expect(loadConfig({ CHAIN_ID: '31337' } as NodeJS.ProcessEnv).chain.chainId).toBe(31337);
    expect(() => loadConfig({ CHAIN_ID: '99801' } as NodeJS.ProcessEnv)).toThrow(/CHAIN_ID: chain 99801 is not Robinhood Chain/);
    expect(() => loadConfig({ CHAIN_ID: 'mainnet' } as NodeJS.ProcessEnv)).toThrow(/not Robinhood Chain/);
    // the testnet emblem import reads Robinhood Chain Testnet by default
    expect(loadConfig({} as NodeJS.ProcessEnv).chain.testnetRpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
  });

  it('defaults: chain off, plain token word, $1 mint on Hyperliquid, the setting decides who plays', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.chain).toMatchObject({ rpcUrl: null, publicRpcUrl: null, serverKey: null, arenaAddress: null, nftAddress: null, tokenSymbol: 'tokens' });
    expect(cfg.mint).toEqual({ usdCents: 100, gasPriceUrl: 'https://api.hyperliquid.xyz/info' });
    // the owner's fixed supply (3,333), the same as the NFT contract's max supply at deploy
    expect(cfg.nft).toEqual({ size: 3333, seed: null, style: 'vector' });
    expect(loadConfig({ NFT_ART_STYLE: 'pixel', NFT_COLLECTION_SIZE: '500', NFT_COLLECTION_SEED: ' 0xabc ' } as NodeJS.ProcessEnv).nft).toEqual({ size: 500, seed: '0xabc', style: 'pixel' });
    expect(loadConfig({ NFT_ART_STYLE: 'oil' } as NodeJS.ProcessEnv).nft.style).toBe('vector');
    expect(cfg.gameAccess).toBeNull();
    // the project's X handle: unset is the shared default; X_HANDLE moves it (e.g. to another account)
    expect(cfg.xHandle).toBeNull();
    expect(loadConfig({ X_HANDLE: '@Coinnibal' } as NodeJS.ProcessEnv).xHandle).toBe('coinnibal');
    expect(loadConfig({ X_HANDLE: 'not a handle!' } as NodeJS.ProcessEnv).xHandle).toBeNull();
    expect(loadConfig({ GAME_ACCESS: 'everyone' } as NodeJS.ProcessEnv).gameAccess).toBeNull();
    expect(loadConfig({ GAME_ACCESS: ' PUBLIC ' } as NodeJS.ProcessEnv).gameAccess).toBe('public');
  });

  it('hands the public testnet RPC to browsers, never a private one', () => {
    expect(loadConfig({ EVM_RPC_URL: 'https://rpc.testnet.chain.robinhood.com' } as NodeJS.ProcessEnv).chain.publicRpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
    expect(loadConfig({ EVM_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com/' } as NodeJS.ProcessEnv).chain.publicRpcUrl).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(loadConfig({ EVM_RPC_URL: 'https://paid.example/secret' } as NodeJS.ProcessEnv).chain.publicRpcUrl).toBeNull();
  });

  it('ADMIN_WALLETS: 0x addresses, checksummed and de-duplicated, no default', () => {
    expect(parseAdminWallets(undefined)).toEqual([]);
    expect(parseAdminWallets('')).toEqual([]);
    expect(parseAdminWallets('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266,nope,D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm')).toEqual([
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    ]);
    expect(invalidAdminWallets('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266,nope')).toEqual(['nope']);
    expect(loadConfig({} as NodeJS.ProcessEnv).adminWallets).toEqual([]);
  });
});

describe('sweeper tunables', () => {
  it('default to 15 min and read STALE_SESSION_AFTER_S / STALE_SWEEP_ACK', () => {
    expect(loadConfig({}).chain).toMatchObject({ staleSessionAfterS: 900, staleSweepAck: false });
    expect(loadConfig({ STALE_SESSION_AFTER_S: '5', STALE_SWEEP_ACK: '1' }).chain).toMatchObject({ staleSessionAfterS: 5, staleSweepAck: true });
    expect(loadConfig({ STALE_SESSION_AFTER_S: '0' }).chain).toMatchObject({ staleSessionAfterS: 1 });
  });
});

describe('round clock config', () => {
  it('defaults to 5 minutes of play with joins closed in the last minute, and a 30 s break on top', () => {
    expect(loadConfig({}).round).toEqual({ roundMs: 300_000, closeMs: 60_000, breakMs: 30_000 });
    expect(parseRoundConfig({ ROUND_SECONDS: '', ROUND_JOIN_CLOSE_SECONDS: ' ' })).toEqual({ roundMs: 300_000, closeMs: 60_000, breakMs: 30_000 });
  });

  it('reads ROUND_SECONDS / ROUND_JOIN_CLOSE_SECONDS (tests, localnet e2e)', () => {
    expect(loadConfig({ ROUND_SECONDS: '30', ROUND_JOIN_CLOSE_SECONDS: '5' }).round).toEqual({ roundMs: 30_000, closeMs: 5_000, breakMs: 3_000 });
    expect(parseRoundConfig({ ROUND_SECONDS: '600', ROUND_JOIN_CLOSE_SECONDS: '0', ROUND_BREAK_SECONDS: '0' })).toEqual({ roundMs: 600_000, closeMs: 0, breakMs: 0 });
    expect(parseRoundConfig({ ROUND_BREAK_SECONDS: '20' })).toMatchObject({ breakMs: 20_000 });
  });

  it('keeps joins open for at least half a round and rounds of at least 2 s', () => {
    // a 30 s round with the default 60 s closed window would never open: capped at half the round
    expect(parseRoundConfig({ ROUND_SECONDS: '30' })).toEqual({ roundMs: 30_000, closeMs: 15_000, breakMs: 3_000 });
    expect(parseRoundConfig({ ROUND_SECONDS: '0', ROUND_JOIN_CLOSE_SECONDS: '-4' })).toEqual({ roundMs: 2_000, closeMs: 0, breakMs: 0 });
    expect(parseRoundConfig({ ROUND_SECONDS: 'soon' })).toEqual({ roundMs: 300_000, closeMs: 60_000, breakMs: 30_000 });
  });

  it('the break comes on top of the play: an explicit one is kept up to the play length, the default is at most a tenth', () => {
    expect(parseRoundConfig({ ROUND_BREAK_SECONDS: '60' })).toEqual({ roundMs: 300_000, closeMs: 60_000, breakMs: 60_000 });
    expect(parseRoundConfig({ ROUND_SECONDS: '30', ROUND_BREAK_SECONDS: '10' })).toMatchObject({ breakMs: 10_000 });
    expect(parseRoundConfig({ ROUND_SECONDS: '30', ROUND_BREAK_SECONDS: '90' })).toMatchObject({ breakMs: 30_000 });
    expect(parseRoundConfig({ ROUND_SECONDS: '90' })).toMatchObject({ breakMs: 9_000 });
    expect(parseRoundConfig({ ROUND_BREAK_SECONDS: '-3' })).toMatchObject({ breakMs: 0 });
    expect(parseRoundConfig({ ROUND_BREAK_SECONDS: 'x' })).toMatchObject({ breakMs: 30_000 });
    expect(parseRoundConfig({ ROUND_BREAK_SECONDS: '12.7' })).toMatchObject({ breakMs: 12_000 });
  });
});

describe('auth secret without AUTH_SECRET', () => {
  it('is generated once into DATA_DIR/auth-secret (0600) and reused after a restart', async () => {
    const { mkdtempSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { persistedAuthSecret } = await import('../src/config');
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-secret-'));
    const a = persistedAuthSecret(dir);
    const b = persistedAuthSecret(dir);
    expect(a.equals(b)).toBe(true);
    expect(a.toString('utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'auth-secret')).mode & 0o777).toBe(0o600);
  });
});
