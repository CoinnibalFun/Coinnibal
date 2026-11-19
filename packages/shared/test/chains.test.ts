import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAIN_ID,
  GAS_SYMBOL,
  LOCALNET_CHAIN_ID,
  NETWORKS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  activeChain,
  addEthereumChainParams,
  chainInfo,
  configuredChainId,
  explorerAddressUrl,
  explorerTxUrl,
  isSupportedChainId,
  isTestChainId,
  networkOf,
  toHexChainId,
} from '../src';

const RH_TESTNET_EXPLORER = 'https://explorer.testnet.chain.robinhood.com';

describe('Robinhood Chain networks', () => {
  it('are the testnet and the mainnet (and the local development node), gas in ETH', () => {
    expect(Object.values(NETWORKS).map((n) => [n.key, n.id])).toEqual([
      ['testnet', 46630],
      ['mainnet', 4663],
      ['localnet', 31337],
    ]);
    expect(GAS_SYMBOL).toBe('ETH');
  });

  it('have the values of docs.robinhood.com', () => {
    expect(NETWORKS.testnet).toMatchObject({ id: ROBINHOOD_TESTNET_CHAIN_ID, rpcUrl: 'https://rpc.testnet.chain.robinhood.com', explorerUrl: RH_TESTNET_EXPLORER, testnet: true });
    expect(NETWORKS.mainnet).toMatchObject({ id: ROBINHOOD_CHAIN_ID, rpcUrl: 'https://rpc.mainnet.chain.robinhood.com', explorerUrl: 'https://robinhoodchain.blockscout.com', testnet: false, faucetUrl: null });
  });

  it('default to the testnet; CHAIN_ID picks only a Robinhood Chain network', () => {
    expect(DEFAULT_CHAIN_ID).toBe(ROBINHOOD_TESTNET_CHAIN_ID);
    expect(activeChain().id).toBe(ROBINHOOD_TESTNET_CHAIN_ID);
    expect(configuredChainId(undefined)).toBe(46630);
    expect(configuredChainId('')).toBe(46630);
    expect(configuredChainId(' 4663 ')).toBe(4663);
    expect(configuredChainId(31337)).toBe(31337);
    expect(configuredChainId('not a number')).toBe(46630);
    // any other chain is not an option
    expect(configuredChainId('99801')).toBe(46630);
    expect(configuredChainId('1', -1)).toBe(-1);
  });

  it('know the testnets; every other chain is unsupported', () => {
    expect(isTestChainId(ROBINHOOD_TESTNET_CHAIN_ID)).toBe(true);
    expect(isTestChainId(LOCALNET_CHAIN_ID)).toBe(true);
    expect(isTestChainId(ROBINHOOD_CHAIN_ID)).toBe(false);
    expect(isTestChainId(99801)).toBe(false);
    expect(isTestChainId(null)).toBe(false);
    expect(networkOf(1)).toBeNull();
    expect(isSupportedChainId(4663)).toBe(true);
    expect(isSupportedChainId(99801)).toBe(false);
    expect(isSupportedChainId('46630')).toBe(false);
  });
});

describe('chainInfo', () => {
  it('resolves the networks', () => {
    expect(chainInfo(46630)).toMatchObject({
      key: 'testnet',
      id: 46630,
      name: 'Robinhood Chain Testnet',
      rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
      explorerUrl: RH_TESTNET_EXPLORER,
      faucetUrl: 'https://faucet.testnet.chain.robinhood.com',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      testnet: true,
    });
    expect(chainInfo(4663)).toMatchObject({ key: 'mainnet', name: 'Robinhood Chain', testnet: false, faucetUrl: null });
    expect(chainInfo(31337)).toMatchObject({ key: 'localnet', name: 'Localnet', explorerUrl: null, testnet: true });
  });

  it('refuses any other chain, saying Coinnibal runs on Robinhood Chain only', () => {
    for (const bad of [1, 99801, 555, 0, -1, 1.5, Number.NaN, 2 ** 60]) expect(() => chainInfo(bad), String(bad)).toThrow(/Robinhood Chain/);
  });

  it('applies the server overrides; null clears, undefined keeps', () => {
    expect(chainInfo(46630, { rpcUrl: null }).rpcUrl).toBeNull();
    expect(chainInfo(46630, { rpcUrl: undefined }).rpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
    expect(chainInfo(46630, { rpcUrl: 'https://rh.example/v2/key/' }).rpcUrl).toBe('https://rh.example/v2/key');
    expect(chainInfo(46630, { faucetUrl: 'https://f.example' }).faucetUrl).toBe('https://f.example');
    expect(chainInfo(31337, { explorerUrl: 'http://localhost:4000' }).explorerUrl).toBe('http://localhost:4000');
  });

  it('builds wallet parameters', () => {
    expect(toHexChainId(46630)).toBe('0xb626');
    expect(toHexChainId(4663)).toBe('0x1237');
    expect(toHexChainId(31337)).toBe('0x7a69');
    expect(addEthereumChainParams(chainInfo(46630))).toEqual({
      chainId: '0xb626',
      chainName: 'Robinhood Chain Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
      blockExplorerUrls: [RH_TESTNET_EXPLORER],
    });
    expect(addEthereumChainParams(chainInfo(31337))).not.toHaveProperty('blockExplorerUrls');
    expect(addEthereumChainParams(chainInfo(46630, { rpcUrl: null }))).toBeNull();
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
