import { describe, expect, it } from 'vitest';
import { createElymumPublicClient, createElymumWalletClient, getCodeHash, isMainnetChain, resolveChain, toTransport, viemChain } from '../src/chain';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256 } from 'viem';

describe('chain', () => {
  it('builds viem chains from the shared registry', () => {
    const t = viemChain(46630);
    expect(t.id).toBe(46630);
    expect(t.name).toBe('Robinhood Chain Testnet');
    expect(t.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    expect(t.rpcUrls.default.http).toEqual(['https://rpc.testnet.chain.robinhood.com']);
    expect(t.blockExplorers?.default.url).toBe('https://explorer.testnet.chain.robinhood.com');
    expect(t.testnet).toBe(true);
    expect(viemChain(99801).nativeCurrency.symbol).toBe('HYPE');
    const m = viemChain(4242, { name: 'Other L2', rpcUrl: 'https://rpc.example', explorerUrl: 'https://scan.example/' });
    expect(m.name).toBe('Other L2');
    expect(m.testnet).toBe(false);
    expect(m.blockExplorers?.default.url).toBe('https://scan.example');
    expect(isMainnetChain(4242)).toBe(true);
    expect(isMainnetChain(4663)).toBe(true);
    expect(isMainnetChain(46630)).toBe(false);
    expect(isMainnetChain(31337)).toBe(false);
    expect(viemChain(31337).blockExplorers).toBeUndefined();
  });

  it('accepts an RPC URL or an EIP-1193 provider', async () => {
    expect(() => toTransport('ws://x')).toThrow(TypeError);
    expect(() => toTransport({} as never)).toThrow(TypeError);
    const provider = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x185d9';
        if (method === 'eth_getCode') return '0x6001';
        throw new Error(method);
      },
    };
    const client = createElymumPublicClient(provider);
    expect(await client.getChainId()).toBe(99801);
    expect((await resolveChain(client)).name).toBe('Elysium Testnet');
    expect(await getCodeHash(client, '0x5FbDB2315678afecb367f032d93F642f64180aa3')).toBe(keccak256('0x6001'));
    const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const wallet = createElymumWalletClient('http://127.0.0.1:1', { account, chain: viemChain(31337) });
    expect(wallet.account?.address).toBe(account.address);
  });
});
