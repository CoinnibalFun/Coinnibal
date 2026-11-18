import { describe, expect, it } from 'vitest';
import { RpcBudget, bodyRateLimited, configureRpcBudgetFor, formatRpcMinute, isRateLimited, methodsOf, retryAfterMs, withRpcPriority } from '../src/chain/rpc-budget';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient } from 'viem';
import { budgetTransport } from '../src/chain/evm-client';
import { loadConfig, parseRpcRates, parseRpcUrls } from '../src/config';

const body = (method: string | string[]) =>
  JSON.stringify(Array.isArray(method) ? method.map((m, i) => ({ jsonrpc: '2.0', id: i, method: m, params: [] })) : { jsonrpc: '2.0', id: 1, method, params: [] });
const ok = (result: unknown = '0x1') => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
const http429 = (retryAfter?: string) =>
  new Response('Rate Limit Exceeded. Please get an api key', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
const json429 = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Rate Limit Exceeded. Please get an api key' } }), { status: 200 });

describe('rpc budget', () => {
  it('recognises the public RPC rate limit in every shape it comes in', () => {
    expect(isRateLimited(Object.assign(new Error('HTTP request failed.'), { status: 429 }))).toBe(true);
    expect(isRateLimited(new Error('RPC Request failed.', { cause: { code: 429, message: 'Rate Limit Exceeded. Please get an api key' } }))).toBe(true);
    expect(isRateLimited({ code: -32005, message: 'limit exceeded' })).toBe(true);
    expect(isRateLimited(new Error('execution reverted: NotServer'))).toBe(false);
    expect(bodyRateLimited(JSON.stringify([{ id: 1, result: '0x' }, { id: 2, error: { code: 429, message: 'x' } }]))).toBe(true);
    expect(bodyRateLimited(JSON.stringify({ id: 1, error: { code: 3, message: 'execution reverted' } }))).toBe(false);
    expect(bodyRateLimited(JSON.stringify({ id: 1, result: '0xerror' }))).toBe(false);
    expect(methodsOf(body(['eth_call', 'eth_blockNumber']))).toEqual(['eth_call', 'eth_blockNumber']);
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs(null)).toBeNull();
  });

  it('retries a 429 after the backoff (Retry-After respected), counts calls and 429s per method', async () => {
    const budget = new RpcBudget({ ratePerSec: 1000, burst: 10, backoffBaseMs: 5, backoffMaxMs: 20 });
    const answers = [http429('0.03'), json429(), ok('0x2a')];
    const sent: number[] = [];
    const fetchFn = budget.fetchFn(async () => {
      sent.push(Date.now());
      return answers.shift()!;
    });
    const t0 = Date.now();
    const res = await fetchFn('http://rpc', { method: 'POST', body: body('eth_blockNumber') });
    expect(await res.json()).toMatchObject({ result: '0x2a' });
    expect(sent).toHaveLength(3);
    // Retry-After: 0.03 s held the second attempt back
    expect(sent[1] - t0).toBeGreaterThanOrEqual(25);
    const m = budget.takeMinute();
    expect(m).toMatchObject({ calls: 3, limited: 2, byMethod: { eth_blockNumber: 3 } });
    expect(formatRpcMinute(m)).toMatch(/^rpc: 3 calls\/min, 2 429s · eth_blockNumber 3/);
    // the rate was cut by the 429s and climbs back on success
    expect(budget.currentRate).toBeLessThan(1000);
  });

  it('gives up after the attempts of its priority and hands the 429 to viem (low priority gives up first)', async () => {
    const budget = new RpcBudget({ ratePerSec: 1000, burst: 10, backoffBaseMs: 1, backoffMaxMs: 2, attempts: { high: 4, normal: 3, low: 2 } });
    let n = 0;
    const fetchFn = budget.fetchFn(async () => {
      n++;
      return http429();
    });
    const res = await withRpcPriority('low', () => fetchFn('http://rpc', { method: 'POST', body: body('eth_getLogs') }));
    expect(res.status).toBe(429);
    expect(n).toBe(2);
    n = 0;
    await withRpcPriority('high', () => fetchFn('http://rpc', { method: 'POST', body: body('eth_call') }));
    expect(n).toBe(4);
  });

  it('keeps to the rate: a burst, then one call per 1/rate seconds', async () => {
    const budget = new RpcBudget({ ratePerSec: 50, burst: 2 });
    const at: number[] = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => budget.acquire(1, 'high').then(() => at.push(Date.now() - t0))));
    // 2 at once, then 4 more at 50/s: at least ~80 ms in all
    expect(at[1]).toBeLessThan(15);
    expect(at[5]).toBeGreaterThanOrEqual(70);
  });

  it('serves high priority first and keeps a reserve low priority cannot touch', async () => {
    const budget = new RpcBudget({ ratePerSec: 20, burst: 5 });
    const order: string[] = [];
    // drain the bucket
    for (let i = 0; i < 5; i++) await budget.acquire(1, 'high');
    const jobs = [
      ...Array.from({ length: 3 }, (_, i) => budget.acquire(1, 'low').then(() => order.push(`low${i}`))),
      budget.acquire(1, 'normal').then(() => order.push('normal')),
      budget.acquire(1, 'high').then(() => order.push('high')),
    ];
    await Promise.all(jobs);
    expect(order[0]).toBe('high');
    expect(order[1]).toBe('normal');
    expect(order.slice(2)).toEqual(['low0', 'low1', 'low2']);
  });

  it('a 429 holds every request for the cool-down (no hammering)', async () => {
    const budget = new RpcBudget({ ratePerSec: 1000, burst: 10, backoffBaseMs: 40, backoffMaxMs: 40, random: () => 1 });
    budget.noteRateLimited();
    const t0 = Date.now();
    await budget.acquire(1, 'high');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });
});

describe('several RPCs (EVM_RPC_URLS)', () => {
  /** A JSON-RPC server answering eth_chainId, or 429 / dropping the connection when `mode` says so. */
  const rpcServer = async (mode: { v: 'ok' | '429' | 'down' }, chainId = 46630) => {
    const seen = { calls: 0 };
    const server = createServer((req, res) => {
      seen.calls++;
      if (mode.v === 'down') return req.socket.destroy();
      if (mode.v === '429') {
        res.writeHead(429, { 'content-type': 'text/plain' });
        return res.end('Rate Limit Exceeded');
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const j = JSON.parse(raw) as { id: number } | { id: number }[];
        const one = (x: { id: number }) => ({ jsonrpc: '2.0', id: x.id, result: `0x${chainId.toString(16)}` });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
    return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
  };

  it('reads EVM_RPC_URLS in order (EVM_RPC_URL still works) and RPC_MAX_RPS per URL', () => {
    expect(parseRpcUrls('https://a.example/v2/k/, https://b.example ,https://a.example/v2/k', undefined)).toEqual(['https://a.example/v2/k', 'https://b.example']);
    expect(parseRpcUrls(undefined, 'https://only.example/')).toEqual(['https://only.example']);
    expect(parseRpcUrls('', '')).toEqual([]);
    expect(parseRpcRates('25,4', 2)).toEqual([25, 4]);
    expect(parseRpcRates('10', 3)).toEqual([10, 10, 10]);
    expect(parseRpcRates(undefined, 2)).toEqual([4, 4]);
    const cfg = loadConfig({ EVM_RPC_URLS: 'https://robinhood-mainnet.g.alchemy.com/v2/KEY,https://rpc.testnet.chain.robinhood.com', RPC_MAX_RPS: '25,4' } as NodeJS.ProcessEnv);
    expect(cfg.chain.rpcUrl).toBe('https://robinhood-mainnet.g.alchemy.com/v2/KEY');
    expect(cfg.chain.rpcMaxRpsPerUrl).toEqual([25, 4]);
    // the browser gets the public one, never the provider URL with its key
    expect(cfg.chain.publicRpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
  });

  it('the VPS compose environment: an empty EVM_RPC_URL is unset, EVM_RPC_URLS and CHAIN_ID win over stale values', () => {
    // deploy/vps/docker-compose.yml sets EVM_RPC_URL: "" and EVM_RPC_URLS / CHAIN_ID / GAME_ACCESS from COINNIBAL_* keys
    // (a stale CHAIN_ID or EVM_RPC_URL of /opt/elymum/.env, the install directory kept from before the rename, never
    // reaches the app)
    const cfg = loadConfig({
      EVM_RPC_URL: '',
      EVM_RPC_URLS: 'https://rpc.testnet.chain.robinhood.com',
      CHAIN_ID: '46630',
      RPC_MAX_RPS: '4',
      GAME_ACCESS: 'public',
      PUBLIC_RPC_URL: '',
    } as NodeJS.ProcessEnv);
    expect(cfg.chain.rpcUrls).toEqual(['https://rpc.testnet.chain.robinhood.com']);
    expect(cfg.chain.rpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
    expect(cfg.chain.chainId).toBe(46630);
    expect(cfg.chain.rpcMaxRpsPerUrl).toEqual([4]);
    expect(cfg.gameAccess).toBe('public');
    expect(cfg.chain.publicRpcUrl).toBe('https://rpc.testnet.chain.robinhood.com');
    // whitespace only is unset as well; an empty list falls back to EVM_RPC_URL, both empty: practice only
    expect(parseRpcUrls('  ', 'https://rpc.testnet.chain.robinhood.com')).toEqual(['https://rpc.testnet.chain.robinhood.com']);
    expect(loadConfig({ EVM_RPC_URL: ' ', EVM_RPC_URLS: '' } as NodeJS.ProcessEnv).chain.rpcUrl).toBeNull();
  });

  it('a provider that answers 429 or is down hands the call to the next URL; it is tried first again afterwards', async () => {
    const a = { v: 'ok' as 'ok' | '429' | 'down' };
    const primary = await rpcServer(a);
    const backup = await rpcServer({ v: 'ok' });
    try {
      configureRpcBudgetFor(primary.url, { ratePerSec: 1000, burst: 1000, backoffBaseMs: 5, backoffMaxMs: 10 });
      configureRpcBudgetFor(backup.url, { ratePerSec: 1000, burst: 1000 });
      const client = createPublicClient({ transport: budgetTransport([primary.url, backup.url]) });
      expect(await client.getChainId()).toBe(46630);
      expect(backup.seen.calls).toBe(0);
      a.v = '429';
      expect(await withRpcPriority('high', () => createPublicClient({ transport: budgetTransport([primary.url, backup.url]) }).getChainId())).toBe(46630);
      expect(backup.seen.calls).toBe(1);
      a.v = 'down';
      expect(await createPublicClient({ transport: budgetTransport([primary.url, backup.url]) }).getChainId()).toBe(46630);
      expect(backup.seen.calls).toBe(2);
      a.v = 'ok';
      const before = primary.seen.calls;
      expect(await createPublicClient({ transport: budgetTransport([primary.url, backup.url]) }).getChainId()).toBe(46630);
      expect(primary.seen.calls).toBe(before + 1);
      expect(backup.seen.calls).toBe(2);
    } finally {
      await primary.close();
      await backup.close();
    }
  });
});
