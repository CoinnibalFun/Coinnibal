import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { asClient, ClientBudgetError } from '../src/net/client-scope';
import { FIRST_READ_WAIT_MS, HOLDERS_INDEX_TTL_MS, HOLDERS_RETRY_MS, MINT_CACHE_FILE, MintService } from '../src/site/mint';
import { SiteStore } from '../src/site/store';
import { FakeEvm, NFT } from './fake-evm';
import { testSigner } from './signers';

function service(evm: FakeEvm, clock: { now: number }, stateDir: string | null = null, rpcMaxRps?: number) {
  const logs: string[] = [];
  const mint = new MintService({
    rpcMaxRps,
    sleep: async () => {},
    store: new SiteStore(null),
    client: () => evm,
    nft: () => ({ address: NFT, txHash: null }),
    chainId: () => 31337,
    stateDir,
    usdCents: 100,
    fetchPrice: async () => ({ price: '40.0', value: 40 }),
    logChunkBlocks: 100,
    log: (m) => logs.push(m),
    now: () => clock.now,
  });
  return { mint, logs };
}

const timed = async <T>(p: Promise<T>) => {
  const t0 = Date.now();
  const value = await p;
  return { value, ms: Date.now() - t0 };
};

describe('mint page state while the RPC is rate-limited (stale-while-revalidate)', () => {
  it('answers from the cache at once when the RPC hangs or answers 429, and refreshes in the background', async () => {
    const evm = new FakeEvm();
    evm.mintNft(testSigner().address, 3);
    const clock = { now: 1_800_000_000_000 };
    const { mint, logs } = service(evm, clock);
    expect((await mint.publicState('public')).contract?.totalSupply).toBe(3);
    // the RPC hangs now: a stale state is still answered immediately
    const realMintState = evm.mintState.bind(evm);
    evm.mintState = () => new Promise(() => {});
    clock.now += 60_000;
    const a = await timed(mint.publicState('public'));
    expect(a.ms).toBeLessThan(200);
    expect(a.value.contract?.totalSupply).toBe(3);
    // and when it answers 429, the last good state is served (logged), never null
    evm.mintState = realMintState;
    evm.limited.set('mintState', Infinity);
    (mint as unknown as { stateFetch: unknown }).stateFetch = null;
    clock.now += 60_000;
    expect((await mint.publicState('public')).contract?.totalSupply).toBe(3);
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.join('\n')).toMatch(/mintState of .* failed .* serving the last good state/);
    // the RPC is back: the background refresh picks the new supply up
    evm.limited.delete('mintState');
    evm.mintNft(testSigner().address, 2);
    clock.now += 60_000;
    await mint.publicState('public');
    await new Promise((r) => setTimeout(r, 10));
    expect((await mint.publicState('public')).contract?.totalSupply).toBe(5);
  });

  it('after a restart the persisted state and holder index answer at once, even with the RPC refusing everything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-mint-swr-'));
    const evm = new FakeEvm();
    evm.mintNft(testSigner().address, 2);
    evm.mintNft(testSigner().address, 1);
    const clock = { now: 1_800_000_000_000 };
    const first = service(evm, clock, dir);
    const s1 = await first.mint.publicState('public');
    expect(s1).toMatchObject({ holders: 2, contract: { totalSupply: 3 } });
    first.mint.flush();
    evm.limited.set('mintState', Infinity).set('transferLogs', Infinity);
    const again = service(evm, clock, dir);
    const b = await timed(again.mint.publicState('public'));
    expect(b.ms).toBeLessThan(FIRST_READ_WAIT_MS);
    expect(b.value).toMatchObject({ holders: 2, contract: { totalSupply: 3 } });
  });

  it('the holder index backs off after a rate-limited scan instead of retrying on every page view', async () => {
    const evm = new FakeEvm();
    evm.mintNft(testSigner().address, 1);
    const clock = { now: 1_800_000_000_000 };
    const { mint, logs } = service(evm, clock);
    expect(await mint.holdersCount()).toBe(1);
    evm.mintNft(testSigner().address, 1);
    evm.limited.set('transferLogs', Infinity);
    clock.now += HOLDERS_INDEX_TTL_MS;
    expect(await mint.holdersCount()).toBe(1); // answered from the index, the scan runs behind
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.filter((l) => /holder index failed/.test(l))).toHaveLength(1);
    // page views during the backoff do not touch the RPC
    for (let i = 0; i < 5; i++) {
      clock.now += 1_000;
      await mint.holdersCount();
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.filter((l) => /holder index failed/.test(l))).toHaveLength(1);
    evm.limited.delete('transferLogs');
    clock.now += HOLDERS_RETRY_MS;
    await mint.holdersCount();
    await new Promise((r) => setTimeout(r, 10));
    expect(await mint.holdersCount()).toBe(2);
  });
});

describe('emblem token owners (the Transfer index)', () => {
  it('names the token ids a wallet owns now, following transfers (fresh catches up first)', async () => {
    const evm = new FakeEvm();
    const a = testSigner().address;
    const b = testSigner().address;
    evm.mintNft(a, 2);
    const clock = { now: 1_800_000_000_000 };
    const { mint } = service(evm, clock);
    expect(await mint.emblemTokens(a, true)).toEqual(['1', '2']);
    // A passes #2 to B (one Transfer log)
    evm.block += 1n;
    evm.transfers.push({ from: getAddress(a), to: getAddress(b), tokenId: 2n, blockNumber: evm.block });
    clock.now += 5_000;
    expect(await mint.emblemTokens(b, true)).toEqual(['2']);
    expect(await mint.emblemTokens(a)).toEqual(['1']);
  });
});

describe('the holder index answers a gate decision past the bounds only when it reaches back to the NFT\'s creation (R4-NET-1)', () => {
  /** A gate decision from client `ip` past its holder reads (RPC_MAX_RPS 0.4: one client's burst is 2): true / false / busy. */
  const gate = (mint: MintService, ip: string, wallet: string) =>
    asClient(ip, () => mint.isHolder(wallet)).catch((err) => {
      expect(err).toBeInstanceOf(ClientBudgetError);
      return 'busy' as const;
    });
  const spend = async (mint: MintService, ip: string) => {
    for (let i = 0; i < 4; i++) await gate(mint, ip, testSigner().address);
  };

  it('an index that starts at a lookback (no deploy block found) never says "not a holder": busy instead', async () => {
    const evm = new FakeEvm();
    evm.block = 3_000_000n;
    (evm as unknown as { deployAt: bigint | null }).deployAt = null; // a pruned node: the NFT's first block is unknown
    const holder = testSigner().address;
    evm.mintNft(holder);
    const clock = { now: 1_800_000_000_000 };
    const { mint } = service(evm, clock, null, 0.4);
    await spend(mint, '198.51.100.7');
    // the holder minted inside the lookback: the index has it; a wallet it does not have may have minted before it
    expect(await gate(mint, '198.51.100.7', holder)).toBe(true);
    expect(await gate(mint, '198.51.100.7', testSigner().address)).toBe('busy');
  });

  it('an index kept before it knew whether it reaches the NFT\'s creation is read again from the start, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coinnibal-mint-index-'));
    const evm = new FakeEvm();
    const holder = testSigner().address;
    evm.mintNft(holder);
    const clock = { now: 1_800_000_000_000 };
    const first = service(evm, clock, dir);
    expect(await first.mint.holdersCount()).toBe(1);
    first.mint.flush();
    const file = join(dir, MINT_CACHE_FILE);
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { holders: Record<string, unknown> };
    expect(kept.holders.complete).toBe(true);
    delete kept.holders.complete;
    writeFileSync(file, JSON.stringify(kept));
    const again = service(evm, clock, dir, 0.4);
    // not taken as it is: never read yet
    expect(await again.mint.emblemTokens(holder)).toBeNull();
    // a gate decision past the bounds reads it from the NFT's first block, then answers "not a holder" for real
    await spend(again.mint, '198.51.100.8');
    expect(await gate(again.mint, '198.51.100.8', testSigner().address)).toBe(false);
    expect(await gate(again.mint, '198.51.100.8', holder)).toBe(true);
    expect(await again.mint.emblemTokens(holder)).toEqual(['1']);
  });
});
