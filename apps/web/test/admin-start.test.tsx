import type { StatusSnapshot } from '@coinnibal/sdk/ops';
import type { ContractsRegistry } from '@coinnibal/shared';
import { act, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { getAddress, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, BOB, chainStatus, detail, fakeProvider } from './evm-helpers';

const ARENA = getAddress('0x00000000000000000000000000000000000a4e4a');
const NFT = getAddress('0x0000000000000000000000000000000000000f7e');
const TOKEN = getAddress('0x0000000000000000000000000000000000007e57');
const HASH = `0x${'cd'.repeat(32)}`;

/**
 * The flow's world: the server's registry, the chain read, what Finish setup still signs, the signed pins. The
 * wallet's sends and the server's answers change it the way the real ones would.
 */
const world = vi.hoisted(() => ({
  registry: { arena: null, nft: null, token: null } as Record<string, { address: string } | null>,
  tokenSet: false,
  setupLeft: [] as string[],
  signed: null as null | { arena: string; nft: string; token: string | null },
  sends: [] as string[],
  /** Addresses (lower case) whose code is an older build, and whether code reads fail. */
  oldCode: [] as string[],
  codeReadsFail: false,
}));

vi.mock('../src/site/api', async (orig) => {
  const real = await orig<typeof import('../src/site/api')>();
  return { ...real, site: { ...real.site, contracts: async () => structuredClone(world.registry) } };
});
vi.mock('@coinnibal/sdk/ops', async (orig) => {
  const real = await orig<typeof import('@coinnibal/sdk/ops')>();
  return {
    ...real,
    checkDeployedCode: async (_c: unknown, a: string) => {
      if (world.codeReadsFail) throw new Error('rpc down');
      return world.oldCode.includes(a.toLowerCase()) ? 'mismatch' : 'ok';
    },
    fetchStatus: async (_c: unknown, w: { arena?: Address | null; nft?: Address | null; testToken?: Address | null }) =>
      ({
        block: 1n,
        chain: { id: 46630 },
        arena: w.arena ? { address: w.arena, code: 'ok', config: { admin: ALICE, serverAuthority: BOB, token: world.tokenSet ? TOKEN : null, decimals: 18, burnBps: 1500, vaultBps: 500, holderNft: null }, token: null, arenas: [], serverBalance: 1n } : null,
        nft: w.nft ? { address: w.nft, code: 'ok', state: { phaseName: 'closed', totalSupply: 0, maxSupply: 3333 } } : null,
        testToken: w.testToken ? { address: w.testToken, code: 'ok', faucet: null } : null,
      }) as unknown as StatusSnapshot,
  };
});
vi.mock('../src/admin/setup', async (orig) => {
  const real = await orig<typeof import('../src/admin/setup')>();
  return { ...real, setupSteps: () => world.setupLeft.map((label) => ({ id: label, label, call: { address: ARENA, abi: [], functionName: label, args: [] } })) };
});
vi.mock('../src/wallet/tx', async (orig) => {
  const real = await orig<typeof import('../src/wallet/tx')>();
  return {
    ...real,
    sendWithWallet: vi.fn(async (_send: unknown, opts: { onPhase?: (p: string) => void }) => {
      opts.onPhase?.('signing');
      return { ok: true, hash: HASH, receipt: { status: 'success', contractAddress: null, logs: [] } };
    }),
  };
});
vi.mock('../src/admin/secrets', async (orig) => ({ ...(await orig<typeof import('../src/admin/secrets')>()), walletProofSigner: () => async () => `0x${'ab'.repeat(65)}` }));
vi.mock('../src/wallet/pinned', async (orig) => {
  const real = await orig<typeof import('../src/wallet/pinned')>();
  return {
    ...real,
    // this build's owner is the connected wallet
    PINS: { ...real.PINS, owner: ALICE },
    signedPinsFor: async () => (world.signed ? { chainId: 46630, signedAt: '2026-11-19T10:00:00.000Z', ...world.signed } : null),
  };
});

const tx = await import('../src/wallet/tx');
const { DeployFlow, flowRefusal, staleAddresses, toRegister } = await import('../src/admin/DeployFlow');
const { deployFlowSteps, flowAsksLeft, flowContracts, nextFlowStep } = await import('../src/admin/flow');
const { startActions, startRows, StartScreen } = await import('../src/admin/Start');
const { resolveNetwork } = await import('../src/admin/net');
const { Kb } = await import('../src/design');
const { resetWallets, useWallet } = await import('../src/wallet/store');

const ui = (node: ReactElement) => render(<Kb>{node}</Kb>);
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeEach(() => {
  localStorage.clear();
  Object.assign(world, { registry: { arena: null, nft: null, token: null }, tokenSet: false, setupLeft: [], signed: null, sends: [], oldCode: [], codeReadsFail: false });
  const provider = fakeProvider({ chainId: 46630, known: [46630] });
  useWallet.setState({ status: 'connected', address: ALICE, chainId: 46630, current: detail(provider) });
});
afterEach(() => act(() => resetWallets()));

describe('the deploy flow plan', () => {
  const base = { chainId: 46630, mainnet: false, registry: null, local: {}, status: null, setup: [], pinsOk: null };

  it('testnet: test token, arena, NFT, register, game token, rooms and perks, site pins: in that order', () => {
    const steps = deployFlowSteps(base);
    expect(steps.map((s) => s.id)).toEqual(['test-token', 'arena', 'nft', 'register', 'token', 'setup', 'pins']);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(nextFlowStep(steps)?.id).toBe('test-token');
    expect(steps.find((s) => s.id === 'register')?.ask).toEqual({ kind: 'none' });
    expect(steps.find((s) => s.id === 'pins')?.ask).toEqual({ kind: 'message' });
    // three deploys, setToken, at least one setup call, one message
    expect(flowAsksLeft(steps)).toBe(6);
  });

  it('mainnet: the arena, the NFT, register, the NFT perks and the site pins; no test token, the token later', () => {
    const steps = deployFlowSteps({ ...base, chainId: 4663, mainnet: true });
    expect(steps.map((s) => s.id)).toEqual(['arena', 'nft', 'register', 'setup', 'pins']);
    expect(steps.find((s) => s.id === 'setup')?.label).toBe('Set the NFT perks');
  });

  it('picks up where it stopped: deployed here but not registered, then registered, then all done', () => {
    const local = { arena: { address: ARENA, txHash: null }, nft: { address: NFT, txHash: null }, token: { address: TOKEN, txHash: null } };
    const half = deployFlowSteps({ ...base, local });
    expect(half.filter((s) => s.done).map((s) => s.id)).toEqual(['test-token', 'arena', 'nft']);
    expect(nextFlowStep(half)?.id).toBe('register');
    expect(half.find((s) => s.id === 'arena')?.detail).toBe(ARENA);
    const registry = { arena: { address: ARENA }, nft: { address: NFT }, token: { address: TOKEN } } as unknown as ContractsRegistry;
    const status = { arena: { address: ARENA, config: { token: TOKEN } } } as unknown as StatusSnapshot;
    const all = deployFlowSteps({ ...base, registry, status, setup: [], pinsOk: true });
    expect(all.every((s) => s.done)).toBe(true);
    expect(nextFlowStep(all)).toBeNull();
    expect(flowAsksLeft(all)).toBe(0);
    // the token set later (mainnet): the pins are open again
    expect(nextFlowStep(deployFlowSteps({ ...base, registry, status, setup: [], pinsOk: false }))?.id).toBe('pins');
  });

  it('replaces a registered arena of an older version: deploys a new one, registers it in its place, reads nothing from the old one', () => {
    const OLD = '0x1F50Fe469f86eFCacDEeC25885BB519aFbAd1B9b';
    const registry = { arena: { address: OLD }, nft: { address: NFT }, token: { address: TOKEN } } as unknown as ContractsRegistry;
    // the old arena still answers reads, with its own token and setup left: none of it counts
    const status = { arena: { address: OLD, code: 'mismatch', config: { token: TOKEN } } } as unknown as StatusSnapshot;
    const stale = [OLD.toLowerCase()];
    const steps = deployFlowSteps({ ...base, registry, status, setup: [{ label: 'Old arena call' } as never], pinsOk: false, stale });
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(['test-token', 'nft']);
    expect(nextFlowStep(steps)?.id).toBe('arena');
    expect(steps.find((s) => s.id === 'arena')?.detail).toBe(`The registered one (${OLD}) is an older version: a new one replaces it.`);
    expect(steps.find((s) => s.id === 'setup')?.detail).not.toMatch(/Old arena call/);
    expect(flowContracts({ registry, local: {}, status, stale })).toEqual({ arena: null, nft: NFT, token: TOKEN });
    // without the code check (no stale list) the old arena would be taken as deployed: the bug this guards against
    expect(nextFlowStep(deployFlowSteps({ ...base, registry, status, setup: [], pinsOk: false }))?.id).not.toBe('arena');

    // deployed here, not registered yet: the new arena is used and registered over the old one; the NFT stays
    const local = { arena: { address: ARENA, txHash: null } };
    const half = deployFlowSteps({ ...base, registry, local, status: null, setup: [], pinsOk: false, stale });
    expect(half.find((s) => s.id === 'arena')?.done).toBe(true);
    expect(nextFlowStep(half)?.id).toBe('register');
    expect(toRegister({ registry, local, stale })).toEqual(['arena']);
    // a healthy registered arena is never replaced, and a stale local deploy is never registered
    expect(toRegister({ registry: { ...registry, arena: { address: ARENA } } as unknown as ContractsRegistry, local, stale: [] })).toEqual([]);
    expect(toRegister({ registry: null, local: { arena: { address: OLD as `0x${string}`, txHash: null } }, stale })).toEqual([]);
  });

  it('finds the stale arena and NFT by their code; a failed read never counts as stale', async () => {
    const OLD = '0x1F50Fe469f86eFCacDEeC25885BB519aFbAd1B9b';
    const registry = { arena: { address: OLD }, nft: { address: NFT }, token: null } as unknown as ContractsRegistry;
    world.oldCode = [OLD.toLowerCase()];
    expect(await staleAddresses({} as never, registry, { arena: { address: ARENA, txHash: null } })).toEqual([OLD.toLowerCase()]);
    world.codeReadsFail = true;
    expect(await staleAddresses({} as never, registry, {})).toEqual([]);
  });

  it('testnet: the faucet hands out the token the server knows, so a game token it does not know keeps "register" open', () => {
    // the local chain before the fix: the arena and the NFT known (ARENA_ADDRESS / NFT_ADDRESS), the token set on chain
    const registry = { arena: { address: ARENA }, nft: { address: NFT }, token: null } as unknown as ContractsRegistry;
    const status = { arena: { address: ARENA, config: { token: TOKEN } } } as unknown as StatusSnapshot;
    const steps = deployFlowSteps({ ...base, registry, status, setup: [], pinsOk: true });
    expect(steps.filter((s) => !s.done).map((s) => s.id)).toEqual(['register']);
    expect(steps.find((s) => s.id === 'register')?.detail).toMatch(/^The faucet hands out the token the server knows/);
    expect(flowAsksLeft(steps)).toBe(0);
    // registered (any letter case): all done
    const known = { ...registry, token: { address: TOKEN.toLowerCase() } } as unknown as ContractsRegistry;
    expect(nextFlowStep(deployFlowSteps({ ...base, registry: known, status, setup: [], pinsOk: true }))).toBeNull();
    // another token registered than the arena's: the faucet would hand out the wrong one
    const other = { ...registry, token: { address: ARENA } } as unknown as ContractsRegistry;
    expect(nextFlowStep(deployFlowSteps({ ...base, registry: other, status, setup: [], pinsOk: true }))?.id).toBe('register');
    // mainnet has no faucet
    expect(nextFlowStep(deployFlowSteps({ ...base, chainId: 4663, mainnet: true, registry, status, setup: [], pinsOk: true }))).toBeNull();
  });

  it('starts only from the owner wallet, signed in, on a chain the panel can sign on', () => {
    const ok = { me: ALICE, owner: ALICE, signedIn: true, blockers: [] };
    expect(flowRefusal(ok)).toBeNull();
    expect(flowRefusal({ ...ok, me: BOB })).toBe(`Deploy from the owner wallet ${ALICE.slice(0, 6)}…${ALICE.slice(-4)}. The connected wallet is ${BOB.slice(0, 6)}…${BOB.slice(-4)}.`);
    expect(flowRefusal({ ...ok, me: null })).toMatch(/^Connect the owner wallet/);
    expect(flowRefusal({ ...ok, signedIn: false })).toMatch(/^Sign in at the top right/);
    expect(flowRefusal({ ...ok, blockers: ['The game server cannot be reached.'] })).toBe('The game server cannot be reached.');
  });
});

describe('the deploy flow, run', () => {
  it('one button: every step in order, one wallet prompt each, registering as it goes, then a clear "done"', async () => {
    let made = 0;
    const addresses = [TOKEN, ARENA, NFT];
    vi.mocked(tx.sendWithWallet).mockImplementation(async (_send, opts) => {
      opts.onPhase?.('signing');
      // a deploy answers with a new contract; a call changes the chain the way the arena would
      const isDeploy = world.sends.length < 3;
      const address = isDeploy ? addresses[made++] : null;
      world.sends.push(isDeploy ? `deploy ${address}` : 'call');
      if (!isDeploy && !world.tokenSet) world.tokenSet = true;
      else if (!isDeploy) world.setupLeft.shift();
      return { ok: true, hash: HASH as never, receipt: { status: 'success', contractAddress: address, logs: [] } as never };
    });
    const registered: string[] = [];
    const saved: unknown[] = [];
    const api = {
      registerContract: vi.fn(async (b: { kind: string; address: string }) => {
        registered.push(b.kind);
        world.registry[b.kind] = { address: b.address };
        return world.registry;
      }),
      mintPrice: async () => ({ priceWei: '300000000000000', gasUsd: 3000, targetUsdCents: 100, fetchedAt: 1 }),
      savePins: vi.fn(async (r: { arena: string; nft: string; token: string | null }) => {
        saved.push(r);
        world.signed = { arena: r.arena, nft: r.nft, token: r.token };
        return r;
      }),
      mintRefresh: async () => ({ refreshed: true }),
    } as never;
    world.setupLeft = ['Create Room #1', 'NFT holders pay 10 % of profit instead of 20 %'];
    const net = resolveNetwork(chainStatus({ arenaAddress: null, nftAddress: null }));
    const onDone = vi.fn();
    ui(
      <DeployFlow
        ctx={{ net, status: null, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: ALICE, walletChainId: 46630, client: { getCode: async () => '0x6080' } as never, api, open: vi.fn(), registry: null, signed: null }}
        onDone={onDone}
      />,
    );
    await settle();
    expect([...document.querySelectorAll('[data-step]')].map((e) => e.getAttribute('data-step'))).toEqual(['test-token', 'arena', 'nft', 'register', 'token', 'setup', 'pins']);
    expect(screen.getByTestId('deploy-flow-go').textContent).toContain('Deploy the contracts');
    await act(async () => {
      screen.getByTestId('deploy-flow-go').click();
      await new Promise((r) => setTimeout(r, 300));
    });
    // 3 deploys + setToken + 2 setup calls, one prompt each, then the one message
    expect(world.sends).toEqual([`deploy ${TOKEN}`, `deploy ${ARENA}`, `deploy ${NFT}`, 'call', 'call', 'call']);
    expect(registered).toEqual(['token', 'arena', 'nft']);
    expect(saved).toEqual([expect.objectContaining({ chainId: 46630, arena: ARENA, nft: NFT, token: TOKEN, signature: `0x${'ab'.repeat(65)}` })]);
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByText('Done. The contracts are live.')).toBeTruthy();
    expect(screen.getByTestId('deploy-flow-done').textContent).toContain(ARENA.slice(0, 6));
    expect(screen.queryByTestId('deploy-flow-go')).toBeNull();
  });

  it('the live case: an older arena registered, the NFT and test token current: one run deploys only a new arena and signs for it', async () => {
    const OLD = getAddress('0x1F50Fe469f86eFCacDEeC25885BB519aFbAd1B9b');
    world.registry = { arena: { address: OLD }, nft: { address: NFT }, token: { address: TOKEN } };
    world.oldCode = [OLD.toLowerCase()];
    vi.mocked(tx.sendWithWallet).mockImplementation(async (_send, opts) => {
      opts.onPhase?.('signing');
      const isDeploy = world.sends.length === 0;
      world.sends.push(isDeploy ? `deploy ${ARENA}` : 'call');
      if (!isDeploy && !world.tokenSet) world.tokenSet = true;
      else if (!isDeploy) world.setupLeft.shift();
      return { ok: true, hash: HASH as never, receipt: { status: 'success', contractAddress: isDeploy ? ARENA : null, logs: [] } as never };
    });
    const registered: string[] = [];
    const saved: unknown[] = [];
    const api = {
      registerContract: vi.fn(async (b: { kind: string; address: string }) => {
        registered.push(`${b.kind} ${b.address}`);
        world.registry[b.kind] = { address: b.address };
        return world.registry;
      }),
      savePins: vi.fn(async (r: { arena: string; nft: string; token: string | null }) => {
        saved.push(r);
        world.signed = { arena: r.arena, nft: r.nft, token: r.token };
        return r;
      }),
      mintRefresh: async () => ({ refreshed: true }),
    } as never;
    world.setupLeft = ['Create Room #1'];
    const net = resolveNetwork(chainStatus({ arenaAddress: OLD, nftAddress: NFT }));
    ui(<DeployFlow ctx={{ net, status: null, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: ALICE, walletChainId: 46630, client: { getCode: async () => '0x6080' } as never, api, open: vi.fn(), registry: null, signed: null }} />);
    await settle();
    expect(document.querySelector('[data-step="arena"]')?.textContent).toContain('is an older version: a new one replaces it.');
    await act(async () => {
      screen.getByTestId('deploy-flow-go').click();
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(world.sends).toEqual([`deploy ${ARENA}`, 'call', 'call']);
    expect(registered).toEqual([`arena ${ARENA}`]);
    expect(saved).toEqual([expect.objectContaining({ chainId: 46630, arena: ARENA, nft: NFT, token: TOKEN })]);
    expect(screen.getByText('Done. The contracts are live.')).toBeTruthy();
  });

  it('a game token the server does not know (a chain deployed outside the panel): Continue registers it, no wallet prompt', async () => {
    Object.assign(world, { registry: { arena: { address: ARENA }, nft: { address: NFT }, token: null }, tokenSet: true, setupLeft: [], signed: { arena: ARENA, nft: NFT, token: TOKEN } });
    const registered: unknown[] = [];
    const api = {
      registerContract: vi.fn(async (b: { kind: string; address: string; txHash: string | null }) => {
        registered.push(b);
        world.registry[b.kind] = { address: b.address };
        return world.registry;
      }),
      mintRefresh: async () => ({ refreshed: true }),
    } as never;
    const net = resolveNetwork(chainStatus({ arenaAddress: ARENA, nftAddress: NFT }));
    const ctx = { net, status: null, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: ALICE, walletChainId: 46630, client: { getCode: async () => '0x6080' } as never, api, open: vi.fn(), registry: null, signed: null };
    ui(<DeployFlow ctx={ctx} />);
    await settle();
    expect(document.querySelector('[data-step="register"]')?.getAttribute('data-state')).toBe('todo');
    expect(screen.getByTestId('deploy-flow-go').textContent).toContain('Continue');
    await act(async () => {
      screen.getByTestId('deploy-flow-go').click();
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(registered).toEqual([{ kind: 'token', address: TOKEN, txHash: null }]);
    expect(vi.mocked(tx.sendWithWallet)).not.toHaveBeenCalled();
    expect(screen.getByText('Done. The contracts are live.')).toBeTruthy();
  });

  it('a refused step stops the flow with its reason; Continue picks up from there', async () => {
    vi.mocked(tx.sendWithWallet).mockResolvedValue({ ok: false, hash: null, error: { kind: 'rejected', name: 'UserRejected', args: [], code: 4001, message: 'User rejected the request.' } } as never);
    const net = resolveNetwork(chainStatus({ arenaAddress: null, nftAddress: null }));
    ui(<DeployFlow ctx={{ net, status: null, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: ALICE, walletChainId: 46630, client: null, api: { registerContract: vi.fn() } as never, open: vi.fn(), registry: null }} />);
    await settle();
    await act(async () => {
      screen.getByTestId('deploy-flow-go').click();
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/^Deploy the test token: /);
    expect(screen.getByTestId('deploy-flow-go').textContent).toContain('Deploy the contracts');
    expect(vi.mocked(tx.sendWithWallet)).toHaveBeenCalledTimes(1);
  });

  it('another wallet than the owner: the button stays off and says which wallet', async () => {
    useWallet.setState({ status: 'connected', address: BOB });
    const net = resolveNetwork(chainStatus({ arenaAddress: null, nftAddress: null }));
    ui(<DeployFlow ctx={{ net, status: null, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: BOB, walletChainId: 46630, client: null, api: {} as never, open: vi.fn(), registry: null }} />);
    await settle();
    expect((screen.getByTestId('deploy-flow-go') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('deploy-flow-refusal').textContent).toMatch(/^Deploy from the owner wallet 0x1111…1111/);
  });
});

describe('the start screen', () => {
  const input = (over: Partial<Parameters<typeof startRows>[0]> = {}) => ({
    net: resolveNetwork(chainStatus({ arenaAddress: null, nftAddress: null })),
    status: null,
    registry: null,
    signed: null,
    access: 'admins' as const,
    accessEnv: null,
    feedback: 3,
    deployLeft: 7,
    fresh: true,
    ...over,
  });

  it('six short status lines: network, contracts, game, mint, feedback, WL and collabs', () => {
    const rows = startRows(input());
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Network', 'Robinhood Chain Testnet (46630)'],
      ['Contracts', 'Not deployed yet.'],
      ['Game', 'Closed. Only admins play.'],
      ['Mint', 'No NFT yet.'],
      ['Feedback', '3 new.'],
      ['WL & collabs', 'Sign in to see.'],
    ]);
    expect(startRows(input({ fresh: false, deployLeft: 0, access: 'public', feedback: 0 })).map((r) => r.value)).toEqual(['Robinhood Chain Testnet (46630)', 'Live and signed for the site.', 'Open to everyone.', 'No NFT yet.', 'Nothing new.', 'Sign in to see.']);
    expect(startRows(input({ feedback: undefined }))[4].value).toBe('Not on this server yet.');
    expect(startRows(input({ access: null, feedback: null })).slice(2).map((r) => r.value)).toEqual(['Sign in to see.', 'No NFT yet.', 'Sign in to see.', 'Sign in to see.']);
    const open = startRows(input({ community: { wlOpen: true, collabOpen: false, wlWaiting: 4, collabWaiting: 1 } }))[5];
    expect(open).toMatchObject({ value: 'WL open · 4 waiting. Collabs closed · 1 waiting.', tone: 'todo' });
    expect(startRows(input({ community: { wlOpen: true, collabOpen: true, wlWaiting: 0, collabWaiting: 0 } }))[5].tone).toBe('ok');
    expect(startRows(input({ net: resolveNetwork(null) }))[0].value).toBe('The game server is not answering.');
  });

  it('the big actions in order; deploy comes first while anything is left', () => {
    const a = startActions(input());
    expect(a.map((x) => x.title)).toEqual(['Deploy the contracts', 'Open or close the game', 'Mint', 'Feedback', 'WL and collab applications', 'Settings']);
    expect(a.map((x) => x.go)).toEqual(['deploy', 'open', 'minting', 'feedback', 'community', 'settings']);
    expect(a[0]).toMatchObject({ next: true, hint: 'Start here. One flow, from your wallet.' });
    const done = startActions(input({ fresh: false, deployLeft: 0 }));
    expect(done[0]).toMatchObject({ next: false, hint: 'Done.' });
    expect(done[3].next).toBe(true);
    // nothing new in feedback: the waiting WL and collab applications come next
    const wl = startActions(input({ fresh: false, deployLeft: 0, feedback: 0, community: { wlOpen: true, collabOpen: true, wlWaiting: 2, collabWaiting: 0 } }));
    expect(wl[4]).toMatchObject({ go: 'community', next: true });
  });

  it('never "Live and signed" while the faucet waits for the game token (testnet); no false alarm while the registry loads', () => {
    const net = resolveNetwork(chainStatus({ arenaAddress: ARENA, nftAddress: NFT }));
    const status = {
      block: 1n,
      chain: { id: 46630 },
      arena: { address: ARENA, code: 'ok', config: { admin: ALICE, serverAuthority: BOB, token: TOKEN, decimals: 18, burnBps: 1500, vaultBps: 500, holderNft: NFT }, token: null, arenas: [] },
      nft: { address: NFT, code: 'ok', state: { phaseName: 'public', totalSupply: 0, maxSupply: 3333 } },
      testToken: { address: TOKEN, code: 'ok', faucet: null },
    } as unknown as StatusSnapshot;
    const signed = { chainId: 46630, signedAt: '2026-11-19T10:00:00.000Z', arena: ARENA, nft: NFT, token: TOKEN } as never;
    const contracts = (registry: ContractsRegistry | null) => {
      const view = ui(<StartScreen ctx={{ net, status, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: ALICE, walletChainId: 46630, client: null, api: null, open: vi.fn(), registry, signed }} go={vi.fn()} token={null} access={null} />);
      const text = screen.getByTestId('start-status').querySelector('[data-row="contracts"]')!.textContent;
      view.unmount();
      return text;
    };
    expect(contracts({ arena: { address: ARENA }, nft: { address: NFT }, token: null } as never)).toMatch(/1 deploy step left\.$/);
    expect(contracts({ arena: { address: ARENA }, nft: { address: NFT }, token: { address: TOKEN } } as never)).toMatch(/Live and signed for the site\.$/);
    expect(contracts(null)).toMatch(/Live and signed for the site\.$/);
  });

  it('renders the lines and the actions; each action opens its page (Feedback: the feedback drawer)', async () => {
    const go = vi.fn();
    const net = resolveNetwork(chainStatus({ arenaAddress: null, nftAddress: null }));
    ui(<StartScreen ctx={{ net, status: null, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: ALICE, walletChainId: 46630, client: null, api: null, open: vi.fn() }} go={go} token={null} access={null} />);
    expect(within(screen.getByTestId('start-status')).getAllByRole('definition')).toHaveLength(6);
    const buttons = within(screen.getByTestId('start-actions')).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('data-go'))).toEqual(['deploy', 'open', 'minting', 'feedback', 'community', 'settings']);
    act(() => buttons[4].click());
    expect(go).toHaveBeenLastCalledWith('community');
    act(() => buttons[3].click());
    expect(go).toHaveBeenLastCalledWith('feedback');
    act(() => buttons[0].click());
    expect(go).toHaveBeenLastCalledWith('deploy');
  });
});
