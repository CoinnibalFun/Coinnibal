import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  DEFAULT_CHAIN_ID,
  ELYSIUM_TESTNET_CHAIN_ID,
  LOCALNET_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  addEthereumChainParams,
  chainById,
  chainByKey,
  chainInfo,
  configuredChainId,
  explorerAddressUrl,
  explorerTxUrl,
  isTestChainId,
  toHexChainId,
} from '../src';

const RH_TESTNET_EXPLORER = 'https://explorer.testnet.chain.robinhood.com';

describe('chain registry', () => {
  it('lists the chains Elymum can run on, with unique ids and keys', () => {
    expect(CHAINS.map((c) => [c.key, c.id])).toEqual([
      ['robinhood-testnet', 46630],
      ['robinhood', 4663],
      ['elysium-testnet', 99801],
      ['localnet', 31337],
    ]);
    expect(new Set(CHAINS.map((c) => c.id)).size).toBe(CHAINS.length);
    expect(new Set(CHAINS.map((c) => c.key)).size).toBe(CHAINS.length);
  });

  it('has the Robinhood Chain values of docs.robinhood.com', () => {
    const t = chainByKey('robinhood-testnet');
    expect(t).toMatchObject({ id: ROBINHOOD_TESTNET_CHAIN_ID, rpcUrl: 'https://rpc.testnet.chain.robinhood.com', explorerUrl: RH_TESTNET_EXPLORER, testnet: true });
    expect(t.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    const m = chainByKey('robinhood');
    expect(m).toMatchObject({ id: ROBINHOOD_CHAIN_ID, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', explorerUrl: 'https://robinhoodchain.blockscout.com', testnet: false, faucetUrl: null });
    expect(chainByKey('elysium-testnet').nativeCurrency.symbol).toBe('HYPE');
  });

  it('defaults to Robinhood Chain Testnet', () => {
    expect(DEFAULT_CHAIN_ID).toBe(ROBINHOOD_TESTNET_CHAIN_ID);
    expect(configuredChainId(undefined)).toBe(46630);
    expect(configuredChainId('')).toBe(46630);
    expect(configuredChainId(' 99801 ')).toBe(99801);
    expect(configuredChainId('not a number')).toBe(46630);
    expect(configuredChainId('-5', 31337)).toBe(31337);
    expect(configuredChainId(4663)).toBe(4663);
  });

  it('knows testnets; an unknown id counts as mainnet', () => {
    expect(isTestChainId(ELYSIUM_TESTNET_CHAIN_ID)).toBe(true);
    expect(isTestChainId(ROBINHOOD_TESTNET_CHAIN_ID)).toBe(true);
    expect(isTestChainId(LOCALNET_CHAIN_ID)).toBe(true);
    expect(isTestChainId(ROBINHOOD_CHAIN_ID)).toBe(false);
    expect(isTestChainId(424242)).toBe(false);
    expect(isTestChainId(null)).toBe(false);
    expect(chainById(1)).toBeNull();
  });
});

describe('chainInfo', () => {
  it('resolves registry ids', () => {
    expect(chainInfo(46630)).toMatchObject({
      key: 'robinhood-testnet',
      id: 46630,
      name: 'Robinhood Chain Testnet',
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      explorerUrl: RH_TESTNET_EXPLORER,
      faucetUrl: 'https://faucet.testnet.chain.robinhood.com',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      testnet: true,
      priceCoin: 'ETH',
    });
    expect(chainInfo(31337)).toMatchObject({ key: 'localnet', name: 'Localnet', explorerUrl: null, testnet: true });
  });

  it('describes an unknown id generically; the environment names it', () => {
    expect(chainInfo(555)).toMatchObject({ key: null, id: 555, name: 'Chain 555', rpcUrl: null, explorerUrl: null, testnet: false, priceCoin: null });
    expect(chainInfo(555).nativeCurrency.symbol).toBe('ETH');
    const named = chainInfo(555, { name: 'My L2', gasSymbol: 'FOO', rpcUrl: 'https://rpc.example', explorerUrl: 'https://scan.example/' });
    expect(named).toMatchObject({ name: 'My L2', rpcUrl: 'https://rpc.example', explorerUrl: 'https://scan.example', priceCoin: 'FOO' });
    expect(named.nativeCurrency).toEqual({ name: 'FOO', symbol: 'FOO', decimals: 18 });
    expect(chainInfo(555, { name: '  ' }).name).toBe('Chain 555');
  });

  it('applies overrides; null clears, undefined keeps', () => {
    expect(chainInfo(46630, { rpcUrl: null }).rpcUrl).toBeNull();
    expect(chainInfo(46630, { rpcUrl: undefined }).rpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
    expect(chainInfo(46630, { faucetUrl: 'https://f.example' }).faucetUrl).toBe('https://f.example');
    expect(chainInfo(31337, { explorerUrl: 'http://localhost:4000' }).explorerUrl).toBe('http://localhost:4000');
  });

  it('rejects malformed ids', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) expect(() => chainInfo(bad), String(bad)).toThrow(RangeError);
  });

  it('builds wallet parameters', () => {
    expect(toHexChainId(46630)).toBe('0xb626');
    expect(toHexChainId(31337)).toBe('0x7a69');
    expect(addEthereumChainParams(chainInfo(46630))).toEqual({
      chainId: '0xb626',
      chainName: 'Robinhood Chain Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
      blockExplorerUrls: [RH_TESTNET_EXPLORER],
    });
    expect(addEthereumChainParams(chainInfo(31337))).not.toHaveProperty('blockExplorerUrls');
    expect(addEthereumChainParams(chainInfo(555))).toBeNull();
  });
});

describe('explorer links', () => {
  it('uses the Blockscout layout', () => {
    expect(explorerTxUrl(RH_TESTNET_EXPLORER, '0xabc')).toBe(`${RH_TESTNET_EXPLORER}/tx/0xabc`);
    expect(explorerAddressUrl(`${RH_TESTNET_EXPLORER}/`, '0xdef')).toBe(`${RH_TESTNET_EXPLORER}/address/0xdef`);
  });

  it('is null without an explorer', () => {
    expect(explorerTxUrl(null, '0xabc')).toBeNull();
    expect(explorerAddressUrl(undefined, '0xdef')).toBeNull();
    expect(explorerTxUrl(chainInfo(31337).explorerUrl, '0xabc')).toBeNull();
  });
});
