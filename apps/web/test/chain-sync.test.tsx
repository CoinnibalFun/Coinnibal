import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../src/store';
import { readChain, useChainData, useChainSync } from '../src/wallet/chain';
import { DEV_FAKE_ARENA_ADDRESS } from '../src/wallet/devFakeLoader';
import { resetWallets, useWallet } from '../src/wallet/store';
import { ALICE, BOB, ONE, chainStatus, detail, fakeProvider } from './evm-helpers';

// the pin and code-hash check (pinned.test.ts tests it): the arena of these tests passes unless a test says otherwise
const pin = vi.hoisted(() => ({ verifyArena: vi.fn() }));
vi.mock('../src/wallet/pinned', async (orig) => ({ ...(await orig<typeof import('../src/wallet/pinned')>()), verifyArena: pin.verifyArena }));
beforeEach(() => {
  pin.verifyArena.mockReset();
  pin.verifyArena.mockImplementation(async (_c: unknown, _id: unknown, a: { arena: string }) => ({ ok: true, arena: a.arena }));
});

const ui0 = useUi.getState();
const chain0 = useChainData.getState();
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => {
    useUi.setState(ui0, true);
    useChainData.setState(chain0, true);
    resetWallets();
  });
});

function Sync() {
  useChainSync();
  return null;
}
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const connect = (address: `0x${string}`) => useWallet.setState({ status: 'connected', address, chainId: 46630, current: detail(fakeProvider({ accounts: [address] })) });

describe('useChainSync', () => {
  it("a slow refresh for wallet A that resolves after switching to wallet B does not change B's state", async () => {
    let releaseA: () => void = () => {};
    const slowA = new Promise<void>((r) => (releaseA = r));
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/pending?wallet=${ALICE}`)) return slowA.then(() => json({ pending: [{ key: 'SessionOfA', arenaId: 1, payout: 1 }] }));
      if (url.includes('/api/pending')) return json({ pending: [{ key: 'SessionOfB', arenaId: 2, payout: 2 }] });
      return json({});
    }) as typeof fetch;
    act(() => useUi.setState({ chain: chainStatus({ arenaAddress: DEV_FAKE_ARENA_ADDRESS }) }));
    act(() => {
      useUi.setState({ auth: { address: ALICE, token: 'tokA', profile: null } });
      connect(ALICE);
    });
    const view = render(<Sync />);
    await flush();
    act(() => {
      useUi.setState({ auth: { address: BOB, token: 'tokB', profile: null } });
      connect(BOB);
    });
    await flush();
    expect(useChainData.getState().pending.map((p) => p.key)).toEqual(['SessionOfB']);
    // A's reads finally land
    releaseA();
    await flush();
    expect(useChainData.getState().pending.map((p) => p.key)).toEqual(['SessionOfB']);
    expect(useChainData.getState().fake).toBe(true);
    view.unmount();
  });

  it('loads the server profile with the session token of the connected wallet', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ''}`);
      if (url.endsWith('/api/profile')) return json({ profile: { wallet: ALICE, name: 'Daphne', skin: 4, stats: { games: 3, kills: 1, best: 900 }, updatedAt: 1 } });
      return json({ pending: [] });
    }) as typeof fetch;
    act(() => {
      useUi.setState({ chain: chainStatus({ arenaAddress: DEV_FAKE_ARENA_ADDRESS }), auth: { address: ALICE, token: 'tok', profile: null } });
      connect(ALICE);
    });
    const view = render(<Sync />);
    await flush();
    expect(seen.some((s) => s.endsWith('/api/profile Bearer tok'))).toBe(true);
    expect(useChainData.getState().profile?.name).toBe('Daphne');
    view.unmount();
  });
});

describe('pending payouts (/api/pending needs the wallet\'s session)', () => {
  it("sends the connected wallet's bearer token", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${url} ${(init?.headers as Record<string, string> | undefined)?.Authorization ?? ''}`);
      if (url.includes('/api/pending')) return json({ pending: [{ key: 'Mine', arenaId: 1, payout: 5 }] });
      return json({});
    }) as typeof fetch;
    act(() => {
      useUi.setState({ chain: chainStatus({ arenaAddress: DEV_FAKE_ARENA_ADDRESS }), auth: { address: ALICE, token: 'tokA', profile: null } });
      connect(ALICE);
    });
    const view = render(<Sync />);
    await flush();
    expect(seen.some((s) => s.includes(`/api/pending?wallet=${ALICE}`) && s.endsWith('Bearer tokA'))).toBe(true);
    expect(useChainData.getState().pending.map((p) => p.key)).toEqual(['Mine']);
    view.unmount();
  });

  it('signed out (or signed in as another wallet): no request, no error, nothing pending', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      seen.push(String(input));
      return json({});
    }) as typeof fetch;
    act(() => {
      useUi.setState({ chain: chainStatus({ arenaAddress: DEV_FAKE_ARENA_ADDRESS }), auth: { address: BOB, token: 'tokB', profile: null } });
      connect(ALICE);
    });
    const view = render(<Sync />);
    await flush();
    expect(seen.some((u) => u.includes('/api/pending'))).toBe(false);
    expect(useChainData.getState().pending).toEqual([]);
    view.unmount();
  });

  it('a refused token (401) shows nothing rather than an error', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/api/pending') ? Promise.resolve(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) : json({}),
    ) as typeof fetch;
    act(() => {
      useUi.setState({ chain: chainStatus({ arenaAddress: DEV_FAKE_ARENA_ADDRESS }), auth: { address: ALICE, token: 'expired', profile: null } });
      connect(ALICE);
    });
    const view = render(<Sync />);
    await flush();
    expect(useChainData.getState().pending).toEqual([]);
    expect(useChainData.getState().rpcDown).toBe(false);
    view.unmount();
  });
});

describe('readChain', () => {
  const ARENA = '0x00000000000000000000000000000000000a4e4a';
  const TOKEN = '0x0000000000000000000000000000000000007e57';
  const cfg = {
    admin: ALICE,
    pendingAdmin: '0x0000000000000000000000000000000000000000',
    serverAuthority: BOB,
    feeWallet: ALICE,
    token: TOKEN,
    decimals: 18,
    burnBps: 1500,
    vaultBps: 500,
    paused: false,
    holderNft: '0x0000000000000000000000000000000000000000',
    holderBurnBps: 1500,
    holderVaultBps: 500,
    burnMode: 0,
    paymentBurnBps: 5000,
    totalSessions: 0n,
    totalGames: 0n,
    totalStaked: 0n,
    totalPaidOut: 0n,
    totalFeeBurned: 0n,
    totalFeeToVault: 0n,
    totalLootBurned: 0n,
    totalPayments: 0n,
    totalPaymentBurned: 0n,
  };
  const arena = (id: number, entryFee: bigint) => ({ id, entryFee, vault: 0n, owed: 0n, maxSessions: 300, openSessions: 0, enabled: true, exists: true, totalDeposited: 0n, totalPaidOut: 0n, totalBurned: 0n, totalFees: 0n, lastSweepId: 0n });
  const client = (over: Record<string, unknown> = {}) =>
    ({
      getBalance: async () => 5n * 10n ** 17n,
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName in over) return over[functionName];
        switch (functionName) {
          case 'config':
            return cfg;
          case 'arenaIds':
            return [2, 1];
          case 'getArena':
            return args![0] === 1 ? arena(1, 1000n * ONE) : arena(2, 10_000n * ONE);
          case 'getSession':
            return args![0] === 1 ? { id: 4n, entryFee: 1000n * ONE, openedAt: 10n, burnBps: 1500, vaultBps: 500, finalized: true, owed: 3n * ONE } : { id: 0n, entryFee: 0n, openedAt: 0n, burnBps: 0, vaultBps: 0, finalized: false, owed: 0n };
          case 'balanceOf':
            return 12_450n * ONE;
          case 'allowance':
            return 1000n * ONE;
          default:
            throw new Error(functionName);
        }
      },
    }) as never;

  it('reads config, arenas (sorted by price), my sessions, balances and the allowance', async () => {
    const d = await readChain(client(), chainStatus({ arenaAddress: ARENA }), ALICE);
    expect(d.deployed).toBe(true);
    expect(d.arenas.map((a) => a.id)).toEqual([1, 2]);
    expect(d.sessions[1]).toMatchObject({ id: 4n, finalized: true, owed: 3n * ONE, player: ALICE });
    expect(d.sessions[2]).toBeNull();
    expect(d).toMatchObject({ balance: 5n * 10n ** 17n, tokenBalance: 12_450n * ONE, allowance: 1000n * ONE });
  });

  it('no token yet: no arenas or token reads; no contract: not deployed', async () => {
    const d = await readChain(client({ config: { ...cfg, token: '0x0000000000000000000000000000000000000000' } }), chainStatus({ arenaAddress: ARENA }), ALICE);
    expect(d).toMatchObject({ deployed: true, arenas: [], tokenBalance: null, allowance: null });
    const broken = { readContract: async () => Promise.reject(new Error('no code')), getBlockNumber: async () => 7n } as never;
    expect(await readChain(broken, chainStatus({ arenaAddress: ARENA }), ALICE)).toMatchObject({ deployed: false, rpcDown: false });
  });

  it('an RPC that does not answer at all is "can\'t reach", not "no contract"', async () => {
    const down = { readContract: async () => Promise.reject(new Error('fetch failed')), getBlockNumber: async () => Promise.reject(new Error('fetch failed')) } as never;
    expect(await readChain(down, chainStatus({ arenaAddress: ARENA }), ALICE)).toMatchObject({ deployed: false, rpcDown: true, arenas: [] });
  });

  it('an arena that is not the pinned one (or not the compiled code) is not used: nothing is read or sold', async () => {
    pin.verifyArena.mockImplementation(async () => ({ ok: false, reason: 'code_mismatch' }));
    // (another address than the tests above: an arena that passed once is not checked again this visit)
    const OTHER = '0x0000000000000000000000000000000000000b0b';
    const d = await readChain(client(), chainStatus({ arenaAddress: OTHER }), ALICE);
    expect(d).toMatchObject({ deployed: false, pin: { ok: false, reason: 'code_mismatch' }, arenas: [], tokenBalance: null, allowance: null, rpcDown: false });
    // the token the arena names is checked against the pin too
    expect(pin.verifyArena).toHaveBeenCalledWith(expect.anything(), chainStatus().chainId, { arena: OTHER, token: TOKEN });
  });
});
