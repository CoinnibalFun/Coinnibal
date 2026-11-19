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
}));

vi.mock('../src/site/api', async (orig) => {
  const real = await orig<typeof import('../src/site/api')>();
  return { ...real, site: { ...real.site, contracts: async () => structuredClone(world.registry) } };
});
vi.mock('@coinnibal/sdk/ops', async (orig) => {
  const real = await orig<typeof import('@coinnibal/sdk/ops')>();
  return {
    ...real,
    checkDeployedCode: async () => 'ok',
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
const { DeployFlow, flowRefusal } = await import('../src/admin/DeployFlow');
const { deployFlowSteps, flowAsksLeft, nextFlowStep } = await import('../src/admin/flow');
const { startActions, startRows, StartScreen } = await import('../src/admin/Start');
const { resolveNetwork } = await import('../src/admin/net');
const { Kb } = await import('../src/design');
const { resetWallets, useWallet } = await import('../src/wallet/store');

const ui = (node: ReactElement) => render(<Kb>{node}</Kb>);
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeEach(() => {
  localStorage.clear();
  Object.assign(world, { registry: { arena: null, nft: null, token: null }, tokenSet: false, setupLeft: [], signed: null, sends: [] });
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

  it('five short status lines: network, contracts, game, mint, feedback', () => {
    const rows = startRows(input());
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Network', 'Robinhood Chain Testnet (46630)'],
      ['Contracts', 'Not deployed yet.'],
      ['Game', 'Closed. Only admins play.'],
      ['Mint', 'No NFT yet.'],
      ['Feedback', '3 new.'],
    ]);
    expect(startRows(input({ fresh: false, deployLeft: 0, access: 'public', feedback: 0 })).map((r) => r.value)).toEqual(['Robinhood Chain Testnet (46630)', 'Live and signed for the site.', 'Open to everyone.', 'No NFT yet.', 'Nothing new.']);
    expect(startRows(input({ feedback: undefined }))[4].value).toBe('Not on this server yet.');
    expect(startRows(input({ access: null, feedback: null })).slice(2).map((r) => r.value)).toEqual(['Sign in to see.', 'No NFT yet.', 'Sign in to see.']);
    expect(startRows(input({ net: resolveNetwork(null) }))[0].value).toBe('The game server is not answering.');
  });

  it('the big actions in order; deploy comes first while anything is left', () => {
    const a = startActions(input());
    expect(a.map((x) => x.title)).toEqual(['Deploy the contracts', 'Open or close the game', 'Mint', 'Feedback', 'Settings']);
    expect(a.map((x) => x.go)).toEqual(['deploy', 'open', 'minting', 'feedback', 'settings']);
    expect(a[0]).toMatchObject({ next: true, hint: 'Start here. One flow, from your wallet.' });
    const done = startActions(input({ fresh: false, deployLeft: 0 }));
    expect(done[0]).toMatchObject({ next: false, hint: 'Done.' });
    expect(done[3].next).toBe(true);
  });

  it('renders the lines and the actions; each action opens its page (Feedback: the feedback drawer)', async () => {
    const go = vi.fn();
    const net = resolveNetwork(chainStatus({ arenaAddress: null, nftAddress: null }));
    ui(<StartScreen ctx={{ net, status: null, refresh: vi.fn(async () => {}), reloadNet: vi.fn(async () => {}), me: ALICE, walletChainId: 46630, client: null, api: null, open: vi.fn() }} go={go} token={null} access={null} />);
    expect(within(screen.getByTestId('start-status')).getAllByRole('definition')).toHaveLength(5);
    const buttons = within(screen.getByTestId('start-actions')).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('data-go'))).toEqual(['deploy', 'open', 'minting', 'feedback', 'settings']);
    act(() => buttons[3].click());
    expect(go).toHaveBeenLastCalledWith('feedback');
    act(() => buttons[0].click());
    expect(go).toHaveBeenLastCalledWith('deploy');
  });
});
